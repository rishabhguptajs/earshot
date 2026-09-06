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
 *     ref, drawn as bullets, and handed to `store`; `firstPrompt` is the only
 *     text that leaves here.
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
  /** How credentials are given: a browser sign-in, or a key. */
  readonly kind: 'oauth' | 'api-key';
  /** Environment variable(s) that would also work, for the hint line. */
  readonly envVars?: readonly string[];
  /** Already configured elsewhere - an env var, or ambient credentials. */
  readonly configured?: string;
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
  /** Stores an api key. The caller's `AuthStore`, never a second one. */
  storeKey(providerId: string, key: string): Promise<void>;
  /** Removes what was stored, so a rejected key is not left to fail again. */
  forgetKey(providerId: string): Promise<void>;
  /** The existing PKCE flow. `onUrl` is shown as well as opened: over SSH there is no browser. */
  signIn(providerId: string, onUrl: (url: string) => void): Promise<void>;
  /** One minimal live call. The only thing that proves a credential works. */
  probe(providerId: string): Promise<ProbeResult>;
}

export interface OnboardingResult {
  /** `ready` means credentials are stored and verified. */
  outcome: 'ready' | 'quit';
  providerId?: string;
  /** What the user typed on the last screen, run as the first turn. */
  firstPrompt?: string;
}

type Screen =
  | { name: 'choose' }
  | { name: 'key'; provider: OnboardingProvider }
  | { name: 'oauth'; provider: OnboardingProvider; url?: string }
  | { name: 'probing'; provider: OnboardingProvider }
  | { name: 'failed'; provider: OnboardingProvider; result: Extract<ProbeResult, { ok: false }> }
  | { name: 'ready'; provider: OnboardingProvider };

export interface OnboardingProps extends OnboardingOptions {
  onDone: (result: OnboardingResult) => void;
}

export function Onboarding({ onDone, ...rest }: OnboardingProps) {
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
      exit();
    },
    [exit, onDone],
  );

  const verify = useCallback(async (provider: OnboardingProvider) => {
    setScreen({ name: 'probing', provider });
    const result = await options.current.probe(provider.id);
    if (result.ok) {
      setScreen({ name: 'ready', provider });
      return;
    }
    // A key the provider refused is worse than no key: it fails again on every
    // future launch, from a file the user has no reason to look in.
    if (result.reason === 'rejected') await options.current.forgetKey(provider.id).catch(() => {});
    setScreen({ name: 'failed', provider, result });
  }, []);

  const submitKey = useCallback(async () => {
    const provider = screen.name === 'key' ? screen.provider : undefined;
    const key = secret.current;
    secret.current = '';
    setInput('');
    if (!provider) return;
    if (key.trim() === '') {
      setError('a key is needed, or press esc to go back');
      return;
    }
    setError(undefined);
    await options.current.storeKey(provider.id, key.trim());
    await verify(provider);
  }, [screen, verify]);

  const startSignIn = useCallback(
    async (provider: OnboardingProvider) => {
      setScreen({ name: 'oauth', provider });
      try {
        await options.current.signIn(provider.id, (url) =>
          setScreen({ name: 'oauth', provider, url }),
        );
      } catch (failure) {
        setScreen({
          name: 'failed',
          provider,
          result: { ok: false, reason: 'other', message: (failure as Error).message },
        });
        return;
      }
      await verify(provider);
    },
    [verify],
  );

  const choose = useCallback(
    (provider: OnboardingProvider) => {
      setError(undefined);
      if (provider.kind === 'oauth') void startSignIn(provider);
      else setScreen({ name: 'key', provider });
    },
    [startSignIn],
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
        if (provider) choose(provider);
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
      setScreen({ name: 'choose' });
      return;
    }
    if (screen.name === 'failed' && key === 'k' && screen.result.reason === 'unreachable') {
      // Keeping an unverified key is allowed on purpose: a network that cannot
      // be reached must not be able to lock someone out of their own setup.
      setScreen({ name: 'ready', provider: screen.provider });
    }
  });

  if (screen.name === 'choose') {
    return (
      <Box flexDirection="column">
        <Header />
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

  if (screen.name === 'key') {
    return (
      <Box flexDirection="column">
        <Header />
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
        <Header />
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
        <Header />
        <Text color={theme.muted}>checking the credentials with {screen.provider.id}…</Text>
      </Box>
    );
  }

  if (screen.name === 'failed') {
    return (
      <Box flexDirection="column">
        <Header />
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

  return (
    <Box flexDirection="column">
      <Text color={theme.user}>ready: {screen.provider.id}</Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>what should I do? (enter to start with nothing)</Text>
      </Box>
      <Box>
        <Text color={theme.user}>{'> '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(text) =>
            finish({ outcome: 'ready', providerId: screen.provider.id, firstPrompt: text.trim() })
          }
        />
      </Box>
    </Box>
  );
}

function Header() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>earshot needs a model provider before it can do anything.</Text>
    </Box>
  );
}

function hint(provider: OnboardingProvider): string {
  if (provider.configured) return provider.configured;
  if (provider.kind === 'oauth') return 'sign in with a browser - no key to paste';
  return provider.envVars?.length ? provider.envVars.join(' or ') : 'api key';
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
