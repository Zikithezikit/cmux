// Regression tests for src/core/parser.ts, src/core/target.ts and src/core/shell.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, BlockArg } from '../src/core/parser.js';
import { resolveTarget } from '../src/core/target.js';
import { runShell, Unsupported } from '../src/core/shell.js';
import type { TargetServer } from '../src/core/target.js';
import type { LayoutNode, Session, Window } from '../src/core/types.js';

function makeWindow(id: number, index: number, name: string, layout: LayoutNode, active: number): Window {
  return { id, index, name, manualName: true, layout, active, last: null, zoomed: false, layoutName: null };
}

function makeServer(windows: Window[]): { server: TargetServer; session: Session } {
  const session: Session = { id: 0, name: 'main', windows, active: windows[0]?.id ?? null, last: null, created: 0 };
  const server: TargetServer = {
    session,
    sessions: [session],
    lastSessionId: null,
    sessionById: (id) => (id === session.id ? session : null),
    sessionByName: (name) => (name === session.name ? session : null),
    sortedWindows: (s) => s.windows.slice().sort((a, b) => a.index - b.index),
    activeWindow: (s) => s.windows.find((w) => w.id === s.active) ?? null,
    windowName: (w) => w.name,
    getOption: () => undefined,
    locate: () => null,
    windowById: () => null,
  };
  return { server, session };
}

test('tokenize: %hidden followed by a { } block is an ordinary command, not an assignment', () => {
  const env: Record<string, string> = {};
  const r = tokenize('%hidden { x=1 }\n%hidden foo\n%hidden Y=2\n', env);
  assert.deepEqual(r.errors, []);
  assert.equal(r.commands.length, 3);
  const [block, word, assign] = r.commands;
  assert.equal(block.args[0], '%hidden');
  assert.ok(block.args[1] instanceof BlockArg);
  assert.equal(block.assign, undefined);
  assert.deepEqual(word.args, ['%hidden', 'foo'], 'same handling as other malformed %hidden lines');
  assert.deepEqual(assign.args, []);
  assert.equal(assign.assign, 'Y');
  assert.deepEqual(env, { Y: '2' });
});

test('resolveTarget: edge tokens on a window without panes resolve to nothing', () => {
  const empty: LayoutNode = { type: 'split', dir: 'h', children: [], sizes: [] };
  const { server } = makeServer([makeWindow(1, 0, 'w', empty, 0)]);
  for (const edge of ['{top}', '{bottom}', '{left}', '{right}', '{top-left}', '{bottom-right}']) {
    assert.equal(resolveTarget(server, ':.' + edge, 'pane'), null, edge);
    assert.equal(resolveTarget(server, edge, 'pane'), null, edge);
  }
});

test('resolveTarget: Object.prototype names are not pane direction/edge tokens', () => {
  const pane = (id: number): LayoutNode => ({ type: 'pane', id });
  const { server } = makeServer([makeWindow(1, 0, 'first', pane(1), 1), makeWindow(2, 1, 'toString', pane(2), 2)]);
  const r = resolveTarget(server, 'toString', 'pane');
  assert.ok(r);
  assert.equal(r.window.name, 'toString');
  assert.equal(r.pane, 2);
});

test('shell: Object.prototype names are not builtins', async () => {
  const host = { tmux: () => Promise.resolve({ code: 0, out: '' }) };
  await assert.rejects(runShell('constructor', host), Unsupported);
  await assert.rejects(runShell('toString', host), Unsupported);
  assert.deepEqual(await runShell('echo ok', host), { code: 0, out: 'ok\n' });
});
