import { describe, it, expect } from 'vitest';
import { reduce, initialState, newConversationName, type State, type Effect, type HomeItem } from './state-machine';
import type { TurnEntry } from './history';

const CONV = 'g2-2026-05-22-01';
const idle: State = { kind: 'idle', conversation: CONV };
const recording: State = { kind: 'recording', conversation: CONV, startedAt: 1_000 };
const transcribing: State = { kind: 'transcribing', conversation: CONV };
const thinking: State = { kind: 'thinking', conversation: CONV, transcript: 'hello', toolLabel: null };
const error: State = { kind: 'error', conversation: CONV, message: 'oops', lastTranscript: '' };
const disconnected: State = { kind: 'disconnected', conversation: CONV };

const kinds = (effects: Effect[]) => effects.map(e => e.kind);

describe('newConversationName', () => {
  it('formats as g2-YYYY-MM-DD-NN', () => {
    expect(newConversationName(new Date('2026-05-22T12:00:00Z'), 1)).toBe('g2-2026-05-22-01');
  });
});

describe('initialState', () => {
  it('returns home with the given conversation and a single "+ new session" item', () => {
    const s = initialState('g2-x');
    expect(s.kind).toBe('home');
    if (s.kind === 'home') {
      expect(s.conversation).toBe('g2-x');
      expect(s.items).toEqual([{ kind: 'dir', name: 'Desktop' }]); // Glasses 列表已停用
      expect(s.selectedIdx).toBe(0);
    }
  });
});

describe('reduce — idle', () => {
  it('TAP starts recording', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('recording');
    expect(kinds(t.effects)).toEqual(['mic_on', 'render']);
  });
  it('SCROLL_UP in idle is a no-op (翻页交给分页逻辑;绝不能重开新会话)', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'SCROLL_UP' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual([]);
  });
  it('DOUBLE_CLICK from idle goes back to the session list', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'DOUBLE_CLICK' });
    expect(t.state.kind).toBe('home');
    expect(kinds(t.effects)).toEqual(['reload_sessions', 'render']);
  });
  it('SCROLL_DOWN is ignored', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'SCROLL_DOWN' });
    expect(t.state).toBe(idle);
    expect(t.effects).toEqual([]);
  });
});

describe('reduce — recording', () => {
  it('TAP stops mic and goes to transcribing', () => {
    const t = reduce(recording, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('transcribing');
    expect(kinds(t.effects)).toEqual(['mic_off', 'transcribe', 'render']);
  });
  it('recording_timeout stops the mic but does not send (send stays tap-confirmed)', () => {
    const t = reduce(recording, { kind: 'recording_timeout' });
    expect(t.state.kind).toBe('recording');
    expect((t.state as { timedOut?: boolean }).timedOut).toBe(true);
    expect(kinds(t.effects)).toEqual(['mic_off', 'render']);
  });
  it('stt_partial updates the pending request line without leaving recording', () => {
    const t = reduce(recording, { kind: 'stt_partial', text: '今天的实验' });
    expect(t.state.kind).toBe('recording');
    expect((t.state as { partial?: string }).partial).toBe('今天的实验');
    expect(kinds(t.effects)).toEqual(['render']);
  });
  it('TAP after a timeout still sends the buffered audio', () => {
    const timedOut = reduce(recording, { kind: 'recording_timeout' }).state;
    const t = reduce(timedOut, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('transcribing');
    expect(kinds(t.effects)).toEqual(['mic_off', 'transcribe', 'render']);
  });
  it('SCROLL_UP does not abort the turn (历史类状态一律不重置)', () => {
    const t = reduce(recording, { kind: 'gesture', gesture: 'SCROLL_UP' });
    expect(t.state.kind).toBe('recording');
    expect(kinds(t.effects)).toEqual([]);
  });
});

describe('reduce — transcribing', () => {
  it('stt_ok with non-empty text moves to thinking and sends', () => {
    const t = reduce(transcribing, { kind: 'stt_ok', text: 'hello' });
    expect(t.state.kind).toBe('thinking');
    if (t.state.kind === 'thinking') expect(t.state.transcript).toBe('hello');
    expect(kinds(t.effects)).toEqual(['send', 'render']);
  });
  it('stt_ok with empty text returns to the history page (no error page)', () => {
    const t = reduce(transcribing, { kind: 'stt_ok', text: '   ' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual(['render']);
  });
  it('stt_err also returns to the history page (no error page)', () => {
    const t = reduce(transcribing, { kind: 'stt_err', message: 'http 401' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual(['render']);
  });
});

describe('reduce — home', () => {
  const turn = (q: string, conv = 'daily'): TurnEntry => ({
    conversation: conv, transcript: q, reply: 'r', ts: 1, source: 'glasses',
  });
  const home3: State = {
    kind: 'home', conversation: CONV, selectedIdx: 0,
    items: [{ kind: 'new' }, { kind: 'turn', turn: turn('q1') }, { kind: 'turn', turn: turn('q2') }],
  };

  it('home_loaded replaces items and resets cursor to 0', () => {
    const fresh: HomeItem[] = [{ kind: 'new' }, { kind: 'turn', turn: turn('q3') }];
    const start: State = { ...home3, selectedIdx: 2 };
    const t = reduce(start, { kind: 'home_loaded', items: fresh });
    if (t.state.kind === 'home') {
      expect(t.state.items).toEqual(fresh);
      expect(t.state.selectedIdx).toBe(0);
    }
    expect(kinds(t.effects)).toEqual(['render']);
  });

  it('SCROLL_DOWN advances the cursor', () => {
    const t = reduce(home3, { kind: 'gesture', gesture: 'SCROLL_DOWN' });
    if (t.state.kind === 'home') expect(t.state.selectedIdx).toBe(1);
  });

  it('SCROLL_UP retreats the cursor', () => {
    const mid: State = { ...home3, selectedIdx: 2 };
    const t = reduce(mid, { kind: 'gesture', gesture: 'SCROLL_UP' });
    if (t.state.kind === 'home') expect(t.state.selectedIdx).toBe(1);
  });

  it('SCROLL_UP clamps at 0', () => {
    const t = reduce(home3, { kind: 'gesture', gesture: 'SCROLL_UP' });
    expect(t.state).toBe(home3);
    expect(t.effects).toEqual([]);
  });

  it('SCROLL_DOWN clamps at items.length - 1', () => {
    const last: State = { ...home3, selectedIdx: 2 };
    const t = reduce(last, { kind: 'gesture', gesture: 'SCROLL_DOWN' });
    expect(t.state).toBe(last);
    expect(t.effects).toEqual([]);
  });

  it('TAP on "+ new session" emits new_conversation and lands in idle', () => {
    const t = reduce(home3, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual(['new_conversation', 'render']);
  });

  it('TAP on a historical turn lands in idle-done with that turn loaded', () => {
    const onTurn: State = { ...home3, selectedIdx: 1 };
    const t = reduce(onTurn, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('idle');
    if (t.state.kind === 'idle') {
      expect(t.state.conversation).toBe('daily');
      expect(t.state.transcript).toBe('q1');
      expect(t.state.reply).toBe('r');
      expect(t.state.streaming).toBe(false);
      expect(t.state.rowAnchor).toBeNull();
    }
  });

  it('DOUBLE_CLICK from home exits the app', () => {
    const t = reduce(home3, { kind: 'gesture', gesture: 'DOUBLE_CLICK' });
    expect(t.state).toBe(home3);
    expect(kinds(t.effects)).toEqual(['exit_confirm']);
  });
});

describe('reduce — back to home (DOUBLE_CLICK from non-home)', () => {
  it('from recording goes back to the SESSION HISTORY page (双击取消语音转写)', () => {
    const t = reduce(recording, { kind: 'gesture', gesture: 'DOUBLE_CLICK' });
    expect(t.state.kind).toBe('idle');
    if (t.state.kind === 'idle') {
      expect(t.state.crumb).toBe((recording as unknown as { crumb?: string }).crumb);
      expect(t.state.history).toBe((recording as unknown as { history?: unknown }).history);
    }
    const eff = t.effects.map((e) => e.kind);
    expect(eff).toContain('mic_off');
    expect(eff).toContain('abort_inflight');
    expect(eff).toContain('render');
  });
  it('from thinking goes back to the session list (double-click = back)', () => {
    const t = reduce(thinking, { kind: 'gesture', gesture: 'DOUBLE_CLICK' });
    expect(t.state.kind).toBe('home');
    expect(kinds(t.effects)).toEqual(['mic_off', 'abort_inflight', 'reload_history', 'render']);
  });
});

describe('reduce — set_conversation', () => {
  it('switches the active conversation while idle', () => {
    const t = reduce(idle, { kind: 'set_conversation', conversation: 'daily journal' });
    expect(t.state).toEqual({ kind: 'idle', conversation: 'daily journal' });
    expect(kinds(t.effects)).toEqual(['render']);
  });
  it('is ignored mid-conversation (no switching during recording/thinking/etc.)', () => {
    for (const state of [recording, transcribing, thinking, error]) {
      const t = reduce(state, { kind: 'set_conversation', conversation: 'other' });
      expect(t.state).toBe(state);
      expect(t.effects).toEqual([]);
    }
  });
});

describe('reduce — interrupt gestures', () => {
  it('TAP in transcribing aborts and returns to idle', () => {
    const t = reduce(transcribing, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual(['abort_inflight', 'render']);
  });
  it('TAP in thinking aborts and returns to idle', () => {
    const t = reduce(thinking, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual(['abort_inflight', 'render']);
  });
  it('TAP in idle-streaming aborts the stream AND starts a new utterance', () => {
    const streaming: State = { kind: 'idle', conversation: CONV, transcript: 'q', reply: 'partial', streaming: true, toolLabel: null, scrollOffset: 0 };
    const t = reduce(streaming, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('recording');
    expect(kinds(t.effects)).toEqual(['abort_inflight', 'mic_on', 'render']);
  });
  it('TAP in idle-done just starts a new utterance (no abort needed)', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('recording');
    expect(kinds(t.effects)).toEqual(['mic_on', 'render']);
  });
});

describe('reduce — thinking', () => {
  it('hermes_ok moves to idle with both transcript and reply', () => {
    const t = reduce(thinking, { kind: 'hermes_ok', text: 'hi back' });
    expect(t.state.kind).toBe('idle');
    if (t.state.kind === 'idle') {
      expect(t.state.transcript).toBe('hello');
      expect(t.state.reply).toBe('hi back');
    }
    expect(kinds(t.effects)).toEqual(['render']);
  });
  it('hermes_err preserves the transcript for retry', () => {
    const t = reduce(thinking, { kind: 'hermes_err', message: 'http 500' });
    expect(t.state.kind).toBe('error');
    if (t.state.kind === 'error') {
      expect(t.state.message).toBe('http 500');
      expect(t.state.lastTranscript).toBe('hello');
    }
  });
  it('SCROLL_UP does not abort the turn (历史类状态一律不重置)', () => {
    const t = reduce(thinking, { kind: 'gesture', gesture: 'SCROLL_UP' });
    expect(t.state.kind).toBe('thinking');
    expect(kinds(t.effects)).toEqual([]);
  });
});

describe('reduce — idle', () => {
  it('TAP starts the next recording', () => {
    const t = reduce(idle, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('recording');
    expect(kinds(t.effects)).toEqual(['mic_on', 'render']);
  });
  it('SCROLL_UP with no history keeps the crumb (新建会话后上滑不能回到根目录)', () => {
    // 旧实现:空历史时穿过分页分支 → scrollUpReset → crumb/desktop 丢失,状态栏变 '/'
    const t = reduce(idle, { kind: 'gesture', gesture: 'SCROLL_UP' });
    expect(t.state.kind).toBe('idle');
    expect(kinds(t.effects)).toEqual([]);
    expect((t.state as unknown as { crumb?: string }).crumb).toBe((idle as unknown as { crumb?: string }).crumb);
  });
});

describe('reduce — error', () => {
  it('TAP retries the send when lastTranscript is set', () => {
    const e: State = { kind: 'error', conversation: CONV, message: 'http 500', lastTranscript: 'hello again' };
    const t = reduce(e, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('thinking');
    if (t.state.kind === 'thinking') expect(t.state.transcript).toBe('hello again');
    expect(kinds(t.effects)).toEqual(['send', 'render']);
  });
  it('TAP without a lastTranscript returns to idle', () => {
    const t = reduce(error, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state.kind).toBe('idle');
  });
});

describe('reduce — disconnected', () => {
  it('any gesture is ignored except DOUBLE_CLICK', () => {
    const t = reduce(disconnected, { kind: 'gesture', gesture: 'TAP' });
    expect(t.state).toBe(disconnected);
    expect(t.effects).toEqual([]);
  });
  it('DOUBLE_CLICK still triggers exit_confirm', () => {
    const t = reduce(disconnected, { kind: 'gesture', gesture: 'DOUBLE_CLICK' });
    expect(kinds(t.effects)).toEqual(['exit_confirm']);
  });
  it('device_reconnected returns to home with reload', () => {
    const t = reduce(disconnected, { kind: 'device_reconnected' });
    expect(t.state.kind).toBe('home');
    expect(kinds(t.effects)).toEqual(['reload_history', 'render']);
  });
});

describe('reduce — universal device_disconnected', () => {
  const states = { idle, recording, transcribing, thinking, error };
  for (const name of Object.keys(states) as Array<keyof typeof states>) {
    it(`from ${name} → disconnected`, () => {
      const t = reduce(states[name], { kind: 'device_disconnected' });
      expect(t.state.kind).toBe('disconnected');
      expect(kinds(t.effects)).toEqual(['mic_off', 'abort_inflight', 'render']);
    });
  }
});

describe('reduce — streaming', () => {
  it('thinking + hermes_delta → idle with streaming:true and reply seeded', () => {
    const t = reduce(thinking, { kind: 'hermes_delta', text: 'Hel' });
    expect(t.state.kind).toBe('idle');
    if (t.state.kind === 'idle') {
      expect(t.state.reply).toBe('Hel');
      expect(t.state.streaming).toBe(true);
      expect(t.state.transcript).toBe('hello');
      expect(t.state.toolLabel).toBeNull();
    }
    expect(kinds(t.effects)).toEqual(['render']);
  });

  it('thinking + hermes_tool sets toolLabel and stays in thinking', () => {
    const t = reduce(thinking, { kind: 'hermes_tool', label: 'searching' });
    expect(t.state.kind).toBe('thinking');
    if (t.state.kind === 'thinking') expect(t.state.toolLabel).toBe('searching');
    expect(kinds(t.effects)).toEqual(['render']);
  });

  it('thinking carries toolLabel into the streaming idle state on first delta', () => {
    const withTool: State = { ...thinking, toolLabel: 'searching' };
    const t = reduce(withTool, { kind: 'hermes_delta', text: 'ok' });
    if (t.state.kind === 'idle') {
      expect(t.state.toolLabel).toBe('searching');
      expect(t.state.streaming).toBe(true);
    }
  });

  it('idle+streaming + hermes_delta grows reply', () => {
    const streaming: State = { kind: 'idle', conversation: CONV, transcript: 'hi', reply: 'Hel', streaming: true, toolLabel: null, scrollOffset: 0 };
    const t = reduce(streaming, { kind: 'hermes_delta', text: 'lo' });
    if (t.state.kind === 'idle') {
      expect(t.state.reply).toBe('Hello');
      expect(t.state.streaming).toBe(true);
    }
  });

  it('idle+streaming + hermes_tool updates toolLabel', () => {
    const streaming: State = { kind: 'idle', conversation: CONV, transcript: 'hi', reply: 'a', streaming: true, toolLabel: null, scrollOffset: 0 };
    const t = reduce(streaming, { kind: 'hermes_tool', label: 'reading' });
    if (t.state.kind === 'idle') expect(t.state.toolLabel).toBe('reading');
  });

  it('idle+streaming + hermes_ok finalizes with streaming:false and clears toolLabel', () => {
    const streaming: State = { kind: 'idle', conversation: CONV, transcript: 'hi', reply: 'a', streaming: true, toolLabel: 'searching', scrollOffset: 0 };
    const t = reduce(streaming, { kind: 'hermes_ok', text: 'all done' });
    if (t.state.kind === 'idle') {
      expect(t.state.streaming).toBe(false);
      expect(t.state.reply).toBe('all done');
      expect(t.state.toolLabel).toBeNull();
    }
  });

  it('idle+streaming + hermes_err goes to error preserving transcript', () => {
    const streaming: State = { kind: 'idle', conversation: CONV, transcript: 'hi', reply: 'a', streaming: true, toolLabel: null, scrollOffset: 0 };
    const t = reduce(streaming, { kind: 'hermes_err', message: 'http 500' });
    expect(t.state.kind).toBe('error');
    if (t.state.kind === 'error') {
      expect(t.state.message).toBe('http 500');
      expect(t.state.lastTranscript).toBe('hi');
    }
  });

  it('idle(stream done): 重复片段与迟到的工具事件被忽略,但新片段不会丢', () => {
    const done: State = { ...idle, reply: 'hello world', streaming: false };
    // 重复投递(内容已存在)→ 原样返回
    expect(reduce(done, { kind: 'hermes_delta', text: 'world' }).state).toBe(done);
    // 完成后的工具事件 → 忽略(避免插入空行)
    expect(reduce(done, { kind: 'hermes_tool', label: 'reading' }).state).toBe(done);
    // 真正缺的尾巴 → 补上(旧实现会整段丢弃,导致"攒着不显示")
    const t = reduce(done, { kind: 'hermes_delta', text: ' !!' });
    expect(t.state.kind).toBe('idle');
    expect((t.state as unknown as { reply?: string }).reply).toBe('hello world !!');
  });

  it('thinking + hermes_ok (non-streaming path) still works and clears toolLabel', () => {
    const withTool: State = { ...thinking, toolLabel: 'searching' };
    const t = reduce(withTool, { kind: 'hermes_ok', text: 'hi back' });
    expect(t.state.kind).toBe('idle');
    if (t.state.kind === 'idle') {
      expect(t.state.streaming).toBe(false);
      expect(t.state.toolLabel).toBeNull();
      expect(t.state.reply).toBe('hi back');
    }
  });
});

