// Prints the Chrome profile directory (e.g. "Default", "Profile 1") that has
// the given extension installed, or nothing. Used by `make app`.
//
//   node tools/chrome-profile.mjs <extension-id> [chrome-config-dir]

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const [id, configArg] = process.argv.slice(2);
const configDir = configArg || join(homedir(), '.config/google-chrome');
if (!id || !existsSync(configDir)) process.exit(0);

/** `value[key]` when `value` is a non-null object (parsed JSON), otherwise undefined. */
function prop(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

let lastUsed: string | null = null;
try {
  const last = prop(prop(readJson(join(configDir, 'Local State')), 'profile'), 'last_used');
  lastUsed = typeof last === 'string' ? last : null;
} catch { /* no Local State */ }

const hits: string[] = [];
for (const dir of readdirSync(configDir)) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    const p = join(configDir, dir, file);
    if (!existsSync(p)) continue;
    try {
      const ext = prop(prop(prop(readJson(p), 'extensions'), 'settings'), id);
      // state 0 = disabled; anything else (or missing) counts as installed.
      if (ext && prop(ext, 'state') !== 0) { hits.push(dir); break; }
    } catch { /* unreadable or mid-write */ }
  }
}

// Prefer the profile Chrome would open anyway.
const pick = lastUsed !== null && hits.includes(lastUsed) ? lastUsed : hits[0];
if (pick) process.stdout.write(pick);
