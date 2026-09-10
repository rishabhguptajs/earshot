import {
  loadTelemetryState,
  resetTelemetryIdentity,
  setTelemetryEnabled,
  Telemetry,
  telemetryPath,
} from '@earshot/core';
import type { ParsedArgs } from '../args.ts';
export async function telemetryCommand(args: ParsedArgs): Promise<number> {
  const command = args.positionals[0];
  if (command === 'enable') {
    const state = await setTelemetryEnabled(true);
    new Telemetry(state).emit('telemetry_enabled');
    process.stdout.write(
      'Anonymous telemetry enabled. A new anonymous installation ID was created.\n',
    );
    return 0;
  }
  if (command === 'disable') {
    const state = await loadTelemetryState();
    new Telemetry(state).emit('telemetry_disabled');
    await setTelemetryEnabled(false);
    process.stdout.write('Telemetry disabled. The anonymous installation ID was removed.\n');
    return 0;
  }
  if (command === 'reset') {
    const state = await resetTelemetryIdentity();
    process.stdout.write(
      state?.enabled
        ? 'Anonymous installation ID reset.\n'
        : 'Telemetry is not enabled; no ID to reset.\n',
    );
    return 0;
  }
  if (command === 'status' || command === undefined) {
    const state = await loadTelemetryState();
    process.stdout.write(
      `Telemetry: ${state?.enabled ? 'enabled' : 'disabled'}\nState: ${telemetryPath()}\n`,
    );
    return 0;
  }
  process.stderr.write('usage: earshot telemetry <enable|disable|status|reset>\n');
  return 2;
}
