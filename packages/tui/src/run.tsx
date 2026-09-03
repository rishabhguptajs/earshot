import { platform } from 'node:os';
import type { CreatedSession } from '@earshot/core';
import { render } from 'ink';
import { App } from './app.tsx';

export interface RunTuiOptions {
  session: CreatedSession;
  model: string;
  initialPrompt?: string;
}

/**
 * Windows renders more slowly and repaints more visibly than a POSIX terminal,
 * so the frame rate is capped rather than left at Ink's default. 30 is not a
 * performance tuning number: above it, ConPTY's repaint of the live region
 * flickers badly enough to be unpleasant to watch during a long turn.
 */
const WINDOWS_MAX_FPS = 30;

/**
 * Starts the interactive app.
 *
 * Nothing in this package writes a DA1 (`CSI c`) or DCS terminal query. ConPTY
 * does not answer them and does not fail either: the query is swallowed and the
 * process sits waiting for a reply that never arrives, which presents to the
 * user as earshot hanging for a minute on startup. Any future capability
 * detection has to be feature-flagged off on Windows for the same reason, which
 * is why colour support is assumed from Ink's own detection rather than probed.
 */
export async function runTui(options: RunTuiOptions): Promise<number> {
  const isWindows = platform() === 'win32';

  const instance = render(
    <App
      session={options.session}
      model={options.model}
      {...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {})}
    />,
    {
      // Ctrl-C is handled by the app so a running turn can be interrupted without
      // tearing down the terminal mid-render and leaving it in a raw mode.
      exitOnCtrlC: false,
      // Console output from a dependency would otherwise be interleaved into the
      // live region and corrupt the frame Ink believes it has drawn.
      patchConsole: true,
      ...(isWindows ? { maxFps: WINDOWS_MAX_FPS } : {}),
    },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    await options.session.dispose();
  }
  return 0;
}
