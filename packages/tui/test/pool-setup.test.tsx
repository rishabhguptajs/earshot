import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { PoolProviderOption, PoolSetupOptions, PoolSetupResult } from '../src/pool-setup.tsx';

delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;
const { render } = await import('ink');
const { PoolSetup } = await import('../src/pool-setup.tsx');

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

const groq: PoolProviderOption = {
  id: 'groq',
  label: 'Groq',
  signupUrl: 'https://console.groq.com/keys',
  limits: 'free · 14,400 requests/day',
  trainsOnData: false,
  accounts: [],
};

const google: PoolProviderOption = {
  id: 'google',
  label: 'Google AI Studio',
  signupUrl: 'https://aistudio.google.com/apikey',
  limits: 'free · 250 requests/day',
  trainsOnData: true,
  accounts: [],
};

/** A provider whose endpoint needs more than a key - Cloudflare's account id. */
const cloudflare: PoolProviderOption = {
  id: 'cloudflare',
  label: 'Cloudflare Workers AI',
  signupUrl: 'https://dash.cloudflare.com',
  limits: 'free · 150 requests/day',
  trainsOnData: false,
  accounts: [],
  extraFields: [
    {
      name: 'CLOUDFLARE_ACCOUNT_ID',
      label: 'Cloudflare account id',
      hint: 'on your overview page',
    },
  ],
};

interface Fixture extends Partial<PoolSetupOptions> {
  providers?: PoolProviderOption[];
}

function withWizard(
  fixture: Fixture,
  run: (io: { stdout: FakeStdout; stdin: FakeStdin }) => Promise<void>,
) {
  const stored: Array<{
    providerId: string;
    account: string;
    key: string;
    extra?: Record<string, string>;
  }> = [];
  const forgotten: Array<{ providerId: string; account: string }> = [];
  const opened: string[] = [];
  const results: PoolSetupResult[] = [];
  let finished = 0;

  const options: PoolSetupOptions = {
    providers: fixture.providers ?? [groq, google],
    storeKey:
      fixture.storeKey ??
      (async (providerId, account, key, extra) =>
        void stored.push({ providerId, account, key, ...(extra ? { extra } : {}) })),
    forgetKey:
      fixture.forgetKey ??
      (async (providerId, account) => void forgotten.push({ providerId, account })),
    probe: fixture.probe ?? (async () => ({ ok: true })),
    openUrl: fixture.openUrl ?? ((url) => void opened.push(url)),
    finish:
      fixture.finish ??
      (async () => {
        finished++;
        return '/home/u/.config/earshot/settings.json';
      }),
  };

  return (async () => {
    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const instance = render(<PoolSetup {...options} onDone={(r) => results.push(r)} />, {
      stdout: stdout as never,
      stdin: stdin as never,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await settle();
      await run({ stdout, stdin });
    } finally {
      instance.unmount();
    }
    return { stored, forgotten, opened, results, finished: () => finished };
  })();
}

describe('the pool setup wizard', () => {
  test('lists each provider with its limits and whether it is connected', async () => {
    await withWizard({}, async ({ stdout }) => {
      await waitFor(stdout, 'Groq');
      expect(stdout.output).toContain('14,400 requests/day');
      expect(stdout.output).toContain('not connected');
    });
  });

  /**
   * The pooling promise only holds if the user understands it, and the one
   * thing that is genuinely counter-intuitive is that keys are not the unit -
   * accounts are. Two keys from one login share one bucket.
   */
  test('says plainly that a second key from one account adds nothing', async () => {
    await withWizard({}, async ({ stdout }) => {
      await waitFor(stdout, 'Groq');
      expect(stdout.output).toContain('only a different account adds');
    });
  });

  test('warns about providers that train on submitted data', async () => {
    await withWizard({}, async ({ stdout }) => {
      await waitFor(stdout, 'Google AI Studio');
      expect(stdout.output).toContain('trains on your data');
      expect(stdout.output).toContain('may use what you send to improve');
    });
  });

  test('connecting stores the key under the default account and opens the signup page', async () => {
    const { stored, opened } = await withWizard({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Groq');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('gsk_secret');
      await settle(30);
      stdin.send('\r');
      // "1 connected", not "connected": "not connected" is already on screen.
      await waitFor(stdout, '1 connected');
    });

    expect(stored).toEqual([{ providerId: 'groq', account: 'default', key: 'gsk_secret' }]);
    expect(opened).toEqual(['https://console.groq.com/keys']);
  });

  /** The typed key lives in a ref and is drawn as bullets; state is rendered. */
  test('never renders the key', async () => {
    await withWizard({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Groq');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('gsk_secret');
      await settle(60);
      expect(stdout.output).not.toContain('gsk_secret');
      expect(stdout.output).toContain('••••••••••');
    });
  });

  test('a second account is named separately so it gets its own bucket', async () => {
    const { stored } = await withWizard({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Groq');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('one');
      await settle(30);
      stdin.send('\r');
      await waitFor(stdout, '1 connected');
      await settle(60);

      stdin.send('a');
      await waitFor(stdout, 'account-2');
      stdin.send('two');
      await settle(30);
      stdin.send('\r');
      await settle(80);
    });

    expect(stored.map((one) => one.account)).toEqual(['default', 'account-2']);
  });

  /**
   * A key the provider refused is worse than no key: it fails again on every
   * launch, from a file the user has no reason to look in.
   */
  test('a rejected key is not kept', async () => {
    const { stored, forgotten } = await withWizard(
      { probe: async () => ({ ok: false, reason: 'rejected', message: 'invalid api key' }) },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'Groq');
        stdin.send('\r');
        await waitFor(stdout, 'paste a free api key');
        stdin.send('bad');
        await settle(30);
        stdin.send('\r');
        await waitFor(stdout, 'rejected that key');
      },
    );

    expect(stored).toHaveLength(1);
    expect(forgotten).toEqual([{ providerId: 'groq', account: 'default' }]);
  });

  test('an unreachable provider keeps the key - a flaky network is not a bad key', async () => {
    const { forgotten } = await withWizard(
      { probe: async () => ({ ok: false, reason: 'unreachable', message: 'network down' }) },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'Groq');
        stdin.send('\r');
        await waitFor(stdout, 'paste a free api key');
        stdin.send('maybe-fine');
        await settle(30);
        stdin.send('\r');
        await waitFor(stdout, 'could not reach');
      },
    );
    expect(forgotten).toEqual([]);
  });

  test('finishing turns the pool on and reports what was connected', async () => {
    const { results, finished } = await withWizard({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Groq');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('k');
      await settle(30);
      stdin.send('\r');
      await waitFor(stdout, '1 connected');
      // The screen has rendered, but Ink's input handler still closes over the
      // previous screen for a tick; a keypress in that gap is dropped.
      await settle(60);

      stdin.send('d');
      await waitFor(stdout, 'earshot will use free/best');
      stdin.send('\r');
      await settle(60);
    });

    expect(finished()).toBe(1);
    expect(results).toEqual([{ outcome: 'done', connected: 1 }]);
  });

  /**
   * Cloudflare puts the account id in the URL, so a key on its own is not a
   * credential at all - it is a login that will 404 on the first real turn.
   */
  test('asks for the extra values an endpoint needs and stores them with the key', async () => {
    const { stored } = await withWizard({ providers: [cloudflare] }, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Cloudflare Workers AI');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('cf_token');
      await settle(30);
      stdin.send('\r');

      await waitFor(stdout, 'Cloudflare account id');
      expect(stdout.output).toContain('on your overview page');
      await settle(60);
      stdin.send('acct123');
      await settle(30);
      stdin.send('\r');
      await waitFor(stdout, '1 connected');
    });

    expect(stored).toEqual([
      {
        providerId: 'cloudflare',
        account: 'default',
        key: 'cf_token',
        extra: { CLOUDFLARE_ACCOUNT_ID: 'acct123' },
      },
    ]);
  });

  test('stores nothing until every value the endpoint needs is in hand', async () => {
    const probed: string[] = [];
    const { stored } = await withWizard(
      {
        providers: [cloudflare],
        probe: async (id) => {
          probed.push(id);
          return { ok: true };
        },
      },
      async ({ stdout, stdin }) => {
        await waitFor(stdout, 'Cloudflare Workers AI');
        stdin.send('\r');
        await waitFor(stdout, 'paste a free api key');
        stdin.send('cf_token');
        await settle(30);
        stdin.send('\r');
        await waitFor(stdout, 'Cloudflare account id');
        await settle(60);

        // Backing out here must leave nothing behind: half a credential is a
        // login that fails later from a file the user has no reason to open.
        stdin.send('\u001B');
        await waitFor(stdout, 'paste a free api key');
        await settle(60);
      },
    );

    expect(stored).toEqual([]);
    expect(probed).toEqual([]);
  });

  test('the account id is shown as typed, unlike the key', async () => {
    await withWizard({ providers: [cloudflare] }, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Cloudflare Workers AI');
      stdin.send('\r');
      await waitFor(stdout, 'paste a free api key');
      stdin.send('cf_token');
      await settle(30);
      expect(stdout.output).not.toContain('cf_token');
      stdin.send('\r');

      await waitFor(stdout, 'Cloudflare account id');
      await settle(60);
      stdin.send('acct123');
      await waitFor(stdout, 'acct123');
    });
  });

  test('quitting connects nothing', async () => {
    const { stored, results } = await withWizard({}, async ({ stdout, stdin }) => {
      await waitFor(stdout, 'Groq');
      stdin.send('q');
      await settle(60);
    });
    expect(stored).toEqual([]);
    expect(results).toEqual([{ outcome: 'quit', connected: 0 }]);
  });
});
