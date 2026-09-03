import type {
  Agent,
  CreatedSession,
  PermissionMode,
  PermissionRequest,
  PromptChoice,
  TodoItem,
} from '@earshot/core';
import { isPermissionMode, PERMISSION_MODES } from '@earshot/core';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
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

  const handleCommand = useCallback(
    (command: string) => {
      const [name, argument] = command.slice(1).split(/\s+/, 2);

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
      push({
        kind: 'notice',
        id: nextId(),
        text: `unknown command "${name}"`,
        color: theme.warning,
      });
    },
    [agent, exit, push],
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
    (_, key) => {
      if (key.escape && busy) controller.current?.abort();
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
