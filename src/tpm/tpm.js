// JS emulation of TPM (tmux plugin manager).
//
// `set -g @plugin 'owner/repo'` lines are collected while the config is
// sourced; `run '~/.tmux/plugins/tpm/tpm'` (or the end of the config) applies
// the matching built-in JS emulators. Unknown plugins are reported in the
// debug panel together with the @options that would have configured them.
// Repository metadata comes from the GitHub REST API and is cached.

import { toCommandList } from '../core/parser.js';
import { registerCommand } from '../core/commands.js';
import { EMULATORS } from './plugins/index.js';

const META_KEY = 'ctmux:tpm:meta';
const META_TTL = 24 * 3600 * 1000;

/** Normalise a plugin spec ('owner/repo', GitHub URL, git@ URL, optional #branch). */
export function parsePluginSpec(spec) {
  let s = String(spec || '').trim();
  if (!s) return null;
  let branch = null;
  const hash = s.lastIndexOf('#');
  if (hash > 0) { branch = s.slice(hash + 1); s = s.slice(0, hash); }
  let m;
  if ((m = /^(?:https?:\/\/|git:\/\/)(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s)) ||
      (m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(s)) ||
      (m = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s))) {
    return { repo: `${m[1]}/${m[2]}`, owner: m[1], name: m[2], branch, host: 'github.com', spec };
  }
  if ((m = /^(?:https?|git):\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(s))) {
    const parts = m[2].split('/');
    return { repo: m[2], owner: parts[0], name: parts[parts.length - 1], branch, host: m[1], spec };
  }
  return { repo: s, owner: '', name: s, branch, host: null, spec };
}

export class Tpm {
  constructor(t, { storage, fetchImpl, timers } = {}) {
    this.t = t;
    this.storage = storage || memoryStorage();
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    // Wrapped: browsers throw "Illegal invocation" if these are called with another `this`.
    this.timers = timers || {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    };
    this.declared = new Map();
    this.applied = new Map();
    this.ranTpm = false;
    this.intervals = [];
    this.meta = {};
    this.startupHooks = [];
    t.plugins = this;
  }

  declare(value, ctx = {}, legacyList = false) {
    const specs = legacyList ? String(value).split(/\s+/).filter(Boolean) : [value];
    for (const spec of specs) {
      const p = parsePluginSpec(spec);
      if (!p) continue;
      const key = p.repo.toLowerCase();
      if (!this.declared.has(key)) this.declared.set(key, { ...p, source: ctx.source, line: ctx.line });
    }
  }

  isActive(repo) { return this.applied.has(repo.toLowerCase()); }

  /** run-shell interception. Returns true when handled. */
  async handleRun(cmd) {
    const c = cmd.trim().replace(/^['"]|['"]$/g, '');
    if (/(^|\/)tpm(\/tpm)?\s*$/.test(c) || /plugins\/tpm\/tpm/.test(c)) {
      this.ranTpm = true;
      this.initialize();
      return true;
    }
    if (/resurrect\/scripts\/save\.sh/.test(c)) { await this.t.runString('resurrect-save'); return true; }
    if (/resurrect\/scripts\/restore\.sh/.test(c)) { await this.t.runString('resurrect-restore'); return true; }
    return false;
  }

  /** Apply all declared plugins (TPM's `run tpm`). Safe to call again on re-source. */
  initialize() {
    this.intervals.forEach((h) => this.timers.clearInterval(h));
    this.intervals = [];
    this.applied.clear();
    this.startupHooks = [];
    for (const [key, p] of this.declared) {
      const emu = EMULATORS.find((e) => e.repo.toLowerCase() === key || (e.aliases || []).some((a) => a.toLowerCase() === key));
      if (!emu) {
        const opts = this.unclaimedOptions().filter((o) => this.guessOwner(o, p));
        this.t.notice(
          `unknown plugin ${p.repo}: no JS emulator; ${opts.length ? `its options (${opts.join(', ')}) are stored but unused` : 'it has no effect'}`,
          { source: p.source, line: p.line, level: 'warn', key: 'plugin:' + key },
        );
        continue;
      }
      try {
        emu.apply(this.t, this.api(emu));
        this.applied.set(key, emu);
      } catch (err) {
        this.t.notice(`plugin ${p.repo} failed: ${err.message || err}`, { source: p.source, line: p.line, level: 'error' });
      }
    }
    this.t.ui.keysChanged?.();
  }

  /** Called after the main config was sourced. */
  finish() {
    if (!this.declared.size || this.ranTpm) return;
    this.t.notice("plugins declared but no `run '~/.tmux/plugins/tpm/tpm'` line; applying them anyway", { level: 'info' });
    this.initialize();
  }

  api(emu) {
    const t = this.t;
    const origin = `plugin:${emu.repo}`;
    return {
      option: (name, fallback = '') => {
        const v = t.options[name];
        return v == null || v === '' ? fallback : v;
      },
      set: (name, value) => t.setOption(name, value, origin),
      setDefault: (name, value) => t.setDefaultOption(name, value, origin),
      bind: (table, key, command, opts = {}) => {
        if (!key) return;
        t.bind(table, key, toCommandList(command, t.env), { ...opts, origin });
      },
      unbind: (table, key) => t.unbind(table, key),
      formatVar: (name, fn) => t.formatVars.set(name, fn),
      shellVar: (re, fn) => t.shellVars.set(re, fn),
      command: (def) => registerCommand(def),
      every: (ms, fn) => {
        const h = this.timers.setInterval(fn, ms);
        this.intervals.push(h);
        return h;
      },
      onStartup: (fn) => this.startupHooks.push(fn),
      storage: this.storage,
      fetch: this.fetch,
      notice: (msg, level = 'info') => t.notice(`${emu.repo}: ${msg}`, { level, key: `${emu.repo}:${msg}` }),
      refresh: () => t.server.changed('plugin'),
    };
  }

  async runStartup(ctx) {
    for (const fn of this.startupHooks) {
      try { await fn(ctx); } catch (err) { this.t.log(`startup hook failed: ${err.message || err}`, 'error'); }
    }
  }

  /** @options not claimed by any applied emulator (nor chrome-tmux itself). */
  unclaimedOptions() {
    const claimed = [...this.applied.values()].flatMap((e) => e.optionPrefixes || []);
    return Object.keys(this.t.options).filter((o) =>
      o[0] === '@' && o !== '@plugin' && o !== '@tpm_plugins' && !o.startsWith('@ctmux-') &&
      !claimed.some((p) => o.startsWith(p)));
  }

  guessOwner(option, plugin) {
    const o = option.slice(1).toLowerCase();
    const name = plugin.name.toLowerCase().replace(/^tmux-/, '').replace(/[-_.]?tmux$/, '');
    const owner = (plugin.owner || '').toLowerCase();
    return (name && o.startsWith(name)) || (owner && o.startsWith(owner));
  }

  /** Plugin rows for the debug panel. */
  report() {
    return [...this.declared.entries()].map(([key, p]) => {
      const emu = this.applied.get(key);
      const known = EMULATORS.find((e) => e.repo.toLowerCase() === key || (e.aliases || []).some((a) => a.toLowerCase() === key));
      return {
        repo: p.repo,
        spec: p.spec,
        branch: p.branch,
        source: p.source,
        line: p.line,
        status: emu ? 'emulated' : known ? 'not applied' : 'unknown',
        description: (emu || known)?.description || '',
        options: Object.keys(this.t.options).filter((o) =>
          (emu || known) ? (emu || known).optionPrefixes?.some((pre) => o.startsWith(pre)) : this.guessOwner(o, p)),
        meta: this.meta[p.repo.toLowerCase()] || null,
      };
    });
  }

  async loadMetaCache() {
    try {
      this.meta = (await this.storage.get(META_KEY)) || {};
    } catch { this.meta = {}; }
    return this.meta;
  }

  /** Fetch repository metadata from the GitHub API (cached for a day unless forced). */
  async fetchMetadata({ force = false } = {}) {
    await this.loadMetaCache();
    const results = [];
    for (const p of this.declared.values()) {
      if (p.host !== 'github.com') continue;
      const key = p.repo.toLowerCase();
      const cached = this.meta[key];
      if (!force && cached && Date.now() - cached.fetchedAt < META_TTL) { results.push(cached); continue; }
      try {
        const res = await this.fetch(`https://api.github.com/repos/${p.owner}/${p.name}`, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (res.status === 403 || res.status === 429) {
          this.t.log('GitHub API rate limit reached; using cached plugin metadata', 'warn');
          break;
        }
        if (!res.ok) {
          this.meta[key] = { error: `HTTP ${res.status}`, fetchedAt: Date.now() };
        } else {
          const j = await res.json();
          this.meta[key] = {
            fullName: j.full_name, description: j.description, stars: j.stargazers_count,
            defaultBranch: j.default_branch, url: j.html_url, pushedAt: j.pushed_at,
            license: j.license?.spdx_id || null, archived: !!j.archived, fetchedAt: Date.now(),
          };
        }
        results.push(this.meta[key]);
      } catch (err) {
        this.meta[key] = { error: String(err.message || err), fetchedAt: Date.now() };
      }
    }
    await this.storage.set(META_KEY, this.meta);
    return results;
  }

  async clearMetadata() {
    this.meta = {};
    await this.storage.set(META_KEY, {});
  }
}

export function memoryStorage() {
  const m = new Map();
  return {
    async get(k) { return m.get(k); },
    async set(k, v) { m.set(k, v); },
    async remove(k) { m.delete(k); },
  };
}
