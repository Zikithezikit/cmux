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

let lastUsed = null;
try {
  lastUsed = JSON.parse(readFileSync(join(configDir, 'Local State'), 'utf8')).profile?.last_used ?? null;
} catch { /* no Local State */ }

const hits = [];
for (const dir of readdirSync(configDir)) {
  for (const file of ['Secure Preferences', 'Preferences']) {
    const p = join(configDir, dir, file);
    if (!existsSync(p)) continue;
    try {
      const ext = JSON.parse(readFileSync(p, 'utf8')).extensions?.settings?.[id];
      // state 0 = disabled; anything else (or missing) counts as installed.
      if (ext && ext.state !== 0) { hits.push(dir); break; }
    } catch { /* unreadable or mid-write */ }
  }
}

// Prefer the profile Chrome would open anyway.
const pick = hits.includes(lastUsed) ? lastUsed : hits[0];
if (pick) process.stdout.write(pick);
