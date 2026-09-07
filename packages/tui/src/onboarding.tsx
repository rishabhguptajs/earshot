import type { ReasoningEffort } from '@earshot/providers';
import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { TextInput } from './components/text-input.tsx';
import { theme } from './theme.ts';

/**
 * First-run onboarding.
 *
 * What this module is *not* allowed to do, because it is the one screen that
 * handles a secret:
 *
 *   - It never writes a credential itself. `store` is the caller's, and the CLI
 *     points it at the same `AuthStore` `earshot auth login` uses - a second
 *     write path would be a second set of file permissions to get wrong.
 *   - It never renders, logs or returns a key. What the user types is held in a
 *     ref, drawn as bullets, and handed to `store`.
 *   - It never runs without a TTY. The caller checks, because a headless run
 *     with no credentials must fail fast rather than block on a prompt nobody
 *     can answer.
 *
 * It also knows nothing about the provider registry: everything it needs is
 * passed in, which is what keeps the TUI free of provider-specific code and
 * lets the tests drive the whole flow without a network.
 */

export interface OnboardingProvider {
  readonly id: string;
  readonly models: readonly OnboardingModel[];
  /** How credentials are given: a browser sign-in, or a key. */
  readonly kind: 'oauth' | 'api-key';
  /** Environment variable(s) that would also work, for the hint line. */
  readonly envVars?: readonly string[];
  /** Already configured elsewhere - an env var, or ambient credentials. */
  readonly configured?: string;
}

export interface OnboardingModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning?: boolean;
}

/** Why a probe failed, which is the only thing that decides the next screen. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: 'rejected'; message: string }
  | { ok: false; reason: 'unreachable'; message: string }
  | { ok: false; reason: 'other'; message: string };

export interface OnboardingOptions {
  providers: readonly OnboardingProvider[];
  /** The provider the requested model needs, listed first when it is known. */
  wanted?: string;
  /** The requested model, selected by default when the chosen provider offers it. */
  wantedModel?: string;
  /** Stores an api key. The caller's `AuthStore`, never a second one. */
  storeKey(providerId: string, key: string): Promise<void>;
  /** Removes what was stored, so a rejected key is not left to fail again. */
  forgetKey(providerId: string): Promise<void>;
  /** The existing PKCE flow. `onUrl` is shown as well as opened: over SSH there is no browser. */
  signIn(providerId: string, onUrl: (url: string) => void): Promise<void>;
  /** One minimal live call. The only thing that proves a credential works. */
  probe(providerId: string, modelId: string): Promise<ProbeResult>;
  reasoningFor?(model: string): ReasoningEffort | undefined;
  remember?(
    model: string,
    effort: ReasoningEffort | undefined,
    scope: 'global' | 'project',
  ): Promise<void>;
}

export interface OnboardingResult {
  /** `ready` means credentials are stored and verified. */
  outcome: 'ready' | 'quit';
  providerId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  scope?: 'global' | 'project';
}

type Screen =
  | { name: 'choose' }
  | { name: 'model'; provider: OnboardingProvider }
  | { name: 'key'; provider: OnboardingProvider; model: OnboardingModel }
  | { name: 'oauth'; provider: OnboardingProvider; model: OnboardingModel; url?: string }
  | { name: 'probing'; provider: OnboardingProvider; model: OnboardingModel }
  | { name: 'effort'; provider: OnboardingProvider; model: OnboardingModel }
  | {
      name: 'failed';
      provider: OnboardingProvider;
      model: OnboardingModel;
      result: Extract<ProbeResult, { ok: false }>;
    };

export interface OnboardingProps extends OnboardingOptions {
  onDone: (result: OnboardingResult) => void;
  embedded?: boolean;
  defaultScope?: 'global' | 'project';
}

const EFFORTS = ['auto', 'none', 'low', 'medium', 'high', 'xhigh'] as const;

export function Onboarding({
  onDone,
  embedded = false,
  defaultScope = 'global',
  ...rest
}: OnboardingProps) {
  const { exit } = useApp();
  // The props object is rebuilt every render (it is a spread), so the
  // callbacks it carries would otherwise force every effect that uses them to
  // be re-declared - and re-lint - on every keystroke. A ref holds the latest
  // without becoming a dependency.
  const options = useRef(rest);
  options.current = rest;
  const [screen, setScreen] = useState<Screen>({ name: 'choose' });
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();

  /**
   * The typed key lives here and never in state.
   *
   * State is rendered; a re-render that put the value on screen - or an error
   * message built from it - would print the secret into the user's scrollback,
   * where it would outlive the process.
   */
  const secret = useRef('');

  const providers = order(rest.providers, rest.wanted);

  const finish = useCallback(
    (result: OnboardingResult) => {
      onDone(result);
      if (!embedded) exit();
    },
    [embedded, exit, onDone],
  );

  const complete = useCallback(
    (
      provider: OnboardingProvider,
      model: OnboardingModel,
      scope = defaultScope,
      effort?: ReasoningEffort,
    ) =>
      finish({
        outcome: 'ready',
        providerId: provider.id,
        model: `${provider.id}/${model.id}`,
        scope,
        ...(effort ? { reasoningEffort: effort } : {}),
      }),
    [defaultScope, finish],
  );

  const readyForEffort = useCallback(
    (provider: OnboardingProvider, model: OnboardingModel) => {
      const remembered = options.current.reasoningFor?.(`${provider.id}/${model.id}`);
      setCursor(remembered ? Math.max(0, EFFORTS.indexOf(remembered)) : 0);
      if (model.reasoning) setScreen({ name: 'effort', provider, model });
      else complete(provider, model);
    },
    [complete],
  );

  const verify = useCallback(
    async (provider: OnboardingProvider, model: OnboardingModel) => {
      setScreen({ name: 'probing', provider, model });
      const result = await options.current.probe(provider.id, model.id);
      if (result.ok) {
        readyForEffort(provider, model);
        return;
      }
      // A key the provider refused is worse than no key: it fails again on every
      // future launch, from a file the user has no reason to look in.
      if (result.reason === 'rejected')
        await options.current.forgetKey(provider.id).catch(() => {});
      setScreen({ name: 'failed', provider, model, result });
    },
    [readyForEffort],
  );

  const submitKey = useCallback(async () => {
    const selected = screen.name === 'key' ? screen : undefined;
    const key = secret.current;
    secret.current = '';
    setInput('');
    if (!selected) return;
    if (key.trim() === '') {
      setError('a key is needed, or press esc to go back');
      return;
    }
    setError(undefined);
    await options.current.storeKey(selected.provider.id, key.trim());
    await verify(selected.provider, selected.model);
  }, [screen, verify]);

  const startSignIn = useCallback(
    async (provider: OnboardingProvider, model: OnboardingModel) => {
      setScreen({ name: 'oauth', provider, model });
      try {
        await options.current.signIn(provider.id, (url) =>
          setScreen({ name: 'oauth', provider, model, url }),
        );
      } catch (failure) {
        setScreen({
          name: 'failed',
          provider,
          model,
          result: { ok: false, reason: 'other', message: (failure as Error).message },
        });
        return;
      }
      await verify(provider, model);
    },
    [verify],
  );

  const chooseModel = useCallback(
    (provider: OnboardingProvider, model: OnboardingModel) => {
      setInput('');
      setError(undefined);
      if (provider.configured) readyForEffort(provider, model);
      else if (provider.kind === 'oauth') void startSignIn(provider, model);
      else setScreen({ name: 'key', provider, model });
    },
    [readyForEffort, startSignIn],
  );

  const chooseProvider = useCallback(
    (provider: OnboardingProvider) => {
      setInput('');
      setError(undefined);
      setCursor(preferredModelIndex(provider.models, rest.wantedModel));
      setScreen({ name: 'model', provider });
    },
    [rest.wantedModel],
  );

  useInput((key, meta) => {
    if (meta.ctrl && key === 'c') {
      finish({ outcome: 'quit' });
      return;
    }
    if (screen.name === 'choose') {
      if (key === 'q') {
        finish({ outcome: 'quit' });
        return;
      }
      if (meta.upArrow) setCursor((c) => (c <= 0 ? providers.length - 1 : c - 1));
      if (meta.downArrow) setCursor((c) => (c >= providers.length - 1 ? 0 : c + 1));
      if (meta.return) {
        const provider = providers[cursor];
        if (provider) chooseProvider(provider);
      }
      return;
    }
    if (screen.name === 'model') {
      if (meta.escape) {
        setInput('');
        setError(undefined);
        setCursor(0);
        setScreen({ name: 'choose' });
        return;
      }
      const matches = matchingModels(screen.provider.models, input);
      if (embedded && meta.ctrl && key === 'g') {
        const selected = matches[cursor];
        if (selected) {
          if (selected.reasoning) {
            setCursor(0);
            setScreen({ name: 'effort', provider: screen.provider, model: selected });
          } else complete(screen.provider, selected, 'global');
        }
        return;
      }
      if (meta.upArrow) setCursor((c) => (c <= 0 ? Math.max(0, matches.length - 1) : c - 1));
      if (meta.downArrow) setCursor((c) => (c >= matches.length - 1 ? 0 : c + 1));
      return;
    }
    if (screen.name === 'effort') {
      if (meta.escape) {
        setCursor(preferredModelIndex(screen.provider.models, rest.wantedModel));
        setScreen({ name: 'model', provider: screen.provider });
        return;
      }
      if (meta.upArrow) setCursor((c) => (c <= 0 ? EFFORTS.length - 1 : c - 1));
      if (meta.downArrow) setCursor((c) => (c >= EFFORTS.length - 1 ? 0 : c + 1));
      const selected = EFFORTS[cursor] ?? 'auto';
      if (meta.return || (embedded && key === 'g')) {
        complete(
          screen.provider,
          screen.model,
          embedded && key === 'g' ? 'global' : defaultScope,
          selected === 'auto' ? undefined : selected,
        );
      }
      return;
    }
    if (screen.name === 'key' && !meta.escape) {
      // Typed here rather than through TextInput, which renders the value it is
      // given: a masked field has to keep the value out of the render entirely.
      if (meta.return) {
        void submitKey();
        return;
      }
      if (meta.backspace || meta.delete) {
        secret.current = secret.current.slice(0, -1);
        setInput(secret.current);
        return;
      }
      if (meta.ctrl || meta.meta || meta.tab) return;
      if (key) {
        secret.current += key;
        setInput(secret.current);
      }
      return;
    }
    if (meta.escape) {
      secret.current = '';
      setInput('');
      setError(undefined);
      setScreen(
        screen.name === 'key' || screen.name === 'oauth' || screen.name === 'failed'
          ? { name: 'model', provider: screen.provider }
          : { name: 'choose' },
      );
      return;
    }
    if (screen.name === 'failed' && key === 'k' && screen.result.reason === 'unreachable') {
      // Keeping an unverified key is allowed on purpose: a network that cannot
      // be reached must not be able to lock someone out of their own setup.
      readyForEffort(screen.provider, screen.model);
    }
  });

  if (screen.name === 'choose') {
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        {providers.map((provider, index) => (
          <Box key={provider.id}>
            <Text color={index === cursor ? theme.user : theme.muted}>
              {index === cursor ? '› ' : '  '}
            </Text>
            {/* An absent prop, not `undefined`: exactOptionalPropertyTypes. */}
            <Text {...(index === cursor ? { color: theme.user } : {})}>
              {provider.id.padEnd(14)}
            </Text>
            <Text color={theme.muted}>{hint(provider)}</Text>
          </Box>
        ))}
        <Box marginTop={1}>
          <Text color={theme.muted}>↑↓ choose · enter select · q quit</Text>
        </Box>
        {error ? <Text color={theme.warning}>{error}</Text> : null}
      </Box>
    );
  }

  if (screen.name === 'model') {
    const matches = matchingModels(screen.provider.models, input);
    const selected = matches[cursor];
    const start = Math.max(0, Math.min(cursor - 3, matches.length - 8));
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text>
          choose a model from {screen.provider.id} ({matches.length} matching)
        </Text>
        <Box>
          <Text color={theme.user}>{'> '}</Text>
          <TextInput
            value={input}
            onChange={(value) => {
              setInput(value);
              setCursor(0);
              setError(undefined);
            }}
            onSubmit={() => {
              if (selected) chooseModel(screen.provider, selected);
              else setError('no model matches that search');
            }}
            placeholder="type to filter models"
          />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {matches.slice(start, start + 8).map((model) => (
            <Text key={model.id} color={model === selected ? theme.user : theme.muted}>
              {model === selected ? '› ' : '  '}
              {model.id} · {model.name}
            </Text>
          ))}
          {matches.length === 0 ? <Text color={theme.muted}>no matching models</Text> : null}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>type filter · ↑↓ choose · enter select · esc back</Text>
        </Box>
        {error ? <Text color={theme.warning}>{error}</Text> : null}
      </Box>
    );
  }

  if (screen.name === 'key') {
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text>paste an api key for {screen.provider.id}</Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {screen.provider.envVars?.length
              ? `or set ${screen.provider.envVars.join(' or ')} instead and restart.\n`
              : ''}
            stored in your config directory, readable only by you, and never printed.
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.user}>{'> '}</Text>
          {/* Bullets, not the key: the value is in a ref and never rendered. */}
          <Text>{'•'.repeat(input.length)}</Text>
          <Text inverse> </Text>
        </Box>
        {error ? <Text color={theme.warning}>{error}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.muted}>enter continue · esc back</Text>
        </Box>
      </Box>
    );
  }

  if (screen.name === 'oauth') {
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text>signing in to {screen.provider.id} in your browser…</Text>
        {screen.url ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.muted}>if it did not open, use this link:</Text>
            <Text>{screen.url}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text color={theme.muted}>esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (screen.name === 'probing') {
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text color={theme.muted}>checking the credentials with {screen.provider.id}…</Text>
      </Box>
    );
  }

  if (screen.name === 'failed') {
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text color={theme.warning}>
          {screen.result.reason === 'rejected'
            ? `${screen.provider.id} rejected that credential. It has not been kept.`
            : screen.result.reason === 'unreachable'
              ? `could not reach ${screen.provider.id}.`
              : `${screen.provider.id} said:`}
        </Text>
        <Text color={theme.muted}>{screen.result.message}</Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {screen.result.reason === 'unreachable'
              ? 'k keep it anyway and carry on · esc start over · ctrl-c quit'
              : 'esc start over · ctrl-c quit'}
          </Text>
        </Box>
      </Box>
    );
  }

  if (screen.name === 'effort')
    return (
      <Box flexDirection="column">
        <Header embedded={embedded} />
        <Text>reasoning effort for {screen.model.name}</Text>
        <Box flexDirection="column" marginTop={1}>
          {EFFORTS.map((effort, index) => (
            <Text key={effort} color={index === cursor ? theme.user : theme.muted}>
              {index === cursor ? '› ' : '  '}
              {effort}
            </Text>
          ))}
        </Box>
        <Text color={theme.muted}>
          ↑↓ choose · enter use{embedded ? ' here · g use everywhere' : ''} · esc back
        </Text>
      </Box>
    );

  return null;
}

function Header({ embedded }: { embedded: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        {embedded ? 'switch model' : 'earshot needs a model provider before it can do anything.'}
      </Text>
    </Box>
  );
}

function hint(provider: OnboardingProvider): string {
  if (provider.configured) return provider.configured;
  if (provider.kind === 'oauth') return 'sign in with a browser - no key to paste';
  return provider.envVars?.length ? provider.envVars.join(' or ') : 'api key';
}

function matchingModels(
  models: readonly OnboardingModel[],
  query: string,
): readonly OnboardingModel[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return models;
  return models.filter(
    (model) => model.id.toLowerCase().includes(wanted) || model.name.toLowerCase().includes(wanted),
  );
}

function preferredModelIndex(models: readonly OnboardingModel[], wanted?: string): number {
  if (!wanted) return 0;
  const modelId = wanted.includes('/') ? wanted.slice(wanted.indexOf('/') + 1) : wanted;
  const index = models.findIndex((model) => model.id === wanted || model.id === modelId);
  return Math.max(0, index);
}

/** The provider the requested model needs goes first; it is why we are here. */
function order(
  providers: readonly OnboardingProvider[],
  wanted?: string,
): readonly OnboardingProvider[] {
  if (!wanted) return providers;
  return [
    ...providers.filter((provider) => provider.id === wanted),
    ...providers.filter((provider) => provider.id !== wanted),
  ];
}
