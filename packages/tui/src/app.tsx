import type {
  Agent,
  CreatedSession,
  MemoryCandidate,
  MemoryScope,
  PermissionMode,
  PermissionRequest,
  PromptChoice,
  TodoItem,
} from '@earshot/core';
import {
  deleteMemory,
  detectPreference,
  expandCommand,
  isPermissionMode,
  loadMemories,
  PERMISSION_MODES,
  refreshSystemPrompt,
  saveMemory,
} from '@earshot/core';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryCapture } from './components/memory-capture.tsx';
import { PermissionPrompt } from './components/permission.tsx';
import { QuestionPrompt } from './components/question.tsx';
import { StatusLine } from './components/status.tsx';
import { TextInput } from './components/text-input.tsx';
import { ToolBlock } from './components/tool-block.tsx';
import { theme } from './theme.ts';

/**
 * A finished piece of scrollback.
 *
 * Once an item is here it never changes, which is the contract `Static` needs:
 * Ink writes those rows to the terminal once and then leaves them alone, so they
 * become real scrollback the user can select and scroll with their own terminal.
 * Only the live region below is re-rendered, which is what keeps a long session
 * from repainting thousands of rows on every token.
 */
export type ScrollItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; title?: string; output?: string; isError?: boolean }
  | { kind: 'notice'; id: string; text: string; color?: string };

export interface AppProps {
  session: CreatedSession;
  model: string;
  /** Run immediately on start, for `earshot "do the thing"`. */
  initialPrompt?: string;
}

let sequence = 0;
const nextId = () => `item_${sequence++}`;

export function App({ session, model, initialPrompt }: AppProps) {
  const { exit } = useApp();
  const agent: Agent = session.agent;

  const [items, setItems] = useState<ScrollItem[]>(() =>
    session.problems.map((problem) => ({
      kind: 'notice' as const,
      id: nextId(),
      text: `warning: ${problem}`,
      color: theme.warning,
    })),
  );
  const [live, setLive] = useState('');
  const [runningTool, setRunningTool] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(agent.permissionMode);
  const [cost, setCost] = useState(0);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [queued, setQueued] = useState(0);
  const [candidate, setCandidate] = useState<MemoryCandidate | undefined>();
  const [context, setContext] = useState(() => agent.contextUse);
  const [compacted, setCompacted] = useState(0);

  const [pending, setPending] = useState<
    | { request: PermissionRequest; reason: string; resolve: (choice: PromptChoice) => void }
    | undefined
  >();
  const [question, setQuestion] = useState<
    { question: string; options?: string[]; resolve: (answer: string) => void } | undefined
  >();

  const controller = useRef<AbortController | undefined>(undefined);
  const push = useCallback((item: ScrollItem) => setItems((current) => [...current, item]), []);

  // The prompt and ask callbacks are installed once and read through refs, so a
  // re-render never leaves the agent holding a stale closure over old state.
  const pendingRef = useRef(setPending);
  pendingRef.current = setPending;
  const questionRef = useRef(setQuestion);
  questionRef.current = setQuestion;

  useEffect(() => {
    session.installPrompt(
      (request, reason) =>
        new Promise<PromptChoice>((resolve) => {
          pendingRef.current({ request, reason, resolve });
        }),
    );
    session.installAsk(
      (q, options) =>
        new Promise<string>((resolve) => {
          questionRef.current({ question: q, ...(options ? { options } : {}), resolve });
        }),
    );
  }, [session]);

  const runTurn = useCallback(
    async (prompt: string) => {
      setBusy(true);
      push({ kind: 'user', id: nextId(), text: prompt });

      const abort = new AbortController();
      controller.current = abort;
      let assistantText = '';

      try {
        for await (const event of agent.runTurn(prompt, abort.signal)) {
          switch (event.type) {
            case 'text_delta':
              assistantText += event.text;
              setLive(assistantText);
              break;
            case 'tool_start':
              // The assistant's prose is flushed to scrollback before the tool
              // block, so the two never re-order once the tool finishes.
              if (assistantText.trim() !== '') {
                push({ kind: 'assistant', id: nextId(), text: assistantText.trimEnd() });
                assistantText = '';
                setLive('');
              }
              setRunningTool(event.call.toolName);
              break;
            case 'tool_end': {
              setRunningTool(undefined);
              const output = event.result.output.type === 'text' ? event.result.output.value : '';
              push({
                kind: 'tool',
                id: nextId(),
                name: event.toolName,
                ...(event.result.title ? { title: event.result.title } : {}),
                output,
                ...(event.result.isError ? { isError: true } : {}),
              });
              setTodos(agent.todos.list());
              break;
            }
            case 'usage':
              setCost(agent.costUsd);
              setContext(agent.contextUse);
              break;
            case 'verification':
              // Shown to the user as it was shown to the model: the command, the
              // exit code and the output, none of it summarised.
              push({
                kind: 'tool',
                id: nextId(),
                name: event.result.command,
                title: `${event.result.command} - exit ${event.result.exitCode ?? 'killed'}`,
                output: event.result.output,
                ...(event.result.exitCode === 0 ? {} : { isError: true }),
              });
              break;
            case 'subagent':
              push({
                kind: 'notice',
                id: nextId(),
                text: `subagent "${event.description}": ${event.steps} step${
                  event.steps === 1 ? '' : 's'
                }, $${event.costUsd.toFixed(4)}`,
              });
              break;
            case 'hook':
              // A hook that blocked something is the reason the agent did not do
              // it, so it is said out loud rather than left for the model to
              // paraphrase. Problems are shown too: a hook that failed silently
              // is one the user goes on believing is protecting them.
              if (event.blocked) {
                push({
                  kind: 'notice',
                  id: nextId(),
                  text: `${event.event} hook blocked this: ${event.blocked}`,
                  color: theme.warning,
                });
              }
              for (const problem of event.problems) {
                push({ kind: 'notice', id: nextId(), text: problem, color: theme.warning });
              }
              break;
            case 'compacted':
              setCompacted((count) => count + event.replaced);
              push({
                kind: 'notice',
                id: nextId(),
                text: `compacted: ${event.replaced} earlier messages are now a summary`,
              });
              break;
            case 'error':
              push({
                kind: 'notice',
                id: nextId(),
                text: `error: ${event.error.message}`,
                color: theme.danger,
              });
              break;
            case 'turn_end':
              if (event.reason === 'aborted') {
                push({
                  kind: 'notice',
                  id: nextId(),
                  text: 'interrupted',
                  color: theme.warning,
                });
              }
              if (event.reason === 'max_steps') {
                push({
                  kind: 'notice',
                  id: nextId(),
                  text: 'stopped: step limit reached',
                  color: theme.warning,
                });
              }
              break;
            default:
              break;
          }
          setQueued(agent.pendingSteers);
        }
      } finally {
        if (assistantText.trim() !== '') {
          push({ kind: 'assistant', id: nextId(), text: assistantText.trimEnd() });
        }
        setLive('');
        setRunningTool(undefined);
        setBusy(false);
        setQueued(agent.pendingSteers);
        controller.current = undefined;
      }
    },
    [agent, push],
  );

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !initialPrompt) return;
    started.current = true;
    void runTurn(initialPrompt);
  }, [initialPrompt, runTurn]);

  /**
   * Lists what is remembered, with the sentence each rule came from. Memory the
   * user cannot inspect is memory they cannot trust, so provenance is shown
   * here rather than hidden in the file.
   */
  const showMemories = useCallback(
    async (argument?: string) => {
      const [verb, ...rest] = (argument ?? '').split(/\s+/);
      const id = rest.join(' ').trim();
      if (verb === 'forget' && id) {
        const gone = await deleteMemory(id, agent.cwd);
        if (gone) await refreshSystemPrompt(agent, model, session.skills);
        push({
          kind: 'notice',
          id: nextId(),
          text: gone ? `forgot ${id}` : `no memory called "${id}"`,
          ...(gone ? {} : { color: theme.warning }),
        });
        return;
      }

      const memories = await loadMemories(agent.cwd);
      if (memories.length === 0) {
        push({ kind: 'notice', id: nextId(), text: 'nothing remembered yet' });
        return;
      }
      const lines = memories.map((memory) => {
        const when = memory.created.slice(0, 10);
        const why = memory.source ? `\n     from "${memory.source}" on ${when}` : '';
        return `  [${memory.id}] (${memory.scope}) ${memory.text}${why}`;
      });
      push({
        kind: 'notice',
        id: nextId(),
        text: `${lines.join('\n')}\n\n  /memory forget <id> removes one`,
      });
    },
    [agent, model, push, session.skills],
  );

  const remember = useCallback(
    async (scope: MemoryScope) => {
      if (!candidate) return;
      setCandidate(undefined);
      const saved = await saveMemory({ ...candidate, scope }, agent.cwd).catch(() => undefined);
      if (!saved) {
        push({ kind: 'notice', id: nextId(), text: 'could not save that', color: theme.warning });
        return;
      }
      // Applied from the next model call, not the next session.
      await refreshSystemPrompt(agent, model, session.skills);
      push({
        kind: 'notice',
        id: nextId(),
        text: `remembered [${saved.id}] (${scope}) - /memory to review or forget it`,
      });
    },
    [agent, candidate, model, push, session.skills],
  );

  /**
   * `/tree`, `/rewind`, `/fork` and `/undo`.
   *
   * The numbering is over the user's own prompts rather than over every entry:
   * "go back to before I asked for the refactor" is how people think about a
   * session, and an entry id is not something anyone can pick out of a list.
   */
  const sessionTree = useCallback(
    async (name: string, argument?: string) => {
      const entries = await session.branch();
      const prompts = entries.filter(
        (entry) =>
          entry.type === 'message' &&
          entry.message.role === 'user' &&
          entry.message.content.some(
            (part) => part.type === 'text' && !part.text.startsWith('<self-check>'),
          ),
      );

      if (name === 'tree' || !argument) {
        if (prompts.length === 0) {
          push({ kind: 'notice', id: nextId(), text: 'nothing in this session yet' });
          return;
        }
        const lines = prompts.map((entry, index) => {
          const text =
            entry.type === 'message'
              ? (entry.message.content.find((part) => part.type === 'text')?.text ?? '')
              : '';
          return `  ${index + 1}. ${text.split('\n')[0]?.slice(0, 70) ?? ''}`;
        });
        push({
          kind: 'notice',
          id: nextId(),
          text: `${lines.join('\n')}\n\n  /rewind <n> goes back to one · /fork <n> branches from it`,
        });
        return;
      }

      const index = Number.parseInt(argument, 10) - 1;
      const target = prompts[index];
      if (!target) {
        push({
          kind: 'notice',
          id: nextId(),
          text: `no prompt ${argument} in this session - /tree lists them`,
          color: theme.warning,
        });
        return;
      }
      // The entry before the chosen prompt: rewinding "to" a prompt means the
      // state the session was in when it was typed, not after it ran.
      const previous = entries[entries.indexOf(target) - 1] ?? target;

      if (name === 'rewind') {
        const kept = await session.rewindTo(previous.id);
        push({
          kind: 'notice',
          id: nextId(),
          text: `rewound to before prompt ${index + 1}; ${kept} message${kept === 1 ? '' : 's'} kept. Nothing was deleted - the rest is still in the transcript as another branch.`,
        });
        return;
      }

      const forked = await session.fork(previous.id);
      push({
        kind: 'notice',
        id: nextId(),
        text: forked
          ? `forked from prompt ${index + 1} into ${forked}; this session continues there and the original is untouched`
          : 'could not fork this session',
        ...(forked ? {} : { color: theme.warning }),
      });
    },
    [push, session],
  );

  const undoLast = useCallback(async () => {
    const result = await session.undo();
    if (!result) {
      push({ kind: 'notice', id: nextId(), text: 'nothing to undo', color: theme.warning });
      return;
    }
    const created = result.wasCreated.length
      ? ` Left in place because the batch created them: ${result.wasCreated.join(', ')}.`
      : '';
    push({
      kind: 'notice',
      id: nextId(),
      text: result.restored.length
        ? `undid ${result.label}: restored ${result.restored.join(', ')}.${created}`
        : `nothing to restore from ${result.label}.${created}`,
    });
  }, [push, session]);

  const handleCommand = useCallback(
    (command: string) => {
      // Split once, keeping the remainder: `split(/\s+/, 2)` discards everything
      // after the second field, which silently drops the argument of any command
      // that takes more than one word.
      const body = command.slice(1).trim();
      const space = body.search(/\s/);
      const name = space === -1 ? body : body.slice(0, space);
      const argument = space === -1 ? undefined : body.slice(space + 1).trim();

      if (name === 'exit' || name === 'quit') {
        exit();
        return;
      }
      if (name === 'mode') {
        if (argument && isPermissionMode(argument)) {
          agent.setPermissionMode(argument);
          setMode(argument);
          push({ kind: 'notice', id: nextId(), text: `permission mode: ${argument}` });
        } else {
          push({
            kind: 'notice',
            id: nextId(),
            text: `usage: /mode <${PERMISSION_MODES.join('|')}>`,
            color: theme.warning,
          });
        }
        return;
      }
      if (name === 'memory') {
        void showMemories(argument);
        return;
      }
      if (name === 'tree' || name === 'rewind' || name === 'fork') {
        if (busy) {
          push({
            kind: 'notice',
            id: nextId(),
            text: 'finish or interrupt the current turn first (esc)',
            color: theme.warning,
          });
          return;
        }
        void sessionTree(name, argument);
        return;
      }
      if (name === 'undo') {
        void undoLast();
        return;
      }
      if (name === 'skills') {
        push({
          kind: 'notice',
          id: nextId(),
          text: describeExtensions(session),
        });
        return;
      }

      // A user-defined command is expanded into a prompt and run as one. It is
      // not a second way to reach the tools: whatever the file asks for goes
      // through the same turn, and the same gate, as anything typed by hand.
      const custom = session.commands.find((entry) => entry.name === name);
      if (custom) {
        const prompt = expandCommand(custom, argument ?? '');
        if (prompt.trim() === '') {
          push({
            kind: 'notice',
            id: nextId(),
            text: `/${name} expanded to nothing`,
            color: theme.warning,
          });
          return;
        }
        if (busy) {
          agent.steer(prompt);
          setQueued(agent.pendingSteers);
          push({ kind: 'user', id: nextId(), text: command });
          return;
        }
        void runTurn(prompt);
        return;
      }

      push({
        kind: 'notice',
        id: nextId(),
        text: `unknown command "${name}"`,
        color: theme.warning,
      });
    },
    [agent, busy, exit, push, runTurn, session, sessionTree, showMemories, undoLast],
  );

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      setInput('');
      if (trimmed === '') return;

      if (trimmed.startsWith('/')) {
        handleCommand(trimmed);
        return;
      }
      // Offered, never stored: a wrong rule saved silently would follow the user
      // into every future session with no sign of where it came from.
      setCandidate(detectPreference(trimmed));
      if (busy) {
        // Steering, not queueing a second turn: the agent injects it at the next
        // model call so the user redirects without losing work in flight.
        agent.steer(trimmed);
        setQueued(agent.pendingSteers);
        push({ kind: 'user', id: nextId(), text: trimmed });
        return;
      }
      void runTurn(trimmed);
    },
    [agent, busy, push, runTurn, handleCommand],
  );

  // Input is disabled while a prompt is open so the two do not both consume keys.
  const inputActive = !pending && !question;

  useInput(
    (input_, key) => {
      if (key.escape) {
        setCandidate(undefined);
        if (busy) controller.current?.abort();
        return;
      }
      // Bound rather than modal: taking the offer must not stop the user typing.
      if (key.ctrl && candidate && (input_ === 'r' || input_ === 'g')) {
        void remember(input_ === 'r' ? 'project' : 'user');
      }
    },
    { isActive: inputActive },
  );

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ScrollRow key={item.id} item={item} />}</Static>

      {live !== '' && (
        <Box marginTop={1}>
          <Text color={theme.assistant}>{live}</Text>
        </Box>
      )}
      {runningTool && <ToolBlock name={runningTool} running />}

      {pending && (
        <PermissionPrompt
          request={pending.request}
          reason={pending.reason}
          onChoice={(choice) => {
            setPending(undefined);
            pending.resolve(choice);
          }}
        />
      )}

      {question && (
        <QuestionPrompt
          question={question.question}
          {...(question.options ? { options: question.options } : {})}
          onAnswer={(answer) => {
            setQuestion(undefined);
            question.resolve(answer);
          }}
        />
      )}

      {candidate && inputActive && <MemoryCapture candidate={candidate} />}

      {inputActive && (
        <Box marginTop={1}>
          <Text color={theme.user}>{'> '}</Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={submit}
            placeholder={busy ? 'steer the agent, or esc to interrupt' : 'what should I do?'}
          />
        </Box>
      )}

      <StatusLine
        model={model}
        mode={mode}
        costUsd={cost}
        todos={todos}
        busy={busy}
        queued={queued}
        context={context}
        compacted={compacted}
      />
    </Box>
  );
}

function ScrollRow({ item }: { item: ScrollItem }) {
  if (item.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color={theme.user}>{'> '}</Text>
        <Text>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <Box marginTop={1}>
        <Text color={theme.assistant}>{item.text}</Text>
      </Box>
    );
  }
  if (item.kind === 'tool') {
    return (
      <ToolBlock
        name={item.name}
        {...(item.title ? { title: item.title } : {})}
        {...(item.output ? { output: item.output } : {})}
        {...(item.isError ? { isError: true } : {})}
      />
    );
  }
  return (
    <Box marginTop={1}>
      <Text color={item.color ?? theme.muted}>{item.text}</Text>
    </Box>
  );
}

/**
 * What `/skills` shows. Skills and commands are listed together because from the
 * user's side they are the same question - what extra behaviour is loaded in
 * this directory, and where did it come from.
 */
function describeExtensions(session: CreatedSession): string {
  const lines: string[] = [];
  if (session.skills.length > 0) {
    lines.push('skills (the agent loads these itself when they fit):');
    for (const skill of session.skills) {
      lines.push(`  ${skill.name}  [${skill.scope}]  ${skill.description}`);
    }
  }
  if (session.commands.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('commands you can type:');
    for (const command of session.commands) {
      lines.push(`  /${command.name}  [${command.scope}]  ${command.description}`);
    }
  }
  return lines.length === 0
    ? 'no skills or commands found in .earshot/skills, .earshot/commands or your config directory'
    : lines.join('\n');
}
