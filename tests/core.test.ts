import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/shared/keys.js';
import { tokenize, toCommandList, parseArgs } from '../src/core/parser.js';
import { expandFormat, toRuns, strftime, colourToCss, truncateRuns } from '../src/core/format.js';
import * as L from '../src/core/layout.js';
import { toUrl } from '../src/core/commands.js';
import type { LayoutNode, LayoutRects, SplitNode } from '../src/core/types.js';

const { normalizeKey, createRouter } = globalThis.CtmuxKeys;

test('normalizeKey canonicalises tmux key names', () => {
  assert.equal(normalizeKey('C-s'), 'C-s');
  assert.equal(normalizeKey('C-S'), 'C-s');
  assert.equal(normalizeKey('^A'), 'C-a');
  assert.equal(normalizeKey('M-C-x'), 'C-M-x');
  assert.equal(normalizeKey('S-a'), 'A');
  assert.equal(normalizeKey('C-\\ '), 'C-\\');
  assert.equal(normalizeKey('pageup'), 'PPage');
  assert.equal(normalizeKey('S-Tab'), 'BTab');
  assert.equal(normalizeKey('M--'), 'M--');
  assert.equal(normalizeKey('None'), null);
  assert.equal(normalizeKey('%'), '%');
});

test('router: prefix, prefix table, repeat, root bindings', () => {
  let now = 0;
  const cfg = { prefix: 'C-s', tables: { root: ['C-h'], prefix: ['%', 'H'] }, repeat: { prefix: ['H'] }, repeatTime: 500 };
  const r = createRouter(() => cfg, () => now);
  assert.equal(r.feed('x'), null);
  assert.deepEqual(r.feed('C-h'), { table: 'root', key: 'C-h' });
  assert.deepEqual(r.feed('C-s'), { table: 'root', key: 'C-s', prefix: true });
  assert.deepEqual(r.feed('%'), { table: 'prefix', key: '%' });
  assert.equal(r.table, 'root');
  r.feed('C-s');
  assert.deepEqual(r.feed('H'), { table: 'prefix', key: 'H' });
  now = 100;
  assert.deepEqual(r.feed('H'), { table: 'prefix', key: 'H' }, 'repeatable within repeat-time');
  now = 200;
  assert.equal(r.feed('x'), null, 'non-repeat key falls back to root');
  r.feed('C-s');
  assert.deepEqual(r.feed('z'), { table: 'prefix', key: 'z' }, 'unbound prefix keys are swallowed');
});

test('tokenizer: quoting, escapes, continuation, separators, blocks, variables', () => {
  const { commands, env } = tokenize(String.raw`
pat='a(\S+)b'   # comment
is_vim="ps -t '#{pane_tty}' \
    | grep \"\$x\" ${'${pat}'}"
bind x display hi \; display there
set -g status-left "#{session_name}" ; set -g mouse on
bind y {
  split-window -h
  display "split; done"
}
`);
  assert.equal((env as Record<string, string>).pat, 'a(\\S+)b');
  assert.equal((env as Record<string, string>).is_vim, "ps -t '#{pane_tty}'     | grep \"$x\" a(\\S+)b");
  const cmds = commands.filter((c) => c.args.length);
  assert.deepEqual(cmds[0].args, ['bind', 'x', 'display', 'hi', ';', 'display', 'there']);
  assert.deepEqual(cmds[1].args, ['set', '-g', 'status-left', '#{session_name}']);
  assert.deepEqual(cmds[2].args, ['set', '-g', 'mouse', 'on']);
  assert.equal(cmds[3].args[0], 'bind');
  assert.deepEqual(toCommandList(cmds[3].args[2]), [['split-window', '-h'], ['display', 'split; done']]);
  assert.deepEqual(toCommandList(cmds[0].args.slice(2)), [['display', 'hi'], ['display', 'there']]);
  assert.equal(cmds[3].line, 7);
});

test('parseArgs handles combined, attached and valued flags', () => {
  const p = parseArgs(['-gq', '-t2', '-p', '30', '--', '-x'], 'gqt:p:');
  assert.deepEqual(p.flags, { g: true, q: true, t: '2', p: '30' });
  assert.deepEqual(p.args, ['-x']);
  assert.deepEqual(parseArgs(['-L', '5'], 'LR').args, ['5']);
});

test('formats: variables, conditionals, comparisons, truncation, styles', () => {
  const vars: Record<string, string> = { session_name: 'main', window_index: '1', client_prefix: '1', pane_title: 'A very long page title here' };
  const look = (n: string) => vars[n];
  assert.equal(expandFormat('[#S] #I', look), '[main] 1');
  assert.equal(expandFormat('#{?client_prefix,P,-}', look), 'P');
  assert.equal(expandFormat('#{?#{==:#{session_name},main},yes,no}', look), 'yes');
  assert.equal(expandFormat('#{=6:pane_title}', look), 'A very');
  assert.equal(expandFormat('#{=-5:pane_title}', look), ' here');
  assert.equal(expandFormat('#{?client_prefix,#[bg=yellow],}x', look), '#[bg=yellow]x');
  assert.equal(expandFormat('a#,b ##', look), 'a,b ##');
  assert.equal(expandFormat('#{e|+|:2,3}', look), '5');
  const runs = toRuns('#[fg=red]a#[default]b##', { fg: null, bg: '#000', attrs: {} });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].style.fg, colourToCss('red'));
  assert.equal(runs[1].text, 'b#');
  assert.equal(runs[1].style.bg, '#000');
  assert.equal(truncateRuns(runs, 2).map((r: { text: string }) => r.text).join(''), 'ab');
  assert.equal(colourToCss('colour231'), '#ffffff');
  assert.equal(colourToCss('#ABCDEF'), '#abcdef');
  assert.equal(strftime('%H:%M %d-%b-%y', new Date(2026, 9, 22, 7, 5)), '07:05 22-Oct-26');
});

test('layout: split, remove, rects, neighbours, resize, presets', () => {
  let t = L.leaf(1) as LayoutNode;
  t = L.splitPane(t, 1, 2, 'h');
  t = L.splitPane(t, 2, 3, 'v');
  assert.deepEqual(L.panesInOrder(t), [1, 2, 3]);
  const area = { x: 0, y: 0, w: 1001, h: 601 };
  const { panes, dividers }: LayoutRects = L.computeRects(t, area, 1);
  assert.deepEqual(panes[1], { x: 0, y: 0, w: 500, h: 601 });
  assert.equal(panes[2].x, 501);
  assert.equal(dividers.length, 2);
  assert.equal(L.neighbour(panes, 1, 'R'), 2);
  assert.equal(L.neighbour(panes, 3, 'U'), 2);
  assert.equal(L.neighbour(panes, 3, 'L'), 1);
  assert.equal(L.neighbour(panes, 1, 'L'), 2, 'wraps around');

  const r = L.resizePane(t, 1, 'R', 100, area, 1);
  assert.ok(L.computeRects(r, area, 1).panes[1].w > 590);
  const r2 = L.resizePane(t, 2, 'L', 100, area, 1);
  assert.ok(L.computeRects(r2, area, 1).panes[2].w > 590, 'last child moves its left border');

  t = L.removePane(t, 2)!;
  assert.deepEqual(L.panesInOrder(t), [1, 3]);
  assert.equal((t as SplitNode).dir, 'h');
  assert.equal(L.removePane(L.leaf(1), 1), null);

  const tiled = L.presetLayout('tiled', [1, 2, 3, 4, 5]);
  assert.equal((tiled as SplitNode).children.length, 2);
  const mv = L.presetLayout('main-vertical', [1, 2, 3], 0.6);
  assert.equal((mv as SplitNode).dir, 'h');
  assert.deepEqual(L.panesInOrder(L.rotate(L.presetLayout('even-horizontal', [1, 2, 3])!)), [3, 1, 2]);
});

test('toUrl understands URLs, hosts, paths and search terms', () => {
  assert.equal(toUrl('https://x.dev/a'), 'https://x.dev/a');
  assert.equal(toUrl('github.com/tmux'), 'https://github.com/tmux');
  assert.equal(toUrl('localhost:3000'), 'http://localhost:3000');
  assert.equal(toUrl('/home/me/notes.html'), 'file:///home/me/notes.html');
  assert.equal(toUrl('tmux split window', 'https://s/?q=%s'), 'https://s/?q=tmux%20split%20window');
  assert.equal(toUrl('javascript:alert(1)'), '');
});
