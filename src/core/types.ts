// Shared type definitions for the tmux engine and the workspace page.
// Types only: this module emits an empty file.

// ----------------------------------------------------------------- layout

export type SplitDir = 'h' | 'v';
export type Direction = 'L' | 'R' | 'U' | 'D';

export interface PaneNode {
  type: 'pane';
  id: number;
}

export interface SplitNode {
  type: 'split';
  dir: SplitDir;
  children: LayoutNode[];
  /** Fractions of the split's space, one per child, summing to 1. */
  sizes: number[];
}

/** A pane layout tree. Trees are immutable values. */
export type LayoutNode = PaneNode | SplitNode;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Divider {
  path: number[];
  index: number;
  dir: SplitDir;
  rect: Rect;
  /** The rect of the split node this divider belongs to. */
  split: Rect;
}

export interface LayoutRects {
  panes: Record<number, Rect>;
  dividers: Divider[];
}

/** What the UI reports about the pane area (`ui.geometry()`). */
export interface Geometry {
  rect: Rect;
  gap: number;
  cell: { w: number; h: number };
}

// ------------------------------------------------- sessions, windows, panes

export type PaneKind = 'web' | 'launcher';

export interface Pane {
  id: number;
  kind: PaneKind;
  url: string;
  title: string;
  prefill?: string;
}

export interface Window {
  id: number;
  index: number;
  name: string;
  manualName: boolean;
  layout: LayoutNode;
  /** Active pane id. */
  active: number;
  /** Previously active pane id. */
  last: number | null;
  zoomed: boolean;
  layoutName: string | null;
}

export interface Session {
  id: number;
  name: string;
  windows: Window[];
  /** Active window id. */
  active: number | null;
  /** Previously active window id. */
  last: number | null;
  created: number;
}

/** A resolved -t/-s target. */
export interface Target {
  session: Session;
  window: Window;
  pane: number;
}

// ---------------------------------------------------------- engine state

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel | string;
  message: string;
}

export interface Notice {
  key: string;
  message: string;
  source?: string;
  line?: number;
  level: LogLevel | string;
}

/** Parsed command flags: `-t foo` -> { t: 'foo' }, `-a` -> { a: true }. */
export type Flags = Record<string, string | true>;

/** The context a command runs in. */
export interface CommandContext {
  source?: string;
  line?: number;
  fromConfig?: boolean;
  fromKey?: boolean;
  fromShell?: boolean;
  /** Throw errors instead of reporting them (used by the shell's `tmux …`). */
  print?: boolean;
  invokedAs?: string;
  session?: Session | number | null;
  window?: Window | number | null;
  pane?: number | null;
  depth?: number;
  aliasDepth?: number;
  loop?: unknown;
  origin?: string;
  font?: string;
  measureText?: (text: string) => number;
  [key: string]: unknown;
}

/**
 * Option bags passed between the engine and the UI. They vary per call and
 * are typed loosely on purpose; the UI side narrows them.
 */
export type UiOptions = Record<string, any>;

/** The adapter the workspace page (or a test stub) gives the engine. */
export interface Ui {
  geometry(): Geometry;
  message(text: string, opts?: UiOptions): void;
  prompt(opts: UiOptions): Promise<string | null>;
  confirm(text: string, opts?: UiOptions): Promise<boolean>;
  showList(opts: UiOptions): unknown;
  showMessages(tab?: string): unknown;
  chooseTree(opts?: UiOptions): unknown;
  pick(opts: UiOptions): unknown;
  displayPanes(opts?: UiOptions): unknown;
  clock(paneId: number): void;
  copyMode(paneId: number, opts?: UiOptions): unknown;
  paneCommand(paneId: number, msg: UiOptions): unknown;
  focusPane(paneId: number): void;
  renderPane(paneId: number, opts?: UiOptions): void;
  detach(): void;
  refresh(): void;
  writeClipboard(text: string): unknown;
  readClipboard(): Promise<string>;
  menu(opts: UiOptions): Promise<any>;
  popup(opts: UiOptions): unknown;
  closePopup(): void;
  promptHistory(): string[];
  clearPromptHistory(): void;
  render(): void;
  openTab(url: string): unknown;
  serverEmpty(): void;
  setKeyTable(name: string): void;
  keysChanged(): void;
  optionChanged(name: string): void;
  configReloaded(): void;
  messages?(): unknown;
}

/** Async key/value store used by TPM emulation (chrome.storage or memory). */
export interface KeyValueStorage {
  get(key: string): Promise<any>;
  set(key: string, value: unknown): Promise<void>;
  remove?(key: string): Promise<void>;
}
