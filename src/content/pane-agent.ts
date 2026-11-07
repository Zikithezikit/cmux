/*
 * Pane agent: runs in every frame, but only does anything inside frames whose
 * top-level document is the chrome-tmux workspace page.
 *
 * - routes tmux keys (prefix, root-table bindings) to the workspace
 * - reports URL / title / focus of pane frames
 * - implements copy mode (vi/emacs tables from the config) with the DOM
 *   Selection API, search via window.find(), yank to the clipboard
 * - paste-buffer, send-keys (text), back/forward/reload, link collection
 */
(function () {
  'use strict';
  if (window === window.top) return;
  const ext = 'chrome-extension://' + chrome.runtime.id;
  const anc = location.ancestorOrigins;
  if (!anc || !anc.length || anc[anc.length - 1] !== ext) return;

  const K = globalThis.CtmuxKeys;
  const isRoot = anc.length === 1;
  const paneId = () => {
    if (!isRoot) return null;
    const m = /^ctmux-pane-(\d+)$/.exec(window.name || '');
    return m ? Number(m[1]) : null;
  };

  interface CopyBinding {
    /** A `send -X` command run inside the page. */
    local?: string[];
    remote?: boolean;
  }

  /** The workspace's runtime config (stored under 'ctmux:runtime'). */
  interface RuntimeConfig extends CtmuxRouterConfig {
    copy?: Record<string, Record<string, CopyBinding>>;
    modeKeys?: string;
    modeColours?: { fg?: string; bg?: string };
    mouse?: boolean;
    yank?: { mouse: boolean } | null;
  }

  /** A command the workspace sends to this pane. */
  interface PaneCommand {
    ctmux: true;
    type: string;
    table?: string;
    scrollUp?: boolean;
    args: string[];
    action?: string;
    text: string;
    keys?: string[];
    literal?: boolean;
    all?: boolean;
    limit?: number;
  }

  /** Non-standard window.find() (Chrome supports it; lib.dom does not declare it). */
  interface FindWindow extends Window {
    find?(text: string, caseSensitive: boolean, backwards: boolean, wrap: boolean, wholeWord: boolean, searchInFrames: boolean, showDialog: boolean): boolean;
  }

  let cfg: RuntimeConfig = { prefix: 'C-b', tables: {}, repeat: {}, copy: {}, repeatTime: 500 };
  chrome.storage.local.get('ctmux:runtime').then((r) => { if (r['ctmux:runtime']) cfg = r['ctmux:runtime'] as RuntimeConfig; }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['ctmux:runtime']) cfg = (changes['ctmux:runtime'].newValue as RuntimeConfig | undefined) || cfg;
  });

  const send = (msg: Record<string, unknown>) => {
    try {
      chrome.runtime.sendMessage({ ...msg, pane: paneId(), root: isRoot }).catch(() => {});
    } catch { /* extension reloaded: context invalidated */ }
  };

  const router = K.createRouter(() => cfg);

  // ------------------------------------------------------------------ keys

  function swallow(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  window.addEventListener('keydown', (e) => {
    if (!e.isTrusted) return;
    const key = K.eventToKey(e);
    if (!key) return;
    if (copy.active && router.table === 'root' && key !== cfg.prefix && key !== cfg.prefix2) {
      swallow(e);
      if (copy.searching) return;
      const b = cfg.copy && cfg.copy[copy.table] && cfg.copy[copy.table][key];
      if (!b) return;
      if (b.local) copy.exec(b.local);
      else send({ ctmux: 'key', table: copy.table, key });
      return;
    }
    const r = router.feed(key);
    if (!r) return;
    swallow(e);
    send({ ctmux: 'key', table: r.table, key: r.key, prefix: !!r.prefix });
  }, true);

  // Swallow the matching keypress/keyup so pages don't see half a key.
  for (const type of ['keypress', 'keyup']) {
    window.addEventListener(type, (e) => {
      if (copy.active && e.isTrusted) swallow(e);
    }, true);
  }

  // --------------------------------------------------------- reports/focus

  let last = { url: '', title: '' };
  function report(kind?: string) {
    if (!isRoot) return;
    const url = location.href;
    const title = document.title || '';
    if (kind !== 'hello' && url === last.url && title === last.title) return;
    last = { url, title };
    send({ ctmux: kind || 'report', url, title });
  }
  report('hello');
  document.addEventListener('DOMContentLoaded', () => report());
  window.addEventListener('load', () => report());
  window.addEventListener('hashchange', () => report());
  window.addEventListener('popstate', () => report());
  if (window.navigation) window.navigation.addEventListener('navigatesuccess', () => report());
  setInterval(() => { if (!document.hidden) report(); }, 1500);

  let lastFocus = 0;
  const focused = () => {
    const now = Date.now();
    if (now - lastFocus < 300) return;
    lastFocus = now;
    send({ ctmux: 'focus' });
  };
  window.addEventListener('focus', focused, true);
  window.addEventListener('mousedown', focused, true);

  let lastEditable: HTMLElement | null = null;
  const isEditable = (el: HTMLElement | null) => el && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
  document.addEventListener('focusin', (e) => { if (isEditable(e.target as HTMLElement)) lastEditable = e.target as HTMLElement; }, true);

  // ------------------------------------------------------------- clipboard

  async function writeClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        (document.body || document.documentElement).appendChild(ta);
        const sel = window.getSelection()!;
        const saved = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (saved) { sel.removeAllRanges(); sel.addRange(saved); }
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function yank(text: string) {
    if (!text) return;
    const copied = await writeClipboard(text);
    send({ ctmux: 'yank', text, copied });
  }

  function insertText(text: string) {
    let el = document.activeElement as HTMLElement | null;
    if (!isEditable(el) && lastEditable && document.contains(lastEditable)) { el = lastEditable; el.focus(); }
    if (!isEditable(el)) return false;
    return document.execCommand('insertText', false, text);
  }

  // ------------------------------------------------------------- copy mode

  const copy = {
    active: false,
    table: 'copy-mode-vi',
    selecting: false,
    searching: false,
    lastSearch: null as string | null,
    lastDir: 'forward',
    host: null as HTMLElement | null,
    cursor: null as HTMLElement | null,
    badge: null as HTMLElement | null,

    ui() {
      if (this.host) return;
      this.host = document.createElement('ctmux-copy-mode');
      this.host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const root = this.host.attachShadow({ mode: 'closed' });
      const colours = cfg.modeColours || {};
      const bg = colours.bg || '#e5e510';
      const fg = colours.fg || '#000';
      root.innerHTML = `<style>
        .c{position:fixed;background:${bg};opacity:.75;mix-blend-mode:normal;animation:b 1s steps(1) infinite}
        .b{position:fixed;top:0;right:0;font:12px/18px monospace;padding:0 6px;background:${bg};color:${fg}}
        @keyframes b{50%{opacity:.25}}</style><div class="c"></div><div class="b"></div>`;
      this.cursor = root.querySelector<HTMLElement>('.c');
      this.badge = root.querySelector<HTMLElement>('.b');
    },

    setBadge(extra?: string) {
      if (!this.badge) return;
      const total = Math.max(0, Math.round((scroller().scrollHeight - innerHeight) / lineHeight()));
      const pos = Math.max(0, Math.round((total * lineHeight() - scroller().scrollTop) / lineHeight()));
      this.badge.textContent = `${extra ? extra + ' ' : ''}${this.selecting ? '(sel) ' : ''}[${pos}/${total}]`;
    },

    enter(table?: string, scrollUp?: boolean) {
      this.table = table || 'copy-mode-vi';
      this.ui();
      if (!this.host!.isConnected) document.documentElement.appendChild(this.host!);
      this.active = true;
      const sel = window.getSelection()!;
      if (sel.rangeCount && !sel.isCollapsed && inView(focusRect())) {
        this.selecting = true;
      } else {
        this.selecting = false;
        placeCaretAt(16, 8, false) || placeCaretAtStart();
      }
      if (scrollUp) this.exec(['halfpage-up']);
      this.draw();
      send({ ctmux: 'mode', mode: 'copy-mode' });
    },

    exit() {
      if (!this.active) return;
      this.active = false;
      this.selecting = false;
      this.searching = false;
      const sel = window.getSelection()!;
      if (sel.rangeCount && !sel.isCollapsed) sel.collapse(sel.focusNode, sel.focusOffset);
      if (this.host) this.host.remove();
      send({ ctmux: 'mode', mode: null });
    },

    draw(extra?: string) {
      if (!this.active) return;
      const r = focusRect();
      if (r) {
        Object.assign(this.cursor!.style, {
          left: `${r.left}px`, top: `${r.top}px`, width: `${Math.max(2, r.width || 8)}px`, height: `${r.height || lineHeight()}px`, display: 'block',
        });
      } else {
        this.cursor!.style.display = 'none';
      }
      this.setBadge(extra);
    },

    move(dir: string, gran: string) {
      const sel = window.getSelection()!;
      if (!sel.rangeCount) placeCaretAt(16, 8, false) || placeCaretAtStart();
      sel.modify(this.selecting ? 'extend' : 'move', dir, gran);
      ensureVisible();
    },

    async exec(args: string[]) {
      const [cmd, ...rest] = args;
      const sel = window.getSelection()!;
      const s = scroller();
      const lh = lineHeight();
      switch (cmd) {
        case 'cancel': this.exit(); return;
        case 'cursor-left': this.move('backward', 'character'); break;
        case 'cursor-right': this.move('forward', 'character'); break;
        case 'cursor-up': this.move('backward', 'line'); break;
        case 'cursor-down': this.move('forward', 'line'); break;
        case 'next-word':
        case 'next-space':
          this.move('forward', 'word'); this.move('forward', 'word'); this.move('backward', 'word'); break;
        case 'next-word-end':
        case 'next-space-end': this.move('forward', 'word'); break;
        case 'previous-word':
        case 'previous-space': this.move('backward', 'word'); break;
        case 'start-of-line':
        case 'back-to-indentation': this.move('backward', 'lineboundary'); break;
        case 'end-of-line': this.move('forward', 'lineboundary'); break;
        case 'history-top': this.move('backward', 'documentboundary'); s.scrollTop = 0; break;
        case 'history-bottom': this.move('forward', 'documentboundary'); s.scrollTop = s.scrollHeight; break;
        case 'top-line': placeCaretAt(16, 4, this.selecting); break;
        case 'middle-line': placeCaretAt(16, innerHeight / 2, this.selecting); break;
        case 'bottom-line': placeCaretAt(16, innerHeight - lh, this.selecting); break;
        case 'scroll-up': scrollKeepingCaret(-lh); break;
        case 'scroll-down': scrollKeepingCaret(lh); break;
        case 'halfpage-up': scrollKeepingCaret(-innerHeight / 2); break;
        case 'halfpage-down': scrollKeepingCaret(innerHeight / 2); break;
        case 'page-up': scrollKeepingCaret(-innerHeight + lh * 2); break;
        case 'page-down': scrollKeepingCaret(innerHeight - lh * 2); break;
        case 'begin-selection':
          if (sel.rangeCount) sel.collapseToEnd();
          this.selecting = true;
          break;
        case 'clear-selection':
          if (sel.rangeCount && !sel.isCollapsed) sel.collapse(sel.focusNode, sel.focusOffset);
          this.selecting = false;
          break;
        case 'select-line':
          this.selecting = false;
          this.move('backward', 'lineboundary');
          this.selecting = true;
          this.move('forward', 'lineboundary');
          break;
        case 'select-word':
          this.selecting = false;
          this.move('backward', 'word');
          this.selecting = true;
          this.move('forward', 'word');
          break;
        case 'other-end':
          if (sel.rangeCount) sel.setBaseAndExtent(sel.focusNode!, sel.focusOffset, sel.anchorNode!, sel.anchorOffset);
          ensureVisible();
          break;
        case 'rectangle-toggle':
          this.draw('(no rectangles)');
          return;
        case 'search-forward':
        case 'search-forward-incremental':
        case 'search-forward-text':
          this.search(rest[0], 'forward'); return;
        case 'search-backward':
        case 'search-backward-incremental':
        case 'search-backward-text':
          this.search(rest[0], 'backward'); return;
        case 'search-again': this.search(this.lastSearch, this.lastDir); return;
        case 'search-reverse': this.search(this.lastSearch, this.lastDir === 'forward' ? 'backward' : 'forward', true); return;
        case 'copy-line':
          this.exec(['select-line']);
          await yank(sel.toString());
          this.exit();
          return;
        case 'copy-end-of-line':
        case 'copy-end-of-line-and-cancel':
        case 'copy-pipe-end-of-line':
        case 'copy-pipe-end-of-line-and-cancel':
          this.selecting = true;
          this.move('forward', 'lineboundary');
          await yank(sel.toString());
          if (cmd.endsWith('-and-cancel')) this.exit(); else this.exec(['clear-selection']);
          return;
        case 'copy-selection':
        case 'copy-selection-no-clear':
        case 'copy-selection-and-cancel':
        case 'copy-pipe':
        case 'copy-pipe-no-clear':
        case 'copy-pipe-and-cancel':
        case 'append-selection':
        case 'append-selection-and-cancel':
        case 'copy-selection-and-paste': {
          const text = sel.toString();
          await yank(text);
          if (cmd === 'copy-selection-and-paste') { this.exit(); insertText(text); return; }
          if (cmd.endsWith('-and-cancel')) { this.exit(); return; }
          if (!cmd.endsWith('-no-clear')) this.exec(['clear-selection']);
          break;
        }
        default:
          this.draw(`(${cmd}?)`);
          return;
      }
      this.draw();
    },

    search(term: string | null | undefined, dir: string, reverse?: boolean) {
      if (!term) { this.draw('(no search)'); return; }
      this.lastSearch = term;
      if (!reverse) this.lastDir = dir;
      const sel = window.getSelection()!;
      const anchor: [Node | null, number] | null = this.selecting && sel.rangeCount ? [sel.anchorNode, sel.anchorOffset] : null;
      if (dir === 'forward' && sel.rangeCount) {
        sel.collapse(sel.focusNode, sel.focusOffset);
        sel.modify('move', 'forward', 'character');
      } else if (sel.rangeCount) {
        sel.collapse(sel.focusNode, sel.focusOffset);
      }
      const found = (window as FindWindow).find!(term, false, dir === 'backward', true, false, false, false);
      if (!found) { this.draw(`(not found: ${term})`); return; }
      const start = sel.getRangeAt(0);
      const node = start.startContainer, off = start.startOffset;
      if (anchor) sel.setBaseAndExtent(anchor[0]!, anchor[1], node, off);
      else sel.collapse(node, off);
      ensureVisible();
      this.draw();
    },
  };

  function scroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 4) return se;
    // Apps with an inner scrolling container: find the one under the viewport centre.
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
      el = el.parentElement;
    }
    return se;
  }

  function lineHeight() {
    const lh = parseFloat(getComputedStyle(document.body || document.documentElement).lineHeight);
    return Number.isFinite(lh) && lh > 4 ? lh : 20;
  }

  function focusRect() {
    const sel = window.getSelection()!;
    if (!sel.rangeCount || !sel.focusNode) return null;
    const r = document.createRange();
    try {
      r.setStart(sel.focusNode, sel.focusOffset);
      r.collapse(true);
    } catch { return null; }
    let rect = r.getClientRects()[0] || r.getBoundingClientRect();
    if ((!rect || (!rect.width && !rect.height && !rect.top && !rect.left)) && sel.focusNode.nodeType === 1) {
      const child = sel.focusNode.childNodes[sel.focusOffset] as Element || sel.focusNode as Element;
      if (child.getBoundingClientRect) rect = child.getBoundingClientRect();
    }
    if (!rect) return null;
    // A collapsed caret has zero width: show a character-sized block.
    return { left: rect.left, top: rect.top, width: rect.width || 8, height: rect.height || lineHeight() };
  }

  const inView = (r: ReturnType<typeof focusRect>) => r && r.top >= 0 && r.top + r.height <= innerHeight && r.left >= 0 && r.left <= innerWidth;

  function ensureVisible() {
    const r = focusRect();
    if (!r) return;
    const s = scroller();
    const margin = lineHeight();
    if (r.top < margin) s.scrollTop += r.top - margin;
    else if (r.top + r.height > innerHeight - margin) s.scrollTop += r.top + r.height - innerHeight + margin;
  }

  function caretRangeAt(x: number, y: number) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const p = document.caretPositionFromPoint && document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    return r;
  }

  /** Put the caret at the first text found scanning down from (x, y). */
  function placeCaretAt(x: number, y: number, extend: boolean) {
    const sel = window.getSelection()!;
    for (let yy = Math.max(1, y); yy < innerHeight; yy += 8) {
      for (const xx of [x, x + 40, innerWidth / 4, innerWidth / 2]) {
        const r = caretRangeAt(xx, yy);
        if (r && r.startContainer.nodeType === 3 && r.startContainer.textContent!.trim()) {
          if (extend && sel.rangeCount) sel.extend(r.startContainer, r.startOffset);
          else sel.collapse(r.startContainer, r.startOffset);
          return true;
        }
      }
    }
    return false;
  }

  function placeCaretAtStart() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.textContent!.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const n = walker.nextNode();
    if (n) window.getSelection()!.collapse(n, 0);
    return !!n;
  }

  function scrollKeepingCaret(dy: number) {
    const before = focusRect();
    scroller().scrollBy(0, dy);
    const after = focusRect();
    if (!after || after.top < 0 || after.top > innerHeight - after.height) {
      const y = before ? Math.min(Math.max(4, before.top), innerHeight - lineHeight()) : 4;
      placeCaretAt(before ? before.left : 16, y, copy.selecting);
    }
  }

  window.addEventListener('scroll', () => { if (copy.active) copy.draw(); }, true);
  window.addEventListener('resize', () => { if (copy.active) copy.draw(); });
  window.addEventListener('mousedown', () => { if (copy.active) setTimeout(() => copy.draw(), 0); }, true);

  // ------------------------------------------------------------ mouse yank

  let downAt: [number, number] | null = null;
  window.addEventListener('mousedown', (e) => { downAt = e.button === 0 ? [e.clientX, e.clientY] : null; }, true);
  window.addEventListener('mouseup', (e) => {
    if (!cfg.yank || !cfg.yank.mouse || !cfg.mouse || !downAt || e.button !== 0) return;
    const moved = Math.abs(e.clientX - downAt[0]) + Math.abs(e.clientY - downAt[1]) > 4;
    downAt = null;
    if (!moved || isEditable(document.activeElement as HTMLElement | null)) return;
    setTimeout(() => {
      const text = window.getSelection()!.toString();
      if (text) { yank(text); if (copy.active) copy.exit(); }
    }, 0);
  }, true);

  // ----------------------------------------------------- workspace commands

  function collectLinks(limit: number) {
    const seen = new Set<string>();
    const out: { url: string; text: string }[] = [];
    const add = (url: string, text: string) => {
      if (!url || seen.has(url) || out.length >= limit) return;
      if (!/^(https?|ftp|file|mailto):/i.test(url)) return;
      seen.add(url);
      out.push({ url, text: (text || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
    };
    for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) add(a.href, a.textContent || a.title);
    const text = document.body ? document.body.innerText : '';
    const re = /\b(?:https?|ftp|file):\/\/[^\s<>"'`)\]}]+|\bwww\.[\w-]+\.[^\s<>"'`)\]}]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < limit) add(m[0].startsWith('www.') ? 'http://' + m[0] : m[0].replace(/[.,;:!?]+$/, ''), '');
    return out;
  }

  function sendKeys(keys: string[], literal?: boolean) {
    for (const k of keys) {
      if (literal) { insertText(k); continue; }
      switch (K.normalizeKey(k)) {
        case 'Enter': {
          const el = document.activeElement as HTMLInputElement | null;
          if (el && el.form && el.form.requestSubmit) el.form.requestSubmit();
          else insertText('\n');
          break;
        }
        case 'Space': insertText(' '); break;
        case 'Tab': insertText('\t'); break;
        case 'BSpace': document.execCommand('delete'); break;
        case 'DC': document.execCommand('forwardDelete'); break;
        default:
          if (k.length === 1 || !/^[CMS]-|^[A-Z][a-zA-Z]+\d*$/.test(k)) insertText(k);
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg: PaneCommand | undefined, sender, sendResponse) => {
    if (!msg || msg.ctmux !== true || sender.id !== chrome.runtime.id) return false;
    switch (msg.type) {
      case 'copy-mode':
        copy.enter(msg.table, msg.scrollUp);
        sendResponse(true);
        return false;
      case 'copy-cmd':
        if (!copy.active && msg.args[0] !== 'cancel') { sendResponse(false); return false; }
        Promise.resolve(copy.exec(msg.args)).then(() => sendResponse(true));
        return true;
      case 'nav':
        if (msg.action === 'back') history.back();
        else if (msg.action === 'forward') history.forward();
        else if (msg.action === 'reload') location.reload();
        sendResponse(true);
        return false;
      case 'paste':
        sendResponse(insertText(msg.text));
        return false;
      case 'send-keys':
        sendKeys(msg.keys || [], msg.literal);
        sendResponse(true);
        return false;
      case 'capture': {
        // capture-pane: the page's visible text (or the whole document with -S -).
        const text = String(document.body?.innerText || '');
        sendResponse({ text: msg.all ? text : text.slice(0, 200000), title: document.title, url: location.href });
        return false;
      }
      case 'collect-links':
        sendResponse(collectLinks(msg.limit || 2000));
        return false;
      case 'set-table':
        router.setTable(msg.table);
        sendResponse(true);
        return false;
      default:
        return false;
    }
  });
})();
