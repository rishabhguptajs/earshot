import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import type { ProbeResult } from './onboarding.tsx';
import { theme } from './theme.ts';

/**
 * The free-provider setup wizard.
 *
 * A separate component from `Onboarding` on purpose: that one is already doing
 * double duty as the first-run screen and the `/model` picker, and a third mode
 * would make all three harder to follow. What they share is the shape - plain
 * callbacks, no registry, no network - so this can be driven in a test.
 *
 * The same rule about secrets applies here and for the same reason: the key the
 * user types lives in a ref, is drawn as bullets, and is handed to the caller's
 * store. It is never put in state, because state is rendered, and a rendered
 * secret outlives the process in the user's scrollback.
 */

export interface PoolProviderOption {
  readonly id: string;
  readonly label: string;
  readonly signupUrl: string;
  /** Pre-rendered, e.g. "14,400 requests/day". The TUI knows no vendor limits. */
  readonly limits: string;
  readonly trainsOnData: boolean;
  /** Account names already connected for this provider. */
  readonly accounts: readonly string[];
}

export interface PoolSetupOptions {
  providers: readonly PoolProviderOption[];
  /** Stores a key under a named account. The caller's `AuthStore`, never a second one. */
  storeKey(providerId: string, account: string, key: string): Promise<void>;
  forgetKey(providerId: string, account: string): Promise<void>;
  /** One minimal live call. The only thing that proves a credential works. */
  probe(providerId: string): Promise<ProbeResult>;
  /** Opens the signup page. Printed as well, because over SSH there is no browser. */
  openUrl?(url: string): void;
  /** Turns the pool on and makes `free/best` the default. */
  finish?(): Promise<string | undefined>;
}

export interface PoolSetupResult {
  outcome: 'done' | 'quit';
  connected: number;
}

type Screen =
  | { name: 'list' }
  | { name: 'key'; provider: PoolProviderOption; account: string }
  | { name: 'probing'; provider: PoolProviderOption }
  | { name: 'failed'; provider: PoolProviderOption; result: Extract<ProbeResult, { ok: false }> }
  | { name: 'done'; savedTo?: string };

export interface PoolSetupProps extends PoolSetupOptions {
  onDone: (result: PoolSetupResult) => void;
  embedded?: boolean;
}

export function PoolSetup({ onDone, embedded = false, ...rest }: PoolSetupProps) {
  const { exit } = useApp();
  const options = useRef(rest);
  options.current = rest;

  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [cursor, setCursor] = useState(0);
  const [connected, setConnected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(rest.providers.map((p) => [p.id, [...p.accounts]])),
  );
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | undefined>();
  const secret = useRef('');

  const providers = rest.providers;
  const total = Object.values(connected).reduce((sum, list) => sum + list.length, 0);

  const finish = useCallback(
    (outcome: PoolSetupResult['outcome']) => {
      onDone({ outcome, connected: total });
      if (!embedded) exit();
    },
    [embedded, exit, onDone, total],
  );

  const startKey = useCallback(
    (provider: PoolProviderOption, extra: boolean) => {
      secret.current = '';
      setInput('');
      setError(undefined);
      // Accounts are named so each gets its own quota bucket. The name is
      // generated rather than asked for: what matters is that they are distinct,
      // and one more question here is one more reason to abandon the wizard.
      const existing = connected[provider.id] ?? [];
      const account = extra || existing.length > 0 ? `account-${existing.length + 1}` : 'default';
      options.current.openUrl?.(provider.signupUrl);
      setScreen({ name: 'key', provider, account });
    },
    [connected],
  );

  const submitKey = useCallback(async () => {
    if (screen.name !== 'key') return;
    const key = secret.current.trim();
    secret.current = '';
    setInput('');
    if (key === '') {
      setError('a key is needed, or press esc to go back');
      return;
    }
    setError(undefined);
    const { provider, account } = screen;
    await options.current.storeKey(provider.id, account, key);

    setScreen({ name: 'probing', provider });
    const result = await options.current.probe(provider.id);
    if (result.ok) {
      setConnected((current) => ({
        ...current,
        [provider.id]: [...(current[provider.id] ?? []), account],
      }));
      setScreen({ name: 'list' });
      return;
    }
    // A key the provider refused is worse than no key: it fails again on every
    // future launch, from a file the user has no reason to look in.
    if (result.reason === 'rejected') {
      await options.current.forgetKey(provider.id, account).catch(() => {});
    }
    setScreen({ name: 'failed', provider, result });
  }, [screen]);

  const complete = useCallback(async () => {
    const savedTo = await options.current.finish?.();
    setScreen({ name: 'done', ...(savedTo ? { savedTo } : {}) });
  }, []);

  useInput((key, meta) => {
    if (meta.ctrl && key === 'c') {
      finish('quit');
      return;
    }

    if (screen.name === 'list') {
      if (key === 'q') {
        finish('quit');
        return;
      }
      if (meta.upArrow) setCursor((c) => (c <= 0 ? providers.length - 1 : c - 1));
      if (meta.downArrow) setCursor((c) => (c >= providers.length - 1 ? 0 : c + 1));
      const provider = providers[cursor];
      if (meta.return && provider) startKey(provider, false);
      if (key === 'a' && provider) startKey(provider, true);
      if (key === 'd') void complete();
      return;
    }

    if (screen.name === 'key') {
      if (meta.escape) {
        secret.current = '';
        setInput('');
        setError(undefined);
        setScreen({ name: 'list' });
        return;
      }
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

    if (screen.name === 'failed' && (meta.escape || meta.return)) {
      setScreen({ name: 'list' });
      return;
    }

    if (screen.name === 'done') finish('done');
  });

  if (screen.name === 'key') {
    return (
      <Box flexDirection="column">
        <Text>
          paste a free api key for {screen.provider.label}
          {screen.account === 'default' ? '' : ` (${screen.account})`}
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.muted}>get one at {screen.provider.signupUrl}</Text>
          <Text color={theme.muted}>
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

  if (screen.name === 'probing') {
    return <Text color={theme.muted}>checking the key with {screen.provider.label}…</Text>;
  }

  if (screen.name === 'failed') {
    return (
      <Box flexDirection="column">
        <Text color={theme.warning}>
          {screen.result.reason === 'rejected'
            ? `${screen.provider.label} rejected that key. It has not been kept.`
            : `could not reach ${screen.provider.label}.`}
        </Text>
        <Text color={theme.muted}>{screen.result.message}</Text>
        <Box marginTop={1}>
          <Text color={theme.muted}>enter go back · ctrl-c quit</Text>
        </Box>
      </Box>
    );
  }

  if (screen.name === 'done') {
    return (
      <Box flexDirection="column">
        <Text>
          {total === 0
            ? 'nothing connected. run `earshot pool setup` whenever you like.'
            : `${total} free ${total === 1 ? 'account' : 'accounts'} connected. earshot will use free/best.`}
        </Text>
        {screen.savedTo ? <Text color={theme.muted}>saved to {screen.savedTo}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.muted}>press any key to continue</Text>
        </Box>
      </Box>
    );
  }

  const trains = providers.some((p) => p.trainsOnData);
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text>connect free providers</Text>
        <Text color={theme.muted}>
          each one is metered separately, so connecting several adds their limits together.
        </Text>
      </Box>

      {providers.map((provider, index) => {
        const accounts = connected[provider.id] ?? [];
        const selected = index === cursor;
        return (
          <Box key={provider.id}>
            <Text color={selected ? theme.user : theme.muted}>{selected ? '› ' : '  '}</Text>
            <Text {...(selected ? { color: theme.user } : {})}>{provider.label.padEnd(20)}</Text>
            <Text color={theme.muted}>{provider.limits.padEnd(30)}</Text>
            <Text color={accounts.length ? theme.added : theme.muted}>
              {accounts.length === 0 ? 'not connected' : `${accounts.length} connected`}
            </Text>
            {provider.trainsOnData ? <Text color={theme.muted}> · trains on your data</Text> : null}
          </Box>
        );
      })}

      {trains ? (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            providers marked “trains on your data” may use what you send to improve their models.
            earshot reads your source, so connect those only if that is fine with you.
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.muted}>
          ↑↓ choose · enter connect · a add another account · d done · q quit
        </Text>
        <Text color={theme.muted}>
          a second key from the same account shares its limit - only a different account adds
          capacity.
        </Text>
      </Box>
      {error ? <Text color={theme.warning}>{error}</Text> : null}
    </Box>
  );
}
