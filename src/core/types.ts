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
  /** Set while the pane is in copy mode. */
  mode?: string | null;
  /** Chrome frame id of the pane's iframe, once its agent reported in. */
  frameId?: number;
  /** The title was set by select-pane -T and is not overwritten by page titles. */
  manualTitle?: boolean;
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
  /** The layout before the last select-layout (for select-layout -o). */
  prevLayout?: LayoutNode;
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
  level: LogLevel;
  message: string;
}

export interface Notice {
  key: string;
  message: string;
  source?: string;
  line?: number;
  level: LogLevel;
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
  /** Collects output lines (and makes errors throw), e.g. for the shell's `tmux …`. */
  print?: (line: string) => void;
  invokedAs?: string;
  session?: Session | null;
  window?: Window | null;
  pane?: number | null;
  depth?: number;
  aliasDepth?: number;
  loop?: unknown;
  origin?: string;
  font?: string;
  measureText?: (text: string) => number;
  [key: string]: unknown;
}

// ------------------------------------------------------------ UI adapter

export interface MessageOptions {
  duration?: number;
}

export interface PromptOptions {
  prompts: string[];
  inputs?: string[];
  single?: boolean;
  numeric?: boolean;
  command?: boolean;
  /** command-prompt -T: the prompt type (command, search, target, window-target). */
  type?: string;
}

export interface ConfirmOptions {
  defaultYes?: boolean;
  confirmKey?: string;
}

export interface ShowListOptions {
  title?: string;
  lines: string[];
  filterable?: boolean;
}

export interface PickItem<V = unknown> {
  label: string;
  value: V;
}

export interface PickOptions<V = unknown> {
  title: string;
  items: PickItem<V>[];
  fuzzy?: boolean;
  hint?: string;
}

/** A pick result: the value, or { value, key } when chosen with C-v/C-s/C-t. */
export type PickResult<V = unknown> = V | { value: V; key: string } | null;

export interface MenuItem {
  label?: string;
  key?: string;
  separator?: boolean;
  disabled?: boolean;
  /** A command (string or `{ }` block) to run when the item is chosen. */
  command?: unknown;
}

export interface MenuOptions<T extends MenuItem = MenuItem> {
  title?: string;
  items: T[];
  start?: number;
  x?: unknown;
  y?: unknown;
}

/** Popup sizes/positions: cells, "N%" or "C" (centre). */
export type PopupDimension = string | number | boolean | null | undefined;

export interface PopupOptions {
  url?: string | null;
  text?: string | null;
  width?: PopupDimension;
  height?: PopupDimension;
  x?: PopupDimension;
  y?: PopupDimension;
  title?: string;
  border?: unknown;
}

export interface ChooseTreeOptions {
  mode?: 'tree' | 'session' | 'window' | (string & {});
  filter?: string;
  zoom?: boolean;
  template?: string | null;
}

export interface DisplayPanesOptions {
  time: number;
}

/** Options for `ui.copyMode()`. */
export interface CopyModeOptions {
  /** Start scrolled up one page (copy-mode -u). */
  scrollUp?: boolean;
  /** Leave copy mode when scrolling past the bottom (copy-mode -e). */
  exitAtBottom?: boolean;
}

/** Options for `ui.renderPane()`. */
export interface RenderPaneOptions {
  /** Load the pane's URL into its frame. */
  navigate?: boolean;
}

/** A command sent to a pane's agent (src/content/pane-agent.ts). */
export interface PaneCommandMessage {
  type: string;
  [key: string]: unknown;
}

/** The adapter the workspace page (or a test stub) gives the engine. */
export interface Ui {
  geometry(): Geometry;
  message(text: unknown, opts?: MessageOptions): void;
  prompt(opts: PromptOptions): Promise<string[] | null>;
  confirm(text: string, opts?: ConfirmOptions): Promise<boolean>;
  showList(opts: ShowListOptions): void;
  showMessages(tab?: string): void;
  chooseTree(opts?: ChooseTreeOptions): void;
  pick<V>(opts: PickOptions<V>): Promise<PickResult<V>>;
  displayPanes(opts: DisplayPanesOptions): Promise<number | null>;
  clock(paneId: number): void;
  copyMode(paneId: number, opts?: CopyModeOptions): Promise<void>;
  paneCommand(paneId: number, msg: PaneCommandMessage): Promise<unknown>;
  focusPane(paneId?: number): void;
  renderPane(paneId: number, opts?: RenderPaneOptions): void;
  detach(): void;
  refresh(): void;
  writeClipboard(text: string): Promise<void>;
  readClipboard(): Promise<string>;
  menu<T extends MenuItem>(opts: MenuOptions<T>): Promise<T | null>;
  popup(opts?: PopupOptions): void;
  closePopup(): void;
  promptHistory(): string[];
  clearPromptHistory(): void;
  render(): void;
  openTab(url: string): unknown;
  serverEmpty(): void;
  setKeyTable(name: string): void;
  keysChanged(): void;
  optionChanged(name: string): void;
  configReloaded(source?: string): void;
}

/** Async key/value store used by TPM emulation (chrome.storage or memory). */
export interface KeyValueStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove?(key: string): Promise<void>;
}
