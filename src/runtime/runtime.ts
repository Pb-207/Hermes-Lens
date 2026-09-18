import {
  EvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  DeviceConnectType,
} from '@evenrealities/even_hub_sdk'
import { type AppConfig, saveConfig } from '../config'
import { reduce, initialState, newConversationName, type Effect, type Event, type Gesture, type State } from './state-machine'
import { RenderQueue, setUiLang, statusLine, mainContent, footerHint } from './render'

// 流式节流:delta 累积到该间隔才 dispatch 一次(减少 Even IPC 与渲染次数)
const STREAM_FLUSH_MS = 100

// 打字机揭示间隔(ms):每拍 reveal 前进 step 个字符;调大 = 更慢
const REVEAL_TICK_MS = 40
import { PcmRecorder, MIN_USEFUL_BYTES, pcmToWav, toPcmBytes } from './audio'
import { transcribe, openSttStream, SttError, type SttStream } from './stt'
import { streamRespond, listSessions, getSessionMessages, sessionChat, sessionChatStream, deleteSession, createSession, HermesError } from './hermes'
import { appendTurn, loadHistory, type TurnEntry } from './history'
import type { HomeItem } from './state-machine'

const RECORDING_TIMEOUT_MS = 30_000
const ERROR_AUTO_CLEAR_MS = 3_000
const ANIMATION_TICK_MS = 250
const HOME_RECENT_TURNS = 2

async function buildDesktopItems(hermes: AppConfig['hermes']): Promise<HomeItem[]> {
  const sessions = await listSessions(hermes)
  return [{ kind: 'new' }, ...sessions.map((s) => ({ kind: 'session' as const, session: s }))]
}

async function buildHomeItems(bridge: EvenAppBridge): Promise<HomeItem[]> {
  const all = await loadHistory(bridge)
  // Most-recent-first slice of `HOME_RECENT_TURNS` turns regardless of conversation.
  const recent: TurnEntry[] = all.slice(-HOME_RECENT_TURNS).reverse()
  return [{ kind: 'new' }, ...recent.map((turn) => ({ kind: 'turn' as const, turn }))]
}

function isAnimatedState(state: State): boolean {
  switch (state.kind) {
    case 'recording':
    case 'transcribing':
    case 'thinking':
      return true
    case 'idle': {
      if (state.loading || state.streaming || state.toolLabel) return true
      const reply = state.reply ?? ''
      // 打字机还没追平(流式已结束但 reveal 仍在推进)
      return reply.length > 0 && (state.reveal ?? reply.length) < reply.length
    }
    case 'home':
      return !!state.loading
    default:
      return false
  }
}

type RuntimeOptions = {
  bridge: EvenAppBridge
  config: AppConfig
  /** true = 启动页已由 main.ts 创建(复用其容器,不再重复建页) */
  pageCreated?: boolean
}

// The host (real glasses + simulator) may deliver `eventType` as a number,
// a long string like "CLICK_EVENT", or a short string like "CLICK".
// Normalize with the SDK helper before matching against the enum.
function gestureFromEventType(raw: unknown): Gesture | null {
  const t = OsEventTypeList.fromJson(raw)
  switch (t) {
    case OsEventTypeList.CLICK_EVENT: return 'TAP'
    case OsEventTypeList.SCROLL_TOP_EVENT: return 'SCROLL_UP'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT: return 'SCROLL_DOWN'
    case OsEventTypeList.DOUBLE_CLICK_EVENT: return 'DOUBLE_CLICK'
    default: return null
  }
}

export async function startRuntime(opts: RuntimeOptions): Promise<void> {
  const { bridge, config, pageCreated = false } = opts

  // 1. Create the three layout zones: status (28px) / main (232px) / footer (28px).
  //    Sum = 288px = G2 framebuffer height. Container 2 (main) keeps event capture.
  const status = new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: 576, height: 28,
    borderWidth: 0, paddingLength: 4,
    containerID: 1, containerName: 'status',
    content: '', isEventCapture: 0,
  })
  const main = new TextContainerProperty({
    xPosition: 0, yPosition: 28, width: 576, height: 232,
    borderWidth: 0, paddingLength: 4,
    containerID: 2, containerName: 'main',
    content: '',
    isEventCapture: 1,
  })
  const footer = new TextContainerProperty({
    xPosition: 0, yPosition: 260, width: 576, height: 28,
    borderWidth: 0, paddingLength: 4,
    containerID: 3, containerName: 'footer',
    content: '', isEventCapture: 0,
  })
  // UI 语言:来自手机端配置页的中英切换(config.lang),默认中文
  const isZh = config.lang !== 'en'
  setUiLang(isZh)

  // ---- 手机端 UI:进入会话后可直接打字发送(与语音同一链路) ----
  let phoneImages: string[] = [];
  function renderPhoneFiles(): void {
    const el = document.getElementById('phone-files');
    if (el) el.textContent = phoneImages.length
      ? (isZh ? '已附 ' + phoneImages.length + ' 张图片' : 'attached ' + phoneImages.length + ' image(s)')
      : '';
  }
  function addImageFiles(files: FileList): void {
    for (const f of Array.from(files)) {
      const fr = new FileReader();
      fr.onload = () => { if (typeof fr.result === 'string') { phoneImages.push(fr.result); renderPhoneFiles(); } };
      fr.readAsDataURL(f);
    }
  }
  function phoneSubmit(): void {
    const el = document.getElementById('phone-input') as HTMLTextAreaElement | null;
    if (!el) return;
    const text = el.value.trim();
    const images = phoneImages.slice();
    if (!text && !images.length) return;
    el.value = '';
    phoneImages = [];
    renderPhoneFiles();
    dispatch({ kind: 'phone_send', text, images });
  }
  function ensurePhoneUi(): void {
    const existingPhone = document.getElementById('phone-ui');
    if (existingPhone) { existingPhone.style.display = 'flex'; return; }
    const host = document.createElement('div');
    host.id = 'phone-ui';
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:10px 12px;background:#111;color:#eee;font:14px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;gap:8px;z-index:9999';
    host.innerHTML =
      '<div id="phone-status" style="opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>' +
      '<textarea id="phone-input" rows="4" placeholder="' + (isZh ? '输入消息…' : 'type a message…') + '" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:6px;border:1px solid #444;background:#1b1b1b;color:#eee;resize:vertical;font:inherit"></textarea>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<button id="phone-attach" style="padding:7px 12px;border-radius:6px;border:1px solid #444;background:#1b1b1b;color:#eee;font:inherit">' + (isZh ? '+ 图片' : '+ image') + '</button>' +
        '<span id="phone-files" style="opacity:.8;font-size:12px"></span>' +
        '<span style="flex:1"></span>' +
        '<button id="phone-send" style="padding:9px 20px;border-radius:6px;border:0;background:#3b82f6;color:#fff;font:inherit">' + (isZh ? '发送' : 'Send') + '</button>' +
      '</div>' +
      '<input id="phone-file" type="file" accept="image/*" multiple style="display:none" />';
    document.body.appendChild(host);
    document.getElementById('phone-send')?.addEventListener('click', phoneSubmit);
    document.getElementById('phone-attach')?.addEventListener('click', () => {
      (document.getElementById('phone-file') as HTMLInputElement | null)?.click();
    });
    document.getElementById('phone-file')?.addEventListener('change', (ev) => {
      const input = ev.target as HTMLInputElement;
      if (input.files) addImageFiles(input.files);
      input.value = '';
    });
    // 输入框随内容自动增高(4 行起步,到 40vh 上限后滚动)
    document.getElementById('phone-input')?.addEventListener('input', (ev) => {
      const t = ev.target as HTMLTextAreaElement;
      t.style.height = 'auto';
      t.style.height = t.scrollHeight + 'px';
    });
    // 4 行输入框:Enter 换行,用按钮(或 Ctrl/Cmd+Enter)发送
    document.getElementById('phone-input')?.addEventListener('keydown', (ev) => {
      const e = ev as KeyboardEvent;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); phoneSubmit(); }
    });
  }
  function updatePhoneUi(s: State): void {
    const st = document.getElementById('phone-status');
    const btn = document.getElementById('phone-send') as HTMLButtonElement | null;
    if (!st) return;
    const active = s.kind === 'idle';
    if (active) st.textContent = (s as { crumb?: string }).crumb || (isZh ? '当前会话' : 'session');
    else if (s.kind === 'home') st.textContent = isZh ? '先在眼镜端选择一个会话' : 'pick a session on glasses first';
    else st.textContent = s.kind;
    if (btn) btn.disabled = !active;
  }
  ensurePhoneUi();
  if (pageCreated) {
    // 启动页已由 main.ts 创建(同一批容器 ID/几何),这里直接渲染覆盖即可。
    console.log('[runtime] reusing page created at startup')
  } else {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [status, main, footer],
    }))
    if (result !== 0) {
      console.error('[runtime] createStartUpPageContainer failed:', result)
      return
    }
  }

  // 2. Set up state, queues, counters. Initial state is home; the
  // conversation field is only meaningful once the user picks an item.
  let seq = 1
  let conversation = config.session.lastName || newConversationName(new Date(), seq)
  let desktopIds = new Set<string>() // 桌面会话 id 集合(接续聊天用)
  let micSeq = 0
  let state: State = initialState(conversation)

  const render = new RenderQueue(bridge)
  const recorder = new PcmRecorder()
  let inflight: AbortController | null = null
  let recordingTimer: ReturnType<typeof setTimeout> | null = null
  let sttStream: SttStream | null = null // 流式转写(不可用时回落 REST)
  let errorClearTimer: ReturnType<typeof setTimeout> | null = null
  let animationTimer: ReturnType<typeof setInterval> | null = null
  let tickIndex = 0

  const ensureAnimating = (): void => {
    if (animationTimer || !isAnimatedState(state)) return
    animationTimer = setInterval(() => {
      tickIndex += 1
      if (!isAnimatedState(state)) {
        if (animationTimer) { clearInterval(animationTimer); animationTimer = null }
        return
      }
      render.render(state, tickIndex).catch(() => {})
    }, ANIMATION_TICK_MS)
  }
  const stopAnimating = (): void => {
    if (animationTimer) { clearInterval(animationTimer); animationTimer = null }
  }

  // 动态菜单:只在会话列表页(home/desktop)显示「删除会话」项,其他页面清除。
  let menuShown = false
  const syncMenu = async (): Promise<void> => {
    const need = state.kind === 'home' && state.view === 'desktop'
    if (need === menuShown) return
    menuShown = need
    const mk = (id: number, name: string, y: number, h: number, cap: number, content: string) =>
      new TextContainerProperty({ xPosition: 0, yPosition: y, width: 576, height: h, borderWidth: 0, paddingLength: 4, containerID: id, containerName: name, content, isEventCapture: cap })
    const payload: Record<string, unknown> = {
      containerTotalNum: 3,
      textObject: [
        mk(1, 'status', 0, 28, 0, statusLine(state, tickIndex)),
        mk(2, 'main', 28, 232, 1, mainContent(state, tickIndex)),
        mk(3, 'footer', 260, 28, 0, footerHint(state)),
      ],
    }
    if (need) {
      payload.menuObject = new MenuContainerProperty({
        menuItems: [ new MenuItemProperty({ itemName: isZh ? '删除会话' : 'Delete session', itemID: 1 }) ],
      })
    }
    try { await bridge.rebuildPageContainer(new RebuildPageContainer(payload as any)) }
    catch (err) { console.error('[runtime] rebuild menu failed:', err) }
  }

  // 3. Effect runner.
  const dispatch = async (event: Event): Promise<void> => {
    const t = reduce(state, event)
    const prevKind = state.kind
    state = t.state
    void syncMenu()
    updatePhoneUi(state)
    // 动画 tick:在跑 effects 之前就按新 state 启停(否则被 await 的加载 effect 拖住,Loading 期间 spinner 不动)
    if (isAnimatedState(state)) ensureAnimating()
    else stopAnimating()
    for (const e of t.effects) {
      try {
        await runEffect(e)
      } catch (err) {
        console.error('[runtime] effect failed:', e.kind, err)
      }
    }
    // Auto-clear errors back to idle after a few seconds.
    if (state.kind === 'error' && prevKind !== 'error') {
      if (errorClearTimer) clearTimeout(errorClearTimer)
      errorClearTimer = setTimeout(() => {
        if (state.kind === 'error' && !state.lastTranscript) {
          dispatch({ kind: 'gesture', gesture: 'TAP' })
        }
      }, ERROR_AUTO_CLEAR_MS)
    }
  }

  const runEffect = async (e: Effect): Promise<void> => {
    switch (e.kind) {
      case 'mic_on': {
        recorder.reset()
        sttStream?.close()
        console.log('[runtime] mic_on -> open ws stream', ++micSeq)
        sttStream = openSttStream(config.stt, {
          onPartial: (text) => { void dispatch({ kind: 'stt_partial', text }) },
        })
        // 先等流就绪(最多 ~1.2s)再开麦:否则握手期间采到的音频只能靠缓冲,
        // 且服务端连不上时用户完全看不到「正在转写」。失败也只是继续走 REST 回落。
        const streamReady = await sttStream.ready(1200)
        console.log('[runtime] ws ready =', streamReady)
        await bridge.audioControl(true)
        if (recordingTimer) clearTimeout(recordingTimer)
        recordingTimer = setTimeout(() => dispatch({ kind: 'recording_timeout' }), RECORDING_TIMEOUT_MS)
        return
      }
      case 'mic_off': {
        if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null }
        await bridge.audioControl(false)
        return
      }
      case 'transcribe': {
        if (recorder.bytes() < MIN_USEFUL_BYTES) {
          sttStream?.close()
          sttStream = null
          dispatch({ kind: 'stt_ok', text: '' })
          return
        }
        // 流式:停止推流后等服务端 FINAL(它按 ~0.7s 静音判定),拿到就直接用
        if (sttStream) {
          const streamed = await sttStream.finish(1800)
          console.log('[runtime] ws finish ->', streamed === null ? 'null (REST fallback)' : JSON.stringify(streamed.slice(0, 30)))
          sttStream.close()
          sttStream = null
          if (streamed && streamed.trim()) {
            recorder.reset()
            dispatch({ kind: 'stt_ok', text: streamed.trim() })
            return
          }
        }
        // 回落:OpenAI 兼容的整段 REST 转写
        const wav = pcmToWav(recorder.flatten(), { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
        recorder.reset()
        inflight = new AbortController()
        try {
          const text = await transcribe(config.stt, wav, inflight.signal)
          dispatch({ kind: 'stt_ok', text })
        } catch (err) {
          if ((err as Error)?.name === 'AbortError') return   // 用户打断,不是错误
          const msg = err instanceof SttError ? err.message : 'stt error'
          dispatch({ kind: 'stt_err', message: msg })
        } finally {
          inflight = null
        }
        return
      }
      case 'send': {
        inflight = new AbortController()
        try {
          if (desktopIds.has(e.conversation)) {
            // 桌面会话:/api/sessions/{id}/chat/stream(接续桌面会话)+ 流式(与 streamRespond 同结构,无 fallback)
            let finalText = ''
            let pending = ''
            let lastFlush = 0
            console.log('[runtime] send: desktop streaming start')
            for await (const ev of sessionChatStream(config.hermes, e.conversation, e.transcript, e.images ?? [], inflight.signal)) {
              if (ev.kind === 'delta') {
                finalText += ev.text; pending += ev.text
                const now = Date.now()
                if (now - lastFlush >= STREAM_FLUSH_MS) { dispatch({ kind: 'hermes_delta', text: pending }); pending = ''; lastFlush = now }
              }
              else if (ev.kind === 'tool') { dispatch({ kind: 'hermes_tool', label: ev.label }) }
              else if (ev.kind === 'tool_end') { dispatch({ kind: 'hermes_tool', label: null }) }
              else if (ev.kind === 'done') { dispatch({ kind: 'hermes_ok', text: ev.text || finalText }) }
            }
            // 节流的尾巴必须补发,否则最后一段文本只在 hermes_ok 里一起出现
            if (pending) { dispatch({ kind: 'hermes_delta', text: pending }); pending = '' }
          } else {
          let finalText = ''
          let deltaCount = 0
          let pending = ''
          let lastFlush = 0
          console.log('[runtime] send: streaming start')
          for await (const ev of streamRespond(config.hermes, e.conversation, e.transcript, inflight.signal)) {
            switch (ev.kind) {
              case 'delta': {
                deltaCount += 1
                finalText += ev.text
                pending += ev.text
                const now = Date.now()
                if (now - lastFlush >= STREAM_FLUSH_MS) { dispatch({ kind: 'hermes_delta', text: pending }); pending = ''; lastFlush = now }
                break
              }
              case 'tool':
                console.log('[runtime] stream: tool', ev.label)
                dispatch({ kind: 'hermes_tool', label: ev.label })
                break
              case 'tool_end':
                console.log('[runtime] stream: tool_end')
                dispatch({ kind: 'hermes_tool', label: null })
                break
              case 'done': {
                console.log('[runtime] stream: done, deltas=', deltaCount, 'finalText.len=', (ev.text || finalText).length)
                const finalReply = ev.text || finalText
                dispatch({ kind: 'hermes_ok', text: finalReply })
                appendTurn(bridge, {
                  conversation: e.conversation,
                  transcript: e.transcript,
                  reply: finalReply,
                  ts: Date.now(),
                  source: 'glasses',
                }).catch((err) => console.warn('[runtime] history persist failed:', err))
                break
              }
            }
          }
          }
        } catch (err) {
          const msg = err instanceof HermesError ? err.message : 'hermes error'
          console.error('[runtime] stream error:', msg)
          dispatch({ kind: 'hermes_err', message: msg })
        } finally {
          inflight = null
        }
        return
      }
      case 'reload_sessions': {
        const t0 = Date.now()
        try {
          const items = await buildDesktopItems(config.hermes)
          console.log('[runtime] reload_sessions -> desktopIds', JSON.stringify(Array.from(items.filter((x: any) => x.kind === 'session').map((x: any) => x.session.id)).map((s: string) => s.slice(0, 12))))
          desktopIds = new Set(items.filter((x: any) => x.kind === 'session').map((x: any) => x.session.id))
          await new Promise<void>((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))))
          dispatch({ kind: 'home_loaded', items })
        } catch (err) {
          console.error('[runtime] sessions load failed:', err)
          dispatch({ kind: 'home_loaded', items: [{ kind: 'new' }] })
        }
        return
      }
      case 'delete_session': {
        try { await deleteSession(config.hermes, e.conversation) } catch (err) { console.error('[runtime] delete session failed:', err) }
        try {
          const items = await buildDesktopItems(config.hermes)
          console.log('[runtime] reload_sessions -> desktopIds', JSON.stringify(Array.from(items.filter((x: any) => x.kind === 'session').map((x: any) => x.session.id)).map((s: string) => s.slice(0, 12))))
          desktopIds = new Set(items.filter((x: any) => x.kind === 'session').map((x: any) => x.session.id))
          dispatch({ kind: 'home_loaded', items })
        } catch (err) {
          console.error('[runtime] reload after delete failed:', err)
          dispatch({ kind: 'home_loaded', items: [{ kind: 'new' }] })
        }
        return
      }
      case 'load_local_history': {
        // 眼镜端本地历史:从本地 turns 还原为 messages(结构与桌面一致)
        const all = await loadHistory(bridge)
        const turns = all.filter((t) => t.conversation === e.conversation)
        const messages = turns.flatMap((t) => ([
          { role: 'user' as const, text: t.transcript },
          { role: 'assistant' as const, text: t.reply },
        ]))
        dispatch({ kind: 'session_history_loaded', messages })
        return
      }
      case 'load_session_history': {
        console.log('[runtime] load_session_history -> desktopIds.add', e.conversation.slice(0, 12))
        desktopIds.add(e.conversation) // 从 Desktop 列表进入,该会话必为桌面会话 → 发送走 sessionChat(接续)
        const t0 = Date.now()
        try {
          const messages = await getSessionMessages(config.hermes, e.conversation)
          await new Promise<void>((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))))
          dispatch({ kind: 'session_history_loaded', messages })
        } catch (err) {
          console.error('[runtime] session history failed:', err)
          dispatch({ kind: 'session_history_loaded', messages: [] }) // 防 loading 卡死
        }
        return
      }
      case 'abort_inflight': {
        if (inflight) { inflight.abort(); inflight = null }
        recorder.reset()
        return
      }
      case 'new_conversation': {
        if ((state as any).desktop) {
          // 桌面端新建会话:在 Hermes 创建真会话,后续走 /chat/stream 接续
          try {
            const id = await createSession(config.hermes)
            conversation = id
            desktopIds.add(id)
            state = { ...state, conversation: id } as State
            await saveConfig(bridge, { ...config, session: { ...config.session, lastName: id } })
            return
          } catch (err) {
            console.error('[runtime] create session failed, fallback local name:', err)
          }
        }
        seq += 1
        conversation = newConversationName(new Date(), seq)
        state = { ...state, conversation } as State
        await saveConfig(bridge, { ...config, session: { ...config.session, lastName: conversation } })
        return
      }
      case 'reload_history': {
        const t0 = Date.now()
        const items = await buildHomeItems(bridge)
        await new Promise<void>((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - t0))))
        dispatch({ kind: 'home_loaded', items })
        return
      }
      case 'exit_confirm': {
        await bridge.shutDownPageContainer(1)
        return
      }
      case 'render': {
        await render.render(state, tickIndex)
        return
      }
    }
  }

  // 3.5 打字机定时器:历史页(含流式)按 ~40ms 推进 reveal(平滑逐字)
  const revealTimer = setInterval(() => {
    if (state.kind !== 'idle') return
    const reply = state.reply ?? ''
    const rev = state.reveal
    if (rev == null) return
    if (rev < reply.length) dispatch({ kind: 'reveal' })
  }, REVEAL_TICK_MS)

  // 4. Subscribe to bridge events.
  const unsubHub = bridge.onEvenHubEvent((evt) => {
    if (evt.audioEvent?.audioPcm) {
      // 宿主可能给 Uint8Array / number[] / base64(SDK 文档如此);只认 Uint8Array
      // 会丢掉全部音频帧 → 录音没有内容 → 转写为空 → 直接回历史页
      const pcm = toPcmBytes(evt.audioEvent.audioPcm)
      if (pcm) {
        recorder.append(pcm)
        sttStream?.send(pcm)
      }
      return
    }
    // Temple-tap and scroll gestures come through as either textEvent
    // (when the event-capture text container is focused) or sysEvent
    // (the OS-level path; observed in the simulator). Treat both as the
    // same gesture stream. If eventType is missing entirely AND the
    // event came from a temple touch source, default to CLICK_EVENT.
    if (evt.textEvent || evt.sysEvent) {
      const sub = evt.textEvent ?? evt.sysEvent
      const raw = sub?.eventType
      const source = evt.sysEvent?.eventSource
      let gesture = gestureFromEventType(raw)
      // Simulator quirk: sysEvent with eventSource=GLASSES_R/L and no
      // eventType in the payload means "tap" (CLICK_EVENT = 0 was
      // omitted from the proto-to-json serialization).
      if (!gesture && evt.sysEvent && raw == null && (source === 1 || source === 2)) {
        gesture = 'TAP'
      }
      console.log('[runtime] gestureEvent', {
        via: evt.textEvent ? 'textEvent' : 'sysEvent',
        raw,
        source,
        gesture,
      })
      if (gesture) dispatch({ kind: 'gesture', gesture })
      return
    }
    if (evt.menuItemClickEvent) {
      const id = evt.menuItemClickEvent.itemID
      console.log('[runtime] menu item click', id)
      if (typeof id === 'number') dispatch({ kind: 'menu_action', itemID: id })
      return
    }
    // Anything else (listEvent, IMU, foreground/exit) we don't handle yet.
    console.log('[runtime] unhandled hub event keys:', Object.keys(evt))
  })

  const unsubDevice = bridge.onDeviceStatusChanged((status) => {
    const ct = status.connectType
    if (ct === DeviceConnectType.Connected) {
      if (state.kind === 'disconnected') dispatch({ kind: 'device_reconnected' })
    } else if (ct === DeviceConnectType.Disconnected || ct === DeviceConnectType.ConnectionFailed) {
      if (state.kind !== 'disconnected') dispatch({ kind: 'device_disconnected' })
    }
    // None and Connecting are transient — ignore them so we don't flip away from idle
    // during the initial BLE handshake right after createStartUpPageContainer succeeds.
  })

  window.addEventListener('beforeunload', () => {
    if (inflight) inflight.abort()
    bridge.audioControl(false).catch(() => {})
    stopAnimating()
    unsubHub()
    unsubDevice()
  })

  // 5. First paint, then asynchronously populate the home menu with recent turns.
  await render.render(state)

  // DEV-ONLY:演示模式下自动发一条消息,便于在模拟器里抓「回复页」原始截图
  if (import.meta.env.DEV) {
    const demo = await import('../dev-demo')
    if (demo.isDemoMode()) demo.scheduleDemoSend((text) => { void dispatch({ kind: 'phone_send', text }) })
  }
  buildHomeItems(bridge)
    .then((items) => dispatch({ kind: 'home_loaded', items }))
    .catch((err) => console.warn('[runtime] initial home load failed:', err))
}
