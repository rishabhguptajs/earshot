import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** XDG on Linux/mac, %APPDATA%/%LOCALAPPDATA% on Windows. */
export function configDir(): string {
  const env = process.env.EARSHOT_CONFIG_DIR;
  if (env) return env;
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'earshot');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'earshot');
}

export function dataDir(): string {
  const env = process.env.EARSHOT_DATA_DIR;
  if (env) return env;
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'earshot');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'earshot');
}

export const authFile = (): string => join(configDir(), 'auth.json');
export const sessionsDir = (): string => join(dataDir(), 'sessions');
