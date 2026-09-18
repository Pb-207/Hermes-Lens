import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk';
import type { State, HomeItem } from './state-machine';
import type { HermesMessage } from './hermes';
import { stripMarkdown } from './markdown-strip'
import type { ToolMark } from './state-machine'
import { viewRows, pageWindow, pageTextAt } from './history-view';

export const MAX_MAIN_CHARS = 950;

const IDLE_HINT = 'Tap to talk · scroll up = new · 2× = back';
const HOME_ITEM_MAX_CHARS = 32;

// UI 语言(菜单 label / 确认提示):按 country 判断,中国→中文,否则英文
let LANG_ZH = true;
export function setUiLang(zh: boolean): void { LANG_ZH = zh }

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/\s+$/, '') + '…';
}
// ASCII spinner. The LVGL font on G2 lacks every Braille glyph in U+2800–U+28FF
// (confirmed by `lv_draw_letter: glyph dsc. not found` warnings on hardware), so
// the spec's fallback `|/-\` is the actual production choice.
const SPINNER_FRAMES = '|/-\\';

function statusBadge(state: State, tickIndex: number): string {
  switch (state.kind) {
    case 'recording':
    case 'transcribing':
    case 'thinking':
      return SPINNER_FRAMES[tickIndex % SPINNER_FRAMES.length];
    case 'error':
      return '×';
    case 'home':
      return state.loading ? SPINNER_FRAMES[tickIndex % SPINNER_FRAMES.length] : '';
    case 'idle':
      return (state.loading || state.streaming || state.toolLabel)
        ? SPINNER_FRAMES[tickIndex % SPINNER_FRAMES.length] : '';
    default:
      return '';
  }
}

function statusVerb(state: State): string {
  switch (state.kind) {
    case 'recording':
      return 'timedOut' in state && state.timedOut ? 'tap to send' : 'listening';
    case 'transcribing':
      return 'thinking';
    case 'thinking':
      return state.toolLabel ?? 'thinking';
    case 'home':
      return state.loading ? 'loading' : '';
    case 'idle':
      if (state.streaming || state.toolLabel) return state.toolLabel ?? 'thinking';
      return state.loading ? 'loading' : '';
    case 'error':
      return 'error';
    default:
      return '';
  }
}

function crumbOf(state: State): string {
  if (state.kind === 'home') {
    return state.view === 'root' ? '/' : state.view === 'desktop' ? '/Desktop' : '/Glasses';
  }
  const c = (state as { crumb?: string }).crumb;
  return c && c.length ? c : '/';
}

export function statusLine(state: State, tickIndex = 0): string {
  const badge = statusBadge(state, tickIndex);
  const verb = statusVerb(state);
  const st = [badge, verb].filter(Boolean).join(' ');
  const maxLen = st ? 28 : 38; // 状态栏单行;过长标题截断(给状态留空间)
  let crumb = crumbOf(state);
  if (crumb.length > maxLen) crumb = crumb.slice(0, maxLen - 3) + '...';
  return st ? `${crumb} ${st}` : crumb;
}

export function footerHint(state: State): string {
  // 历史页(含流式)翻页提示:仅在分页多于 1 页时显示
  if (state.kind === 'idle' || state.kind === 'recording' || state.kind === 'transcribing' || state.kind === 'thinking') {
    const st = state as { history?: HermesMessage[]; transcript?: string; partial?: string; reply?: string; reveal?: number; rowAnchor?: number | null; toolMarks?: ToolMark[] };
    const rows = viewRows(st.history, { transcript: st.partial ?? st.transcript, reply: st.reply, reveal: st.reveal, toolMarks: st.toolMarks, transcriptLast: state.kind === 'recording' || state.kind === 'transcribing' });
    if (rows.length) {
      const { pages, index } = pageWindow(rows.length, st.rowAnchor ?? null);
      if (pages > 1) {
        return LANG_ZH ? `第 ${index}/${pages} 页 · 滑动翻页` : `page ${index}/${pages} · swipe to turn`;
      }
    }
  }
  return ''; // 其余情况不显示底部提示
}

// 按容器一行约 38 字符换行,把长消息拆成多行(续行后续缩进用)
function wrapWords(text: string, width = 38): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[] = []
  let line = ''
  for (const w of words) {
    if (!line) line = w
    else if ((line + ' ' + w).length <= width) line += ' ' + w
    else { out.push(line); line = w }
  }
  if (line) out.push(line)
  return out
}

const MENU_WINDOW = 6; // 每屏最多 6 个真实项 + 上下省略号 = 8 行 (主容器 232px≈8 行,刚好铺满)

function itemMenuLabel(item: HomeItem): string {
  if (item.kind === 'new') return LANG_ZH ? '+ 新建会话' : '+ new session';
  if (item.kind === 'session') return truncate(item.session.title || item.session.id, HOME_ITEM_MAX_CHARS);
  if (item.kind === 'turn') return truncate(item.turn.transcript, HOME_ITEM_MAX_CHARS);
  if (item.kind === 'dir') return item.name;
  return '(?)';
}

// 窗口化:只显示选中项附近 MENU_WINDOW 行,首尾越界用 "..." 标记。
// 这样容器内容一屏内,e.g. 镜腿滑动直接发 SCROLL 手势 → 移动选中项,而不是滚动页面。
function menuWindow(items: HomeItem[], sel: number): string {
  const n = items.length;
  if (n === 0) return '';
  let start = Math.max(0, sel - 3);
  let end = Math.min(n, start + MENU_WINDOW);
  if (end - start < MENU_WINDOW && end < n) {
    start = Math.max(0, end - MENU_WINDOW);
    end = Math.min(n, start + MENU_WINDOW);
  }
  const lines: string[] = [];
  if (start > 0) lines.push('...');
  for (let i = start; i < end; i++) lines.push((i === sel ? '> ' : '  ') + itemMenuLabel(items[i]));
  if (end < n) lines.push('...');
  return lines.join('\n');
}

// 历史页(含流式回复)当前页文本:同一套展开/分页规则 —— 流式不再截断,超出自动翻页。
function viewText(state: State): string {
  const st = state as { history?: HermesMessage[]; transcript?: string; partial?: string; reply?: string; reveal?: number; rowAnchor?: number | null; toolMarks?: ToolMark[] };
  const rows = viewRows(st.history, { transcript: st.partial ?? st.transcript, reply: st.reply, reveal: st.reveal, toolMarks: st.toolMarks, transcriptLast: state.kind === 'recording' || state.kind === 'transcribing' });
  if (!rows.length) return '';
  const { start } = pageWindow(rows.length, st.rowAnchor ?? null);
  return pageTextAt(rows, start);
}


export function mainContent(state: State, tickIndex = 0): string {
  switch (state.kind) {
    case 'home': {
      void tickIndex;
      if (state.loading) return 'Loading ' + SPINNER_FRAMES[tickIndex % SPINNER_FRAMES.length];
      if (state.confirmDelete) {
        const it = state.items[state.selectedIdx];
        const name = it?.kind === 'session' ? (it.session.title || it.session.id) : '';
        return (LANG_ZH ? '再点一次确认删除:' : 'Tap again to confirm delete:') + '\n' + truncate(name, 30);
      }
      if (state.view === 'root') {
        const dirLabel = (n: string) =>
          n === 'Desktop' ? (LANG_ZH ? '桌面端' : 'Desktop')
                          : (LANG_ZH ? '眼镜端' : 'Glasses');
        return state.items.map((it, i) => {
          const cursor = i === state.selectedIdx ? '> ' : '  ';
          const nm = it.kind === 'dir' ? it.name : '';
          return cursor + dirLabel(nm);
        }).join('\n');
      }
      if (state.view === 'desktop') {
        return menuWindow(state.items, state.selectedIdx);
      }
      return menuWindow(state.items, state.selectedIdx);
    }
    case 'idle':
      if (state.loading) return 'Loading ' + SPINNER_FRAMES[tickIndex % SPINNER_FRAMES.length];
      return viewText(state); // 无历史时空白(不显示操作指南)
    case 'recording':
      return viewText(state); // 历史页内录音:显示历史,顶部提示 listening
    case 'transcribing':
    case 'thinking':
      return viewText(state) || '...';
    case 'disconnected':
      return 'Glasses disconnected — reconnecting...';
    case 'error':
      return state.message;
  }
}

interface Bridge {
  textContainerUpgrade(arg: TextContainerUpgrade): Promise<boolean>;
}

export class RenderQueue {
  private inFlight: Promise<void> = Promise.resolve();
  private lastStatus = '';
  private lastMain = '';
  private lastFooter = '';
  private pending: { state: State; tickIndex: number } | null = null;
  private draining = false;
  private bridge: Bridge;

  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  // 流式场景 delta 很密集:只保留最新状态串行刷出,丢弃过期中间态,避免 IPC 队列积压。
  render(state: State, tickIndex = 0): Promise<void> {
    this.pending = { state, tickIndex };
    if (this.draining) return this.inFlight;
    this.draining = true;
    this.inFlight = this.inFlight.then(async () => {
      while (this.pending) {
        const p = this.pending;
        this.pending = null;
        await this.flush(p.state, p.tickIndex);
      }
      this.draining = false;
    }).catch((err) => {
      console.error('[render] write failed:', err);
      this.draining = false;
    });
    return this.inFlight;
  }

  private async flush(state: State, tickIndex: number): Promise<void> {
    const status = statusLine(state, tickIndex);
    const main = mainContent(state, tickIndex);
    const footer = footerHint(state);
    const next = (async () => {
      if (status !== this.lastStatus) {
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 1,
          contentOffset: 0,
          contentLength: status.length,
          content: status,
        }));
        this.lastStatus = status;
      }
      if (main !== this.lastMain) {
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 2,
          contentOffset: 0,
          contentLength: main.length,
          content: main,
        }));
        this.lastMain = main;
      }
      if (footer !== this.lastFooter) {
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: 3,
          contentOffset: 0,
          contentLength: footer.length,
          content: footer,
        }));
        this.lastFooter = footer;
      }
    })().catch((err) => {
      console.error('[render] write failed:', err);
    });
    await next;
  }
}
