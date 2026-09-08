import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { OnboardingOptions, OnboardingProvider, ProbeResult } from '../src/onboarding.tsx';

/**
 * Ink decides once, at module evaluation, whether it is running in CI - and in
 * CI it writes only `<Static>` output, never the live region. Onboarding has no
 * `<Static>` region at all, but the import still has to be dynamic and after
 * the deletions below, or a hoisted static import loads Ink before CI is
 * suppressed and the suppression never takes effect.
 */
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
const { render } = await import('ink');
const { Onboarding } = await import('../src/onboarding.tsx');

class FakeStdout extends EventEmitter {
  output = '';
  columns = 100;
  rows = 30;
  readonly isTTY = true;
  write(data: string): boolean {
    this.output += data;
    return true;
  }
}

class FakeStdin extends PassThrough {
  readonly isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  send(data: string): void {
    this.write(data);
  }
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(stdout: FakeStdout, text: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdout.output.includes(text)) return;
    await settle(10);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(text)}. Rendered:\n${stdout.output}`);
}

/**
 * Types text and then presses Return, with a tick between.
 *
 * Sending both in one tick makes the fake stream coalesce them into a single
 * chunk, which the app reads as pasted text containing a carriage return
 * rather than as typing followed by Return - so nothing submits. A terminal
 * delivers them separately, and so does this.
 */
async function type(stdin: FakeStdin, text: string): Promise<void> {
  stdin.send(text);
  await settle(30);
  stdin.send('\r');
  await settle(30);
}

async function selectFirstModel(stdout: FakeStdout, stdin: FakeStdin): Promise<void> {
  await waitFor(stdout, 'choose a model from');
  await settle(100);
  stdin.send('\r');
  await settle(100);
}

interface Fixture extends Partial<OnboardingOptions> {
  providers?: OnboardingProvider[];
  /** Mounted as the in-session `/model` picker rather than as first-run. */
  embedded?: boolean;
  defaultScope?: 'global' | 'project';
}

/** Records what would have reached disk, without a real AuthStore. */
function withApp(
  fixture: Fixture,
  run: (io: { stdout: FakeStdout; stdin: FakeStdin }) => Promise<void>,
) {
  const stored: Array<{ providerId: string; key: string }> = [];
  const forgotten: string[] = [];
  const results: import('../src/onboarding.tsx').OnboardingResult[] = [];

  const options: OnboardingOptions = {
    providers: fixture.providers ?? [
      {
        id: 'anthropic',
        models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }],
        kind: 'api-key',
        envVars: ['ANTHROPIC_API_KEY'],
      },
      {
        id: 'openrouter',
        models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }],
        kind: 'oauth',
      },
    ],
    storeKey:
      fixture.storeKey ?? (async (providerId, key) => void stored.push({ providerId, key })),
    forgetKey: fixture.forgetKey ?? (async (providerId) => void forgotten.push(providerId)),
    signIn: fixture.signIn ?? (async () => {}),
    probe: fixture.probe ?? (async () => ({ ok: true }) as ProbeResult),
    ...(fixture.wanted ? { wanted: fixture.wanted } : {}),
    ...(fixture.wantedModel ? { wantedModel: fixture.wantedModel } : {}),
  };

  return (async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const instance = render(
      <Onboarding
        {...options}
        {...(fixture.embedded ? { embedded: true } : {})}
        {...(fixture.defaultScope ? { defaultScope: fixture.defaultScope } : {})}
        onDone={(result) => results.push(result)}
      />,
      {
        stdout: stdout as never,
        stdin: stdin as never,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    try {
      await settle();
      await run({ stdout, stdin });
    } finally {
      instance.unmount();
    }
    return { stored, forgotten, results };
  })();
}

describe('onboarding: provider choice', () => {
  test('lists providers with how each would be authenticated', async () => {
    const { results } = await withApp({}, async ({ stdout }) => {
      await waitFor(stdout, 'anthropic');
      expect(stdout.output).toContain('ANTHROPIC_API_KEY');
      expect(stdout.output).toContain('openrouter');
      expect(stdout.output).toContain('sign in with a browser');
    });
    expect(results).toHaveLength(0);
  });

  test('shows a provider already configured elsewhere as such', async () => {
    await withApp(
      {
        providers: [
          {
            id: 'anthropic',
            models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }],
            kind: 'api-key',
            configured: 'ambient credentials',
          },
        ],
      },
      async ({ stdout }) => {
        await waitFor(stdout, 'ambient credentials');
      },
    );
  });

  test('the requested provider is listed first', async () => {
    await withApp(
      {
        providers: [
          { id: 'anthropic', models: [], kind: 'api-key' },
          { id: 'groq', models: [], kind: 'api-key' },
        ],
        wanted: 'groq',
      },
      async ({ stdout }) => {
        await waitFor(stdout, 'groq');
        expect(stdout.output.indexOf('groq')).toBeLessThan(stdout.output.indexOf('anthropic'));
      },
    );
  });

  test('q quits without storing anything', async () => {
    const { stored, results } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('q');
      await settle(60);
    });
    expect(stored).toHaveLength(0);
    expect(results).toEqual([{ outcome: 'quit' }]);
  });

  test('ctrl-c quits from any screen', async () => {
    const { results } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('\r'); // into the key screen for the first (highlighted) provider
      await settle(30);
      stdin.send('\x03'); // ctrl-c
      await settle(60);
    });
    expect(results).toEqual([{ outcome: 'quit' }]);
  });
});

describe('onboarding: pasting a key', () => {
  test('the key reaches storeKey and never appears on screen', async () => {
    const { stored } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('\r'); // select anthropic (first row)
      await selectFirstModel(stdout, stdin);
      await waitFor(stdout, 'paste an api key');
      stdin.send('sk-super-secret-value');
      await settle(60);
      // Masked on screen, and the raw value must never be there, in the
      // "usage" hint, or anywhere else - this is the assertion that makes the
      // no-secrets rule mechanical rather than a promise in a comment.
      expect(stdout.output).not.toContain('sk-super-secret-value');
      expect(stdout.output).toContain('•');
      stdin.send('\r');
      await settle(60);
      await settle(60);
      expect(stdout.output).not.toContain('sk-super-secret-value');
    });
    expect(stored).toEqual([{ providerId: 'anthropic', key: 'sk-super-secret-value' }]);
  });

  test('an empty key is rejected rather than stored', async () => {
    const { stored } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('\r');
      await selectFirstModel(stdout, stdin);
      await waitFor(stdout, 'paste an api key');
      stdin.send('\r');
      await waitFor(stdout, 'a key is needed');
    });
    expect(stored).toHaveLength(0);
  });

  test('esc from the key screen goes back to model choice without storing', async () => {
    const { stored } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('\r');
      await selectFirstModel(stdout, stdin);
      await waitFor(stdout, 'paste an api key');
      stdin.send('half-typed');
      await settle(30);
      stdin.send('\x1b');
      await waitFor(stdout, 'choose a model from anthropic');
      expect(stdout.output).not.toContain('half-typed');
    });
    expect(stored).toHaveLength(0);
  });
});

describe('onboarding: model choice', () => {
  test('filters models and immediately uses an already configured provider', async () => {
    const probed: Array<{ providerId: string; modelId: string }> = [];
    const { results } = await withApp(
      {
        providers: [
          {
            id: 'anthropic',
            models: [
              { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
              { id: 'claude-opus-5', name: 'Claude Opus 5' },
            ],
            kind: 'api-key',
            configured: 'api key set',
          },
        ],
        probe: async (providerId, modelId) => {
          probed.push({ providerId, modelId });
          return { ok: true };
        },
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'anthropic');
        stdin.send('\r');
        await waitFor(stdout, 'choose a model from anthropic');
        await type(stdin, 'opus');
        await settle(60);
      },
    );
    expect(probed).toEqual([]);
    expect(results).toEqual([
      {
        outcome: 'ready',
        providerId: 'anthropic',
        model: 'anthropic/claude-opus-5',
        scope: 'global',
      },
    ]);
  });
});

describe('onboarding: validation', () => {
  test('a rejected key is removed and the screen explains why', async () => {
    const { forgotten } = await withApp(
      {
        probe: async () => ({ ok: false, reason: 'rejected', message: 'invalid api key' }),
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'anthropic');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'paste an api key');
        await type(stdin, 'sk-bad');
        await waitFor(stdout, 'rejected that credential');
        expect(stdout.output).toContain('invalid api key');
        expect(stdout.output).not.toContain('sk-bad');
      },
    );
    expect(forgotten).toEqual(['anthropic']);
  });

  test('esc after a rejection starts over, still without the key on screen', async () => {
    await withApp(
      { probe: async () => ({ ok: false, reason: 'rejected', message: 'invalid api key' }) },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'anthropic');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'paste an api key');
        await type(stdin, 'sk-bad');
        await waitFor(stdout, 'rejected that credential');
        stdin.send('\x1b');
        await waitFor(stdout, 'earshot needs a model provider');
      },
    );
  });

  test('an unreachable probe offers keeping the key anyway', async () => {
    const { forgotten, results } = await withApp(
      {
        probe: async () => ({ ok: false, reason: 'unreachable', message: 'network unreachable' }),
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'anthropic');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'paste an api key');
        await type(stdin, 'sk-maybe-fine');
        await waitFor(stdout, 'could not reach');
        expect(stdout.output).toContain('keep it anyway');
        stdin.send('k');
        await settle(60);
      },
    );
    // Unlike a rejection, an unreachable probe never removes what was stored -
    // an unreachable network must not be able to lock someone out of their own
    // setup.
    expect(forgotten).toHaveLength(0);
    expect(results).toEqual([
      {
        outcome: 'ready',
        providerId: 'anthropic',
        model: 'anthropic/claude-opus-5',
        scope: 'global',
      },
    ]);
  });

  test('finishes immediately without asking for a first prompt', async () => {
    const { results } = await withApp({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'anthropic');
      stdin.send('\r');
      await selectFirstModel(stdout, stdin);
      await waitFor(stdout, 'paste an api key');
      await type(stdin, 'sk-fine');
      await settle(60);
    });
    expect(results).toEqual([
      {
        outcome: 'ready',
        providerId: 'anthropic',
        model: 'anthropic/claude-opus-5',
        scope: 'global',
      },
    ]);
  });

  test('configured providers finish without probing or credential prompts', async () => {
    const { results } = await withApp(
      {
        providers: [
          {
            id: 'anthropic',
            models: [{ id: 'claude-opus-5', name: 'Claude Opus 5' }],
            kind: 'api-key',
            configured: 'api key set',
          },
        ],
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'anthropic');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await settle(60);
      },
    );
    expect(results).toEqual([
      {
        outcome: 'ready',
        providerId: 'anthropic',
        model: 'anthropic/claude-opus-5',
        scope: 'global',
      },
    ]);
  });
});

describe('onboarding: browser sign-in', () => {
  test('shows the url as well as opening it', async () => {
    await withApp(
      {
        providers: [
          {
            id: 'openrouter',
            models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }],
            kind: 'oauth',
          },
        ],
        signIn: (_id, onUrl) => {
          onUrl('https://openrouter.ai/authorize?abc');
          // Never resolves: the assertion is about the waiting screen, not
          // about what happens after a sign-in completes - that is covered by
          // the "ready" screen tests, which use a signIn that does resolve.
          return new Promise(() => {});
        },
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'openrouter');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'https://openrouter.ai/authorize?abc');
      },
    );
  });

  test('a failed sign-in is shown without pretending it is a rejected key', async () => {
    await withApp(
      {
        providers: [
          {
            id: 'openrouter',
            models: [{ id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }],
            kind: 'oauth',
          },
        ],
        signIn: async () => {
          throw new Error('the browser flow timed out');
        },
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'openrouter');
        stdin.send('\r');
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'openrouter said:');
        expect(stdout.output).toContain('the browser flow timed out');
      },
    );
  });
});

/**
 * The `/model` picker used to write project-scoped settings on `enter` and hide
 * "save globally" behind `ctrl+g` on one screen and a bare `g` on another. A
 * model chosen in one directory then reverted to the stale global default
 * everywhere else, with nothing on screen having said so.
 */
describe('onboarding: where a choice is saved', () => {
  const groq: OnboardingProvider = {
    id: 'groq',
    models: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }],
    kind: 'api-key',
    configured: 'api key set',
  };

  test('the embedded picker asks, and defaults to everywhere', async () => {
    const { results } = await withApp(
      { providers: [groq], embedded: true },
      async ({ stdout, stdin }) => {
        stdin.send('\r'); // pick the provider
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'where?');
        expect(stdout.output).toContain('everywhere');
        expect(stdout.output).toContain('this project only');
        stdin.send('\r');
        await settle(60);
      },
    );
    expect(results).toEqual([
      { outcome: 'ready', providerId: 'groq', model: 'groq/llama-3.3-70b', scope: 'global' },
    ]);
  });

  test('choosing the second option scopes it to the project', async () => {
    const { results } = await withApp(
      { providers: [groq], embedded: true },
      async ({ stdout, stdin }) => {
        stdin.send('\r'); // pick the provider
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'where?');
        stdin.send('\u001b[B'); // down
        await settle(30);
        stdin.send('\r');
        await settle(60);
      },
    );
    expect(results[0]?.scope).toBe('project');
  });

  test('defaultScope only positions the cursor', async () => {
    const { results } = await withApp(
      { providers: [groq], embedded: true, defaultScope: 'project' },
      async ({ stdout, stdin }) => {
        stdin.send('\r'); // pick the provider
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'where?');
        stdin.send('\r');
        await settle(60);
      },
    );
    expect(results[0]?.scope).toBe('project');
  });

  test('the hidden g accelerator is gone: it neither saves nor completes', async () => {
    const { results } = await withApp(
      { providers: [groq], embedded: true },
      async ({ stdout, stdin }) => {
        stdin.send('\r'); // pick the provider
        await waitFor(stdout, 'choose a model from');
        stdin.send('g');
        await settle(60);
      },
    );
    expect(results).toHaveLength(0);
  });

  test('first-run onboarding never asks - there is no project yet', async () => {
    const { results } = await withApp({ providers: [groq] }, async ({ stdout, stdin }) => {
      stdin.send('\r'); // pick the provider
      await selectFirstModel(stdout, stdin);
      await settle(80);
    });
    expect(results[0]?.scope).toBe('global');
  });

  test('esc from the scope screen goes back to the model list', async () => {
    const { results } = await withApp(
      { providers: [groq], embedded: true },
      async ({ stdout, stdin }) => {
        stdin.send('\r'); // pick the provider
        await selectFirstModel(stdout, stdin);
        await waitFor(stdout, 'where?');
        const before = stdout.output.length;
        stdin.send('\u001b');
        await settle(60);
        expect(stdout.output.slice(before)).toContain('choose a model from');
      },
    );
    expect(results).toHaveLength(0);
  });
});
