/**
 * ops-router — resolve the `claude` CLI binary path.
 *
 * The systemd service runs with a PATH that does not include ~/.local/bin,
 * so the Agent SDK can't find `claude` on its own. We resolve it explicitly:
 *   1. CLAUDE_CLI_PATH env override
 *   2. known per-user / system install locations
 *   3. bare "claude" (let the SDK search PATH as a last resort)
 *
 * No path is hardcoded as a literal — locations are derived from $HOME.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

let cached: string | undefined;

export function resolveClaudeCli(): string {
  if (cached) return cached;

  const override = process.env.CLAUDE_CLI_PATH;
  if (override && fs.existsSync(override)) {
    cached = override;
    return cached;
  }

  const home = process.env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      cached = c;
      return cached;
    }
  }

  cached = 'claude';
  return cached;
}
