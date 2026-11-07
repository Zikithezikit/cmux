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
import type { CommandContext, Flags, KeyValueStorage, LogLevel } from '../core/types.js';
import type { Tmux, FormatVarFn, ShellVarFn, BindOptions } from '../core/tmux.js';

/** Opaque handle from `TpmTimers.setInterval`; only ever passed back to `clearInterval`. */
export type IntervalHandle = unknown;

/** The timer functions TPM uses (injectable so tests and the options page can stub them). */
export interface TpmTimers {
  setInterval(fn: () => unknown, ms: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

/** The parts of a fetch `Response` TPM and the plugin emulators read. */
export interface TpmResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type TpmFetch = (input: string, init?: RequestInit) => Promise<TpmResponse>;

export interface TpmOptions {
  storage?: KeyValueStorage;
  fetchImpl?: TpmFetch;
  timers?: TpmTimers;
}

/** A parsed `@plugin` spec. */
export interface PluginSpec {
  repo: string;
  owner: string;
  name: string;
  branch: string | null;
  host: string | null;
  spec: string;
}

export interface DeclaredPlugin extends PluginSpec {
  source?: string;
  line?: number;
}

/** Cached GitHub repository metadata (or the error from fetching it). */
export interface PluginMeta {
  fullName?: string;
  description?: string | null;
  stars?: number;
  defaultBranch?: string;
  url?: string;
  pushedAt?: string;
  license?: string | null;
  archived?: boolean;
  error?: string;
  fetchedAt: number;
}

export type PluginStatus = 'emulated' | 'not applied' | 'unknown';

/** A row of the debug panel's plugin table. */
export interface PluginReportRow {
  repo: string;
  spec: string;
  branch: string | null;
  source?: string;
  line?: number;
  status: PluginStatus;
  description: string;
  options: string[];
  meta: PluginMeta | null;
}

export interface StartupContext {
  hadLiveState?: boolean;
}

export type StartupHook = (ctx: StartupContext) => unknown;

/** A command registered by a plugin emulator. */
export interface PluginCommand {
  name: string;
  flags: string;
  alias?: string | string[];
  run(t: Tmux, flags: Flags, args: string[], ctx: CommandContext): unknown;
}

/** The API object TPM passes to each emulator's `apply`. */
export interface PluginApi {
  option(name: string, fallback?: string): string;
  set(name: string, value: unknown): void;
  setDefault(name: string, value: unknown): boolean;
  bind(table: string, key: string, command: string, opts?: BindOptions): void;
  unbind(table: string, key: string): void;
  formatVar(name: string, fn: FormatVarFn): void;
  shellVar(re: RegExp, fn: ShellVarFn): void;
  command(def: PluginCommand): void;
  every(ms: number, fn: () => unknown): IntervalHandle;
  onStartup(fn: StartupHook): void;
  storage: KeyValueStorage;
  fetch: TpmFetch;
  notice(msg: string, level?: LogLevel): void;
  refresh: () => void;
  /** The plugin manager applying the emulator. */
  tpm: Tpm;
}

/** A built-in JS emulator of a TPM plugin (the default export of each plugins/*.ts). */
export interface PluginEmulator {
  repo: string;
  aliases?: readonly string[];
  description: string;
  optionPrefixes: readonly string[];
  apply(t: Tmux, api: PluginApi): void;
}

const META_KEY = 'ctmux:tpm:meta';
const META_TTL = 24 * 3600 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** `err.message`, or the stringified value when there is none. */
function errorMessage(err: unknown): string {
  const msg = isRecord(err) && typeof err.message === 'string' ? err.message : '';
  return msg || String(err);
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The fields of a GitHub `GET /repos/{owner}/{repo}` response kept in the cache. */
function parseRepoMeta(j: unknown): PluginMeta {
  if (!isRecord(j)) throw new TypeError('unexpected GitHub API response');
  const license = isRecord(j.license) ? j.license.spdx_id : undefined;
  return {
    fullName: optString(j.full_name),
    description: j.description === null ? null : optString(j.description),
    stars: typeof j.stargazers_count === 'number' ? j.stargazers_count : undefined,
    defaultBranch: optString(j.default_branch),
    url: optString(j.html_url),
    pushedAt: optString(j.pushed_at),
    license: optString(license) || null,
    archived: !!j.archived,
    fetchedAt: Date.now(),
  };
}

function findEmulator(key: string): PluginEmulator | undefined {
  return EMULATORS.find((e) => e.repo.toLowerCase() === key || (e.aliases || []).some((a) => a.toLowerCase() === key));
}

/** Normalise a plugin spec ('owner/repo', GitHub URL, git@ URL, optional #branch). */
export function parsePluginSpec(spec: string): PluginSpec | null {
  let s = String(spec || '').trim();
  if (!s) return null;
  let branch: string | null = null;
  const hash = s.lastIndexOf('#');
  if (hash > 0) { branch = s.slice(hash + 1); s = s.slice(0, hash); }
  let m: RegExpExecArray | null;
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
  declare readonly t: Tmux;
  declare readonly storage: KeyValueStorage;
  declare readonly fetch: TpmFetch;
  declare readonly timers: TpmTimers;
  declare readonly declared: Map<string, DeclaredPlugin>;
  declare readonly applied: Map<string, PluginEmulator>;
  declare ranTpm: boolean;
  declare intervals: IntervalHandle[];
  declare meta: Record<string, PluginMeta>;
  declare startupHooks: StartupHook[];

  constructor(t: Tmux, { storage, fetchImpl, timers }: TpmOptions = {}) {
    this.t = t;
    this.storage = storage || memoryStorage();
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    // Wrapped: browsers throw "Illegal invocation" if these are called with another `this`.
    // The handles clearInterval gets are always ones this setInterval returned.
    const nativeTimers = {
      setInterval: (fn: () => unknown, ms: number) => setInterval(fn, ms),
      clearInterval: (h: ReturnType<typeof setInterval>) => clearInterval(h),
    };
    this.timers = timers || nativeTimers;
    this.declared = new Map();
    this.applied = new Map();
    this.ranTpm = false;
    this.intervals = [];
    this.meta = {};
    this.startupHooks = [];
    t.plugins = this;
  }

  declare(value: string, ctx: CommandContext = {}, legacyList = false): void {
    const specs = legacyList ? String(value).split(/\s+/).filter(Boolean) : [value];
    for (const spec of specs) {
      const p = parsePluginSpec(spec);
      if (!p) continue;
      const key = p.repo.toLowerCase();
      if (!this.declared.has(key)) this.declared.set(key, { ...p, source: ctx.source, line: ctx.line });
    }
  }

  isActive(repo: string): boolean { return this.applied.has(repo.toLowerCase()); }

  /**
   * run-shell interception. Returns true when handled. run-shell passes its
   * command context, which the intercepted scripts don't need.
   */
  handleRun(cmd: string, ctx?: CommandContext): Promise<boolean>;
  async handleRun(cmd: string): Promise<boolean> {
    const c = cmd.trim().replace(/^['"]|['"]$/g, '');
    if (/(^|\/)tpm(\/tpm)?\s*$/.test(c) || c.includes('plugins/tpm/tpm')) {
      this.ranTpm = true;
      this.initialize();
      return true;
    }
    if (c.includes('resurrect/scripts/save.sh')) { await this.t.runString('resurrect-save'); return true; }
    if (c.includes('resurrect/scripts/restore.sh')) { await this.t.runString('resurrect-restore'); return true; }
    return false;
  }

  /** Apply all declared plugins (TPM's `run tpm`). Safe to call again on re-source. */
  initialize(): void {
    this.intervals.forEach((h) => this.timers.clearInterval(h));
    this.intervals = [];
    this.applied.clear();
    this.startupHooks = [];
    for (const [key, p] of this.declared) {
      const emu = findEmulator(key);
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
        this.t.notice(`plugin ${p.repo} failed: ${errorMessage(err)}`, { source: p.source, line: p.line, level: 'error' });
      }
    }
    this.t.ui.keysChanged();
  }

  /** Called after the main config was sourced. */
  finish(): void {
    if (!this.declared.size || this.ranTpm) return;
    this.t.notice("plugins declared but no `run '~/.tmux/plugins/tpm/tpm'` line; applying them anyway", { level: 'info' });
    this.initialize();
  }

  api(emu: PluginEmulator): PluginApi {
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
      tpm: this,
    };
  }

  async runStartup(ctx: StartupContext): Promise<void> {
    for (const fn of this.startupHooks) {
      try { await fn(ctx); } catch (err) { this.t.log(`startup hook failed: ${errorMessage(err)}`, 'error'); }
    }
  }

  /** @options not claimed by any applied emulator (nor chrome-tmux itself). */
  unclaimedOptions(): string[] {
    const claimed = [...this.applied.values()].flatMap((e) => e.optionPrefixes);
    return Object.keys(this.t.options).filter((o) =>
      o.startsWith('@') && o !== '@plugin' && o !== '@tpm_plugins' && !o.startsWith('@ctmux-') &&
      !claimed.some((p) => o.startsWith(p)));
  }

  guessOwner(option: string, plugin: PluginSpec): boolean {
    const o = option.slice(1).toLowerCase();
    const name = plugin.name.toLowerCase().replace(/^tmux-/, '').replace(/[-_.]?tmux$/, '');
    const owner = (plugin.owner || '').toLowerCase();
    return (!!name && o.startsWith(name)) || (!!owner && o.startsWith(owner));
  }

  /** Plugin rows for the debug panel. */
  report(): PluginReportRow[] {
    return [...this.declared.entries()].map(([key, p]) => {
      const emu = this.applied.get(key);
      const known = findEmulator(key);
      const def = emu || known;
      return {
        repo: p.repo,
        spec: p.spec,
        branch: p.branch,
        source: p.source,
        line: p.line,
        status: emu ? 'emulated' : known ? 'not applied' : 'unknown',
        description: def?.description || '',
        options: Object.keys(this.t.options).filter((o) =>
          def ? def.optionPrefixes.some((pre) => o.startsWith(pre)) : this.guessOwner(o, p)),
        meta: this.meta[p.repo.toLowerCase()] || null,
      };
    });
  }

  async loadMetaCache(): Promise<Record<string, PluginMeta>> {
    try {
      this.meta = (await this.storage.get<Record<string, PluginMeta>>(META_KEY)) || {};
    } catch { this.meta = {}; }
    return this.meta;
  }

  /** Fetch repository metadata from the GitHub API (cached for a day unless forced). */
  async fetchMetadata({ force = false }: { force?: boolean } = {}): Promise<PluginMeta[]> {
    await this.loadMetaCache();
    const results: PluginMeta[] = [];
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
          this.meta[key] = parseRepoMeta(await res.json());
        }
        results.push(this.meta[key]);
      } catch (err) {
        this.meta[key] = { error: errorMessage(err), fetchedAt: Date.now() };
      }
    }
    await this.storage.set(META_KEY, this.meta);
    return results;
  }

  async clearMetadata(): Promise<void> {
    this.meta = {};
    await this.storage.set(META_KEY, {});
  }
}

export function memoryStorage(): KeyValueStorage {
  const m = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return m.get(k) as T | undefined; },
    async set(k, v) { m.set(k, v); },
    async remove(k) { m.delete(k); },
  };
}
