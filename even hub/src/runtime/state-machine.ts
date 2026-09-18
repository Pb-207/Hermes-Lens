import type { TurnEntry } from './history';
import { viewRows, pageWindow, PAGE_ROWS } from './history-view';
import type { HermesMessage } from './hermes';

/** 流式过程中一次工具调用:label + 它发生时的回复长度(用于插回正确位置) */
export type ToolMark = { label: string; at: number };

export type Gesture = 'TAP' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'DOUBLE_CLICK';

export type HomeItem =
  | { kind: 'new' }
  | { kind: 'turn'; turn: TurnEntry }
  | { kind: 'dir'; name: string }
  | { kind: 'session'; session: { id: string; title: string; preview?: string } };

export type Event =
  | { kind: 'reveal' }
  | { kind: 'phone_send'; text: string; images?: string[] }
  | { kind: 'gesture'; gesture: Gesture }
  | { kind: 'stt_partial'; text: string }
  | { kind: 'stt_ok'; text: string }
  | { kind: 'stt_err'; message: string }
  | { kind: 'hermes_ok'; text: string }
  | { kind: 'hermes_err'; message: string }
  | { kind: 'hermes_delta'; text: string }
  | { kind: 'hermes_tool'; label: string | null }
  | { kind: 'set_conversation'; conversation: string }
  | { kind: 'home_loaded'; items: HomeItem[] }
  | { kind: 'menu_action'; itemID: number }
  | { kind: 'session_history_loaded'; messages: HermesMessage[] }
  | { kind: 'recording_timeout' }
  | { kind: 'device_disconnected' }
  | { kind: 'device_reconnected' }
  | { kind: 'tick' };

export type State =
  | { kind: 'home'; conversation: string; view: 'root' | 'folder' | 'desktop'; items: HomeItem[]; selectedIdx: number; loading?: boolean; confirmDelete?: boolean }
  | { kind: 'idle'; conversation: string; history?: HermesMessage[]; loading?: boolean; crumb?: string; desktop?: boolean;
      rowAnchor?: number | null; transcript?: string; reply?: string; reveal?: number; streaming?: boolean; toolLabel?: string | null; toolMarks?: ToolMark[] }
  | { kind: 'recording'; conversation: string; startedAt: number; history?: HermesMessage[]; crumb?: string; desktop?: boolean; rowAnchor?: number | null;
      transcript?: string; partial?: string; timedOut?: boolean; reply?: string; reveal?: number; streaming?: boolean; toolLabel?: string | null; toolMarks?: ToolMark[] }
  | { kind: 'transcribing'; conversation: string; history?: HermesMessage[]; crumb?: string; desktop?: boolean; rowAnchor?: number | null;
      transcript?: string; partial?: string; reply?: string; reveal?: number; streaming?: boolean; toolLabel?: string | null; toolMarks?: ToolMark[] }
  | { kind: 'thinking'; conversation: string; transcript: string; toolLabel: string | null; history?: HermesMessage[]; crumb?: string; desktop?: boolean; rowAnchor?: number | null;
      reply?: string; reveal?: number; streaming?: boolean; toolMarks?: ToolMark[] }
  | { kind: 'disconnected'; conversation: string }
  | { kind: 'error'; conversation: string; message: string; lastTranscript: string; history?: HermesMessage[]; crumb?: string; desktop?: boolean; rowAnchor?: number | null };

export type Effect =
  | { kind: 'mic_on' }
  | { kind: 'mic_off' }
  | { kind: 'transcribe' }
  | { kind: 'send'; conversation: string; transcript: string; images?: string[] }
  | { kind: 'abort_inflight' }
  | { kind: 'exit_confirm' }
  | { kind: 'new_conversation' }
  | { kind: 'reload_history' }
  | { kind: 'reload_sessions' }
  | { kind: 'load_local_history'; conversation: string }
  | { kind: 'load_session_history'; conversation: string }
  | { kind: 'delete_session'; conversation: string }
  | { kind: 'render' };

export type Transition = { state: State; effects: Effect[] };

export function initialState(conversation: string): State {
  return { kind: 'home', conversation, view: 'root', items: [{ kind: 'dir', name: 'Desktop' }] /* Glasses 已停用 */, selectedIdx: 0 };
}

function clampIdx(items: HomeItem[], next: number): number {
  if (items.length === 0) return 0;
  if (next < 0) return 0;
  if (next > items.length - 1) return items.length - 1;
  return next;
}

function backToHome(state: State): Transition {
  return {
    state: { kind: 'home', conversation: state.conversation, view: 'root', items: [{ kind: 'dir', name: 'Desktop' }] /* Glasses 已停用 */, selectedIdx: 0 },
    effects: [
      { kind: 'mic_off' },
      { kind: 'abort_inflight' },
      { kind: 'reload_history' },
      { kind: 'render' },
    ],
  };
}

export function newConversationName(now: Date, seq: number): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const s = String(seq).padStart(2, '0');
  return `g2-${y}-${m}-${d}-${s}`;
}

/** 回历史页(idle):把会话上下文(历史/面包屑/页号)一并带回去。
 *  不带这些字段时状态栏会退回 '/'、历史也空 —— 用户看到的"返回根目录并显示 error"就是这么来的。 */
function backToHistory(
  state: { conversation: string; history?: HermesMessage[]; crumb?: string; desktop?: boolean; rowAnchor?: number | null },
  extra: Effect[] = [],
): Transition {
  return {
    state: {
      kind: 'idle',
      conversation: state.conversation,
      history: state.history,
      crumb: state.crumb,
      desktop: state.desktop,
      rowAnchor: state.rowAnchor,
    },
    effects: [...extra, { kind: 'render' }],
  };
}

function scrollUpReset(state: State): Transition {
  return {
    state: { kind: 'idle', conversation: state.conversation },
    effects: [{ kind: 'mic_off' }, { kind: 'abort_inflight' }, { kind: 'new_conversation' }, { kind: 'render' }],
  };
}

export function reduce(state: State, event: Event): Transition {
  const __t = reduceInner(state, event)
  const __b = state.kind + ((state as { streaming?: boolean }).streaming ? '+streaming' : '')
  const __a = __t.state.kind + ((__t.state as { streaming?: boolean }).streaming ? '+streaming' : '')
  if (event.kind !== 'reveal' && (__b !== __a || event.kind.startsWith('stt_') || event.kind === 'hermes_ok')) {
    console.log('[sm]', __b, '->', __a, event.kind)
  }
  return __t
}

function reduceInner(state: State, event: Event): Transition {

  // Device disconnect is universal — drop everything in flight.
  if (event.kind === 'device_disconnected') {
    if (state.kind === 'disconnected') return { state, effects: [] };
    return {
      state: { kind: 'disconnected', conversation: state.conversation },
      effects: [{ kind: 'mic_off' }, { kind: 'abort_inflight' }, { kind: 'render' }],
    };
  }

  if (event.kind === 'device_reconnected') {
    if (state.kind === 'disconnected') {
      return {
        state: { kind: 'home', conversation: state.conversation, view: 'root', items: [{ kind: 'dir', name: 'Desktop' }] /* Glasses 已停用 */, selectedIdx: 0 },
                effects: [{ kind: 'reload_history' }, { kind: 'render' }],
      };
    }
    return { state, effects: [] };
  }

  // DOUBLE_CLICK semantics(统一,勿再重复添加分支):
  //  - disconnected → 退出确认
  //  - home(root) → 退出;home(folder/desktop) → 折叠回根目录
  //  - idle(会话历史页) → 返回上一级 Desktop 会话列表
  //  - displaying(回复页) → 回当前会话历史页(idle)并刷新历史
  //  - recording/transcribing/thinking(进行中) → 取消,回当前会话历史页(保留目录/历史)
  //  - 其他(error 等) → 回根目录
  if (event.kind === 'gesture' && event.gesture === 'DOUBLE_CLICK') {
    if (state.kind === 'disconnected') {
      return { state, effects: [{ kind: 'exit_confirm' }] };
    }
    if (state.kind === 'home') {
      if (state.view === 'folder' || state.view === 'desktop') {
        // 从目录内容折叠回根目录
        return {
          state: { kind: 'home', conversation: state.conversation, view: 'root', items: [{ kind: 'dir', name: 'Desktop' }] /* Glasses 已停用 */, selectedIdx: 0 },
          effects: [{ kind: 'render' }],
        };
      }
      return { state, effects: [{ kind: 'exit_confirm' }] };
    }
    if (state.kind === 'idle') {
      // 双击返回上一级:Desktop 会话列表
      return {
        state: { kind: 'home', conversation: state.conversation, view: 'desktop', items: [{ kind: 'new' }], selectedIdx: 0, loading: true },
        effects: [{ kind: 'reload_sessions' }, { kind: 'render' }],
      };
    }
    if (state.kind === 'recording' || state.kind === 'transcribing') {
      // 语音转写中双击 = 取消:停麦 + 中断转写,回到**当前会话的历史页**(不回会话列表/根目录)
      return backToHistory(state, [{ kind: 'mic_off' }, { kind: 'abort_inflight' }]);
    }
    if (state.kind === 'thinking') {
      // 请求已经发出(在流式)时双击仍退一层到会话列表,避免看到"半截回复"
      return backToHome(state);
    }
    return backToHome(state);
  }

  // Disconnected swallows everything except double-click (handled above).
  if (state.kind === 'disconnected') {
    return { state, effects: [] };
  }

  // SCROLL_UP is universal — abort + new conversation. Exceptions:
  //  - `home`: 滑动移动菜单光标(在 switch 里处理)
  //  - `idle`(含流式视图): 整段分页显示 —— SCROLL_UP 往更旧一页、SCROLL_DOWN 往更新一页,
  //    滚回最末页则恢复「跟随末尾」,于是流式内容超出时会自动翻页。
  const pagedState = state.kind === 'idle' || state.kind === 'recording'
    || state.kind === 'transcribing' || state.kind === 'thinking';
  if (event.kind === 'gesture' && (event.gesture === 'SCROLL_UP' || event.gesture === 'SCROLL_DOWN')
      && pagedState) {
    const st = state as { history?: HermesMessage[]; transcript?: string; partial?: string; reply?: string; reveal?: number; rowAnchor?: number | null; toolMarks?: ToolMark[] }
    const rows = viewRows(st.history, { transcript: st.transcript ?? st.partial, reply: st.reply, reveal: st.reveal, toolMarks: st.toolMarks })
    const cur = st.rowAnchor ?? null
    if (rows.length) {
      const { start, pages } = pageWindow(rows.length, cur)
      if (pages > 1) {
        const lastStart = (pages - 1) * PAGE_ROWS
        const next = event.gesture === 'SCROLL_UP'
          ? Math.max(0, start - PAGE_ROWS)
          : (start + PAGE_ROWS >= lastStart ? null : start + PAGE_ROWS)
        if (next !== cur && !(cur === null && next === lastStart)) {
          return { state: { ...state, rowAnchor: next }, effects: [{ kind: 'render' }] }
        }
      }
    }
    // 只有一页 / 没有内容:滚动是 no-op(不能落到 scrollUpReset —— 那会丢掉 crumb/desktop,
    // 表现为"新建会话后上滑,状态栏回到根目录")
    return { state, effects: [] }
  }
  if (event.kind === 'gesture' && event.gesture === 'SCROLL_UP'
      && state.kind !== 'home') {
    return scrollUpReset(state);
  }

  // set_conversation only takes effect in idle (no mid-conversation switching).
  if (event.kind === 'set_conversation' && state.kind === 'idle') {
    return {
      state: { kind: 'idle', conversation: event.conversation },
      effects: [{ kind: 'render' }],
    };
  }
  // 历史刷新:任意带 history 的会话态都更新;idle 时清除 loading(加载完成)
  if (event.kind === 'session_history_loaded' && state.kind === 'idle') {
    // 历史里已包含这次的提问/回复 → 清掉一次性流式字段,避免重复显示(仍在流式时不动)
    const keepStream = state.streaming === true;
    return {
      state: keepStream
        ? { ...state, history: event.messages, loading: false }
        : { ...state, history: event.messages, loading: false, transcript: undefined, reply: undefined, reveal: undefined, toolLabel: null, rowAnchor: null },
      effects: [{ kind: 'render' }],
    };
  }
  if (event.kind === 'phone_send') {
    // 手机端打字发送:与语音识别结果同一链路 → 眼镜端进入流式回复页
    if (state.kind === 'idle') {
      const conv = state.conversation;
      return {
        state: {
          kind: 'thinking', conversation: conv, transcript: event.text, toolLabel: null,
          history: (state as { history?: HermesMessage[] }).history,
          crumb: (state as { crumb?: string }).crumb,
          desktop: (state as { desktop?: boolean }).desktop,
        },
        effects: [
          { kind: 'send', conversation: conv, transcript: event.text, images: event.images },
          { kind: 'render' },
        ],
      };
    }
    // 其他状态(列表/录音中等)忽略
    return { state, effects: [] };
  }
  if (event.kind === 'session_history_loaded'
      && (state.kind === 'recording' || state.kind === 'transcribing'
          || state.kind === 'thinking')) {
    return {
      state: { ...state, history: event.messages },
      effects: [{ kind: 'render' }],
    };
  }

  switch (state.kind) {
    case 'home': {
      if (event.kind === 'menu_action') {
        const it = state.items[state.selectedIdx];
        if (state.view === 'desktop' && event.itemID === 1 && it?.kind === 'session') {
          return { state: { ...state, confirmDelete: true }, effects: [{ kind: 'render' }] };
        }
        return { state, effects: [] };
      }
      if (event.kind === 'home_loaded') {
        if (state.view === 'root') return { state, effects: [] };
        return {
          state: { ...state, items: event.items, selectedIdx: 0, loading: false },
          effects: [{ kind: 'render' }],
        };
      }
      if (event.kind === 'gesture' && event.gesture === 'SCROLL_UP') {
        const next = clampIdx(state.items, state.selectedIdx - 1);
        if (next === state.selectedIdx) return { state, effects: [] };
        return { state: { ...state, selectedIdx: next }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'gesture' && event.gesture === 'SCROLL_DOWN') {
        const next = clampIdx(state.items, state.selectedIdx + 1);
        if (next === state.selectedIdx) return { state, effects: [] };
        return { state: { ...state, selectedIdx: next }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        if (state.confirmDelete) {
          const it = state.items[state.selectedIdx];
          if (it?.kind === 'session') {
            return {
              state: { ...state, confirmDelete: false, loading: true },
              effects: [{ kind: 'delete_session', conversation: it.session.id }, { kind: 'render' }],
            };
          }
          return { state: { ...state, confirmDelete: false }, effects: [{ kind: 'render' }] };
        }
        if (state.view === 'root') {
          // 眼镜端(Glasses)已停用;根目录只进桌面端会话列表
          return {
            state: { ...state, view: 'desktop', items: [{ kind: 'new' }], selectedIdx: 0, loading: true },
            effects: [{ kind: 'render' }, { kind: 'reload_sessions' }],
          };
        }
        const item = state.items[state.selectedIdx];
        if (item?.kind === 'session') {
          // 选中桌面会话 → 进入 idle,conversation=桌面会话 id(续接),desktop=true
          return { state: { kind: 'idle', conversation: item.session.id, loading: true, crumb: '/Desktop/' + (item.session.title || item.session.id), desktop: true }, effects: [{ kind: 'load_session_history', conversation: item.session.id }, { kind: 'render' }] };
        }
        if (!item || item.kind === 'new') {
          // "+ new session" → fresh auto-generated conversation in idle.
          return {
            state: { kind: 'idle', conversation: state.conversation, crumb: state.view === 'desktop' ? '/Desktop' : '/Glasses', desktop: state.view === 'desktop' },
            effects: [{ kind: 'new_conversation' }, { kind: 'render' }],
          };
        }
        // Replay: land in displaying-done with the historical turn loaded.
        return {
          state: {
            kind: 'idle',
            conversation: item.turn.conversation,
            transcript: item.turn.transcript,
            reply: item.turn.reply,
            streaming: false,
            toolLabel: null,
            reveal: item.turn.reply.length,
            crumb: '/Glasses',
            desktop: false,
            rowAnchor: null,
          },
          effects: [{ kind: 'render' }],
        };
      }
      return { state, effects: [] };
    }

    case 'idle':
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        // 正在流式 → 打断;否则直接开始新的语音(与原「回复页」行为一致)
        const fx: Effect[] = state.streaming ? [{ kind: 'abort_inflight' }] : [];
        fx.push({ kind: 'mic_on' }, { kind: 'render' });
        return {
          state: {
            kind: 'recording', conversation: state.conversation, startedAt: Date.now(),
            history: state.history, desktop: state.desktop, crumb: state.crumb, rowAnchor: state.rowAnchor,
            // 只有"正在流式时被打断"才需要把已流出的回复带进录音态,否则那半截回复会从视图里消失。
            // 上一轮已经结束的情况不能带:视图跟随末尾,带着旧回复会把新一轮的实时 partial 顶到可视页之外
            // —— 表现为"说话时画面毫无变化,以为没在转写"。transcript 同理必须清掉。
            transcript: undefined, partial: undefined,
            reply: state.streaming ? state.reply : undefined,
            reveal: state.streaming && state.reply ? state.reply.length : undefined,
            streaming: false, toolMarks: state.toolMarks,
          },
          effects: fx,
        };
      }
      if (event.kind === 'reveal') {
        // 打字机:显示端逐字追上已到达的全文(与网络/推理节奏解耦)
        const full = (state.reply ?? '').length;
        const cur = state.reveal ?? full;
        if (cur >= full) return { state, effects: [] };
        const step = Math.min(8, Math.max(1, Math.ceil((full - cur) / 40)));
        return { state: { ...state, reveal: Math.min(full, cur + step) }, effects: [{ kind: 'render' }] };
      }
      // 不能用 state.streaming 当闸门:只要 delta/ok 到了就说明正在流式。
      // 旧写法在第二轮(或上一轮尾巴)标志不为 true 时会静默丢弃事件,
      // 表现为"回复被缓存,再点一下才一起显示"。
      if (event.kind === 'hermes_delta') {
        const frag = event.text ?? '';
        const reply = state.reply ?? '';
        // 重复投递(已在尾部)或空片段 → 忽略;新片段补上。这样既不重复渲染,也不丢尾巴。
        if (!frag || reply.includes(frag)) return { state, effects: [] };
        return { state: { ...state, streaming: true, reply: reply + frag }, effects: [{ kind: 'render' }] };
      }
      if (state.streaming && event.kind === 'hermes_tool') {
        const prev = state.toolMarks ?? [];
        const label = (event.label ?? '').trim();
        // label 为空 = 工具结束事件,忽略;连续同名只留一条
        const marks = !label || (prev.length && prev[prev.length - 1].label === label)
          ? prev
          : [...prev, { label, at: (state.reply ?? '').length }];
        return { state: { ...state, toolLabel: event.label, toolMarks: marks }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'hermes_ok') {
        // 完成时把 reveal 推到全文:否则视图仍按旧的揭示位置截断,要等下次交互才"一起显示"
        return { state: { ...state, streaming: false, reply: event.text, reveal: (event.text ?? '').length, toolLabel: null }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'hermes_err') {
        return {
          state: { kind: 'error', conversation: state.conversation, message: event.message, lastTranscript: state.transcript ?? '', history: state.history, crumb: state.crumb, desktop: state.desktop, rowAnchor: state.rowAnchor },
          effects: [{ kind: 'render' }],
        };
      }
      return { state, effects: [] };

    case 'recording':
      if (event.kind === 'stt_partial') {
        // 流式转写:边录边出字,渲染成视图里那一行用户输入
        return { state: { ...state, partial: event.text }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        return {
          state: { kind: 'transcribing', conversation: state.conversation, history: state.history, desktop: state.desktop, crumb: state.crumb, rowAnchor: state.rowAnchor, transcript: state.partial ?? state.transcript, partial: state.partial, reply: state.reply, reveal: state.reveal, toolMarks: state.toolMarks },
          effects: [{ kind: 'mic_off' }, { kind: 'transcribe' }, { kind: 'render' }],
        };
      }
      if (event.kind === 'recording_timeout') {
        // 录音时长上限(30s):只停麦、保留已转写内容,不自动发送 ——
        // 发送始终由镜腿点击确认(流式转写同样如此,服务端的 FINAL 不会触发发送)
        return {
          state: { ...state, timedOut: true },
          effects: [{ kind: 'mic_off' }, { kind: 'render' }],
        };
      }
      return { state, effects: [] };

    case 'transcribing':
      // 上一轮的流式尾巴可能还在路上:这里也要能收下完成事件,
      // 否则第二轮/尾轮的回复文本会被丢掉(只能等下次单击重新加载历史才出现)
      if (event.kind === 'hermes_ok') {
        return {
          state: { kind: 'idle', conversation: state.conversation, history: state.history, desktop: state.desktop, crumb: state.crumb, rowAnchor: state.rowAnchor, transcript: state.transcript, reply: event.text, reveal: (event.text ?? '').length, streaming: false, toolMarks: state.toolMarks },
          effects: [{ kind: 'render' }],
        }
      }
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        return backToHistory(state, [{ kind: 'abort_inflight' }])
      }
      if (event.kind === 'stt_ok') {
        if (!event.text.trim()) {
          // 没听到内容(用户没说话):直接回历史页,不弹 error(以前会跳 root + error)
          return backToHistory(state)
        }
        return {
          state: { kind: 'thinking', conversation: state.conversation, transcript: event.text, toolLabel: null, history: state.history, desktop: state.desktop, crumb: state.crumb, rowAnchor: state.rowAnchor },
          effects: [{ kind: 'send', conversation: state.conversation, transcript: event.text }, { kind: 'render' }],
        };
      }
      if (event.kind === 'stt_err') {
        // 转写服务失败同样只回历史页(不跳 root、不显示 error)
        return backToHistory(state)
      }
      return { state, effects: [] };

    case 'thinking':
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        return {
          state: {
            kind: 'idle', conversation: state.conversation, history: state.history, desktop: state.desktop,
            crumb: state.crumb, rowAnchor: state.rowAnchor, transcript: state.transcript,
            reply: state.reply, reveal: state.reveal, toolMarks: state.toolMarks,
          },
          effects: [{ kind: 'abort_inflight' }, { kind: 'render' }],
        };
      }
      if (event.kind === 'hermes_delta') {
        return {
          state: {
            kind: 'idle',
            conversation: state.conversation,
            transcript: state.transcript,
            reply: event.text,
            streaming: true,
            toolLabel: state.toolLabel,
            toolMarks: state.toolMarks,
            reveal: 0,
            desktop: state.desktop,
            history: state.history,
            crumb: state.crumb,
          },
          effects: [{ kind: 'render' }],
        };
      }
      if (event.kind === 'hermes_tool') {
        const prev = state.toolMarks ?? [];
        const label = (event.label ?? '').trim();
        // label 为空 = 工具结束事件,忽略;连续同名只留一条
        const marks = !label || (prev.length && prev[prev.length - 1].label === label)
          ? prev
          : [...prev, { label, at: (state.reply ?? '').length }];
        return { state: { ...state, toolLabel: event.label, toolMarks: marks }, effects: [{ kind: 'render' }] };
      }
      if (event.kind === 'hermes_ok') {
        // 进入 B 页面(displaying):顶部显示识别文本,下方显示最新回复
        return {
          state: {
            kind: 'idle',
            conversation: state.conversation,
            transcript: state.transcript,
            reply: event.text,
            streaming: false,
            toolLabel: null,
            reveal: 0,
            desktop: state.desktop,
            history: state.history,
            crumb: state.crumb,
          },
          effects: [{ kind: 'render' }],
        };
      }
      if (event.kind === 'hermes_err') {
        return {
          state: { kind: 'error', conversation: state.conversation, message: event.message, lastTranscript: state.transcript, history: state.history, crumb: state.crumb, desktop: state.desktop, rowAnchor: state.rowAnchor },
          effects: [{ kind: 'render' }],
        };
      }
      return { state, effects: [] };

    case 'error':
      if (event.kind === 'gesture' && event.gesture === 'TAP') {
        if (state.lastTranscript) {
          return {
            state: { kind: 'thinking', conversation: state.conversation, transcript: state.lastTranscript, toolLabel: null, history: state.history, crumb: state.crumb, desktop: state.desktop, rowAnchor: state.rowAnchor },
            effects: [
              { kind: 'send', conversation: state.conversation, transcript: state.lastTranscript },
              { kind: 'render' },
            ],
          };
        }
        return backToHistory(state)
      }
      return { state, effects: [] };
  }
}
