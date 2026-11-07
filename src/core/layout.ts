// Pane layout trees.
//
// A node is either { type: 'pane', id } or
// { type: 'split', dir: 'h' | 'v', children: [node], sizes: [fraction] }.
// dir 'h' lays children out left-to-right (tmux `split-window -h`),
// dir 'v' top-to-bottom (tmux `split-window -v`). Trees are treated as
// immutable values: every operation returns a new tree.

import type { Direction, Divider, LayoutNode, LayoutRects, PaneNode, Rect, SplitDir, SplitNode } from './types.js';

/** Options for splitPane. */
export interface SplitOptions {
  before?: boolean;
  /** Fraction of the target's space for the new pane. */
  size?: number;
  full?: boolean;
}

export const leaf = (id: number): PaneNode => ({ type: 'pane', id });

const clone = <T>(n: T): T => JSON.parse(JSON.stringify(n));

export function panesInOrder(node: LayoutNode | null | undefined, out: number[] = []): number[] {
  if (!node) return out;
  if (node.type === 'pane') out.push(node.id);
  else node.children.forEach((c) => panesInOrder(c, out));
  return out;
}

/** Path (array of child indexes) to the pane, or null. */
export function findPath(node: LayoutNode, id: number, path: number[] = []): number[] | null {
  if (node.type === 'pane') return node.id === id ? path : null;
  for (let i = 0; i < node.children.length; i++) {
    const p = findPath(node.children[i], id, path.concat(i));
    if (p) return p;
  }
  return null;
}

function at(node: LayoutNode, path: number[]): LayoutNode {
  for (const i of path) node = (node as SplitNode).children[i];
  return node;
}

function normalize(node: LayoutNode): LayoutNode {
  if (node.type === 'pane') return node;
  let children: LayoutNode[] = [];
  let sizes: number[] = [];
  node.children.forEach((c, i) => {
    c = normalize(c);
    const s = node.sizes[i];
    if (c.type === 'split' && c.dir === node.dir) {
      c.children.forEach((cc, j) => { children.push(cc); sizes.push(s * c.sizes[j]); });
    } else {
      children.push(c);
      sizes.push(s);
    }
  });
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  sizes = sizes.map((s) => s / total);
  return { type: 'split', dir: node.dir, children, sizes };
}

/**
 * Split `targetId`, inserting pane `newId`.
 * opts: { before: bool, size: fraction of the target's space for the new pane, full: bool }
 */
export function splitPane(tree: LayoutNode | null | undefined, targetId: number, newId: number, dir: SplitDir, opts: SplitOptions = {}): LayoutNode {
  const frac = Math.min(0.95, Math.max(0.05, opts.size ?? 0.5));
  const before = !!opts.before;
  if (!tree) return leaf(newId);
  if (opts.full) {
    const root = clone(tree);
    const children = before ? [leaf(newId), root] : [root, leaf(newId)];
    const sizes = before ? [frac, 1 - frac] : [1 - frac, frac];
    return normalize({ type: 'split', dir, children, sizes });
  }
  const t = clone(tree);
  const path = findPath(t, targetId);
  if (!path) throw new Error(`no pane ${targetId}`);
  if (path.length) {
    const parent = at(t, path.slice(0, -1)) as SplitNode;
    const idx = path[path.length - 1];
    if (parent.dir === dir) {
      const s = parent.sizes[idx];
      parent.children.splice(before ? idx : idx + 1, 0, leaf(newId));
      parent.sizes.splice(idx, 1, ...(before ? [s * frac, s * (1 - frac)] : [s * (1 - frac), s * frac]));
      return t;
    }
    const node: SplitNode = {
      type: 'split', dir,
      children: before ? [leaf(newId), leaf(targetId)] : [leaf(targetId), leaf(newId)],
      sizes: before ? [frac, 1 - frac] : [1 - frac, frac],
    };
    parent.children[idx] = node;
    return t;
  }
  return {
    type: 'split', dir,
    children: before ? [leaf(newId), t] : [t, leaf(newId)],
    sizes: before ? [frac, 1 - frac] : [1 - frac, frac],
  };
}

/** Remove a pane; its space goes to the neighbouring sibling. Returns null if the tree is empty. */
export function removePane(tree: LayoutNode | null | undefined, id: number): LayoutNode | null {
  if (!tree) return null;
  if (tree.type === 'pane') return tree.id === id ? null : tree;
  const t = clone(tree);
  const path = findPath(t, id);
  if (!path) return t;
  const parent = at(t, path.slice(0, -1)) as SplitNode;
  const idx = path[path.length - 1];
  const s = parent.sizes[idx];
  parent.children.splice(idx, 1);
  parent.sizes.splice(idx, 1);
  const neighbour = idx > 0 ? idx - 1 : 0;
  if (parent.sizes.length) parent.sizes[neighbour] += s;
  return normalize(t);
}

export function replacePane(tree: LayoutNode, oldId: number, newId: number): LayoutNode {
  const t = clone(tree);
  const walk = (n: LayoutNode): void => {
    if (n.type === 'pane') { if (n.id === oldId) n.id = newId; }
    else n.children.forEach(walk);
  };
  walk(t);
  return t;
}

export function swapPanes(tree: LayoutNode, a: number, b: number): LayoutNode {
  const t = clone(tree);
  const walk = (n: LayoutNode): void => {
    if (n.type === 'pane') n.id = n.id === a ? b : n.id === b ? a : n.id;
    else n.children.forEach(walk);
  };
  walk(t);
  return t;
}

/** Rotate pane positions (rotate-window). `up` moves every pane to the previous slot. */
export function rotate(tree: LayoutNode, up = false): LayoutNode {
  const ids = panesInOrder(tree);
  if (ids.length < 2) return tree;
  const rotated = up ? ids.slice(1).concat(ids[0]) : [ids[ids.length - 1]].concat(ids.slice(0, -1));
  const t = clone(tree);
  let k = 0;
  const walk = (n: LayoutNode): void => {
    if (n.type === 'pane') n.id = rotated[k++];
    else n.children.forEach(walk);
  };
  walk(t);
  return t;
}

/**
 * Compute pixel rectangles.
 * Returns { panes: {id: rect}, dividers: [{ path, index, dir, rect, split }] }
 * where `split` is the rect of the split node the divider belongs to.
 */
export function computeRects(tree: LayoutNode | null | undefined, rect: Rect, gap = 1): LayoutRects {
  const panes: Record<number, Rect> = {};
  const dividers: Divider[] = [];
  const walk = (node: LayoutNode, r: Rect, path: number[]): void => {
    if (node.type === 'pane') { panes[node.id] = r; return; }
    const horiz = node.dir === 'h';
    const n = node.children.length;
    const total = horiz ? r.w : r.h;
    const avail = Math.max(0, total - gap * (n - 1));
    let acc = 0;
    let pos = horiz ? r.x : r.y;
    for (let i = 0; i < n; i++) {
      acc += node.sizes[i];
      const end = i === n - 1 ? (horiz ? r.x + r.w : r.y + r.h) : Math.round((horiz ? r.x : r.y) + avail * acc + gap * i);
      const size = Math.max(0, end - pos);
      const cr = horiz ? { x: pos, y: r.y, w: size, h: r.h } : { x: r.x, y: pos, w: r.w, h: size };
      walk(node.children[i], cr, path.concat(i));
      pos = end;
      if (i < n - 1) {
        dividers.push({
          path, index: i + 1, dir: node.dir, split: r,
          rect: horiz ? { x: pos, y: r.y, w: gap, h: r.h } : { x: r.x, y: pos, w: r.w, h: gap },
        });
        pos += gap;
      }
    }
  };
  if (tree) walk(tree, rect, []);
  return { panes, dividers };
}

const overlap = (a0: number, a1: number, b0: number, b1: number): number => Math.min(a1, b1) - Math.max(a0, b0);

interface NeighbourCandidate {
  k: string;
  r: Rect;
  ov: number;
  dist: number;
}

/** Find the pane in direction L/R/U/D from `id` (wrapping like tmux). */
export function neighbour(rects: Record<number, Rect>, id: number, dir: Direction, wrap = true): number | null {
  const cur = rects[id];
  if (!cur) return null;
  const horiz = dir === 'L' || dir === 'R';
  const cands: NeighbourCandidate[] = [];
  for (const [k, r] of Object.entries(rects)) {
    if (String(k) === String(id)) continue;
    const ov = horiz ? overlap(cur.y, cur.y + cur.h, r.y, r.y + r.h) : overlap(cur.x, cur.x + cur.w, r.x, r.x + r.w);
    if (ov <= 0) continue;
    let dist: number;
    if (dir === 'L') dist = cur.x - (r.x + r.w);
    else if (dir === 'R') dist = r.x - (cur.x + cur.w);
    else if (dir === 'U') dist = cur.y - (r.y + r.h);
    else dist = r.y - (cur.y + cur.h);
    cands.push({ k, r, ov, dist });
  }
  const pick = (list: NeighbourCandidate[], far: boolean): string | null => {
    if (!list.length) return null;
    list.sort((a, b) => (far ? b.dist - a.dist : a.dist - b.dist) || b.ov - a.ov);
    // Prefer a pane containing the current pane's top/left edge (tmux uses
    // the cursor position; the edge is a stable stand-in).
    const best = list.filter((c) => Math.abs(c.dist - list[0].dist) < 2);
    const edge = horiz ? cur.y : cur.x;
    const hit = best.find((c) => (horiz ? c.r.y <= edge && edge < c.r.y + c.r.h : c.r.x <= edge && edge < c.r.x + c.r.w));
    return (hit || best[0]).k;
  };
  const ahead = cands.filter((c) => c.dist >= -1);
  const found = pick(ahead, false);
  if (found != null) return castId(found, id);
  if (!wrap) return null;
  const behind = cands.filter((c) => c.dist < -1);
  const w = pick(behind, true);
  return w == null ? null : castId(w, id);
}

const castId = <T extends number | string>(k: string, like: T): T => (typeof like === 'number' ? Number(k) : k) as T;

function splitPixelSize(tree: LayoutNode, path: number[], rect: Rect, gap: number): number {
  // Size in px available to the children of the split at `path`.
  let r = rect;
  let node = tree as SplitNode;
  for (const idx of path) {
    const horiz = node.dir === 'h';
    const n = node.children.length;
    const total = horiz ? r.w : r.h;
    const avail = total - gap * (n - 1);
    let start = 0;
    for (let i = 0; i < idx; i++) start += node.sizes[i];
    const size = avail * node.sizes[idx];
    const offset = avail * start + gap * idx;
    r = horiz ? { x: r.x + offset, y: r.y, w: size, h: r.h } : { x: r.x, y: r.y + offset, w: r.w, h: size };
    node = node.children[idx] as SplitNode;
  }
  const horiz = node.dir === 'h';
  return (horiz ? r.w : r.h) - gap * (node.children.length - 1);
}

/** Move the boundary before child `index` of the split at `path` by `deltaPx`. */
export function moveDivider(tree: LayoutNode, path: number[], index: number, deltaPx: number, rect: Rect, gap = 1, minPx = 24): LayoutNode {
  const t = clone(tree);
  const node = at(t, path) as SplitNode;
  const avail = splitPixelSize(t, path, rect, gap);
  if (avail <= 0) return t;
  const a = index - 1, b = index;
  let d = deltaPx / avail;
  const min = Math.min(minPx / avail, 0.45);
  d = Math.max(min - node.sizes[a], Math.min(node.sizes[b] - min, d));
  node.sizes[a] += d;
  node.sizes[b] -= d;
  return t;
}

/** Place the boundary before child `index` at absolute pixel position `pos`. */
export function setDivider(tree: LayoutNode, path: number[], index: number, pos: number, rect: Rect, gap = 1, minPx = 24): LayoutNode {
  const { dividers } = computeRects(tree, rect, gap);
  const key = path.join('.');
  const div = dividers.find((d) => d.path.join('.') === key && d.index === index);
  if (!div) return tree;
  const cur = div.dir === 'h' ? div.rect.x : div.rect.y;
  return moveDivider(tree, path, index, pos - cur, rect, gap, minPx);
}

/** tmux resize-pane -L/-R/-U/-D semantics: move the nearest suitable border. */
export function resizePane(tree: LayoutNode, id: number, dir: Direction, px: number, rect: Rect, gap = 1): LayoutNode {
  const path = findPath(tree, id);
  if (!path) return tree;
  const want = dir === 'L' || dir === 'R' ? 'h' : 'v';
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const parentPath = path.slice(0, depth);
    const node = at(tree, parentPath);
    if (node.type !== 'split' || node.dir !== want || node.children.length < 2) continue;
    const idx = path[depth];
    const index = idx < node.children.length - 1 ? idx + 1 : idx;
    const delta = dir === 'L' || dir === 'U' ? -px : px;
    return moveDivider(tree, parentPath, index, delta, rect, gap);
  }
  return tree;
}

/** Resize so the pane has an absolute width/height in px (resize-pane -x / -y). */
export function resizePaneTo(tree: LayoutNode, id: number, axis: 'x' | 'y', px: number, rect: Rect, gap = 1): LayoutNode {
  const { panes } = computeRects(tree, rect, gap);
  const cur = panes[id];
  if (!cur) return tree;
  const delta = px - (axis === 'x' ? cur.w : cur.h);
  return resizePane(tree, id, axis === 'x' ? 'R' : 'D', delta, rect, gap);
}

/** Make all children of every split equal (select-layout -E style spread). */
export function spread(tree: LayoutNode): LayoutNode {
  const t = clone(tree);
  const walk = (n: LayoutNode): void => {
    if (n.type === 'pane') return;
    n.sizes = n.children.map(() => 1 / n.children.length);
    n.children.forEach(walk);
  };
  walk(t);
  return t;
}

export const LAYOUTS = ['even-horizontal', 'even-vertical', 'main-horizontal', 'main-vertical', 'tiled'];

const even = (dir: SplitDir, ids: number[]): LayoutNode => (ids.length === 1 ? leaf(ids[0]) : {
  type: 'split', dir, children: ids.map(leaf), sizes: ids.map(() => 1 / ids.length),
});

/**
 * Build one of tmux's preset layouts from panes in order.
 * mainSize is the main pane fraction for main-* layouts.
 */
export function presetLayout(name: string, ids: number[], mainSize = 0.6): LayoutNode | null {
  if (!ids.length) return null;
  if (ids.length === 1) return leaf(ids[0]);
  switch (name) {
    case 'even-horizontal': return even('h', ids);
    case 'even-vertical': return even('v', ids);
    case 'main-horizontal':
    case 'main-horizontal-mirrored': {
      const rest = even('h', ids.slice(1));
      const main = leaf(ids[0]);
      const mirrored = name.endsWith('mirrored');
      return { type: 'split', dir: 'v', children: mirrored ? [rest, main] : [main, rest], sizes: mirrored ? [1 - mainSize, mainSize] : [mainSize, 1 - mainSize] };
    }
    case 'main-vertical':
    case 'main-vertical-mirrored': {
      const rest = even('v', ids.slice(1));
      const main = leaf(ids[0]);
      const mirrored = name.endsWith('mirrored');
      return { type: 'split', dir: 'h', children: mirrored ? [rest, main] : [main, rest], sizes: mirrored ? [1 - mainSize, mainSize] : [mainSize, 1 - mainSize] };
    }
    case 'tiled': {
      const n = ids.length;
      let cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const rowNodes: LayoutNode[] = [];
      for (let r = 0; r < rows; r++) rowNodes.push(even('h', ids.slice(r * cols, r * cols + cols)));
      return rows === 1 ? rowNodes[0] : { type: 'split', dir: 'v', children: rowNodes, sizes: rowNodes.map(() => 1 / rows) };
    }
    default:
      return null;
  }
}
