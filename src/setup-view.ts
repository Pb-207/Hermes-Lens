import { loadConfig, saveConfig, isConfigured, trimTrailingSlash, parseLabels, serializeLabels, type AppConfig, type StorageLike } from './config'

export type SetupViewOptions = {
  storage: StorageLike
  /** 「保存并重启」确认后调用:由调用方负责关闭插件(用户需从 Even App 重新打开) */
  onRestart: () => void
}

type Lang = 'zh' | 'en'

// 手机端配置页文案(中/英)。切换语言时整个页面按此重渲染。
const T: Record<Lang, Record<string, string>> = {
  zh: {
    title: 'Hermes Lens',
    language: '语言 / Language',
    gateway: 'Hermes 网关',
    baseUrl: '基础地址',
    apiKey: 'API 密钥',
    model: '模型',
    instructions: '指令(可选)',
    instructionsPh: '例如:简洁回答,800 字以内。',
    testHermes: '测试 Hermes',
    stt: '语音识别',
    testStt: '测试 STT',
    guideTitle: '操作指南',
    guideZh: '① 眼镜端:进入「桌面端」→ 选中一个会话(或「+ 新建会话」)。\n② 眼镜端:单按镜腿开始说话,再按一次结束;识别到的文本会直接发给 Hermes。\n③ 眼镜端:说话时逐句显示识别结果,回复在同一历史页逐字流式;双击镜腿:录音中=取消并回历史页,流式中=回会话列表。\n④ 眼镜端:点击后点按镜腿呼出菜单(会话列表页可「删除会话」,再点一次确认)。\n⑤ 手机端:在本页下方直接打字(或「+ 图片」)发送,需先在眼镜端选中会话。\n⑥ 语言:上面的「中文 / English」同时决定眼镜端菜单与提示的语言。',
    guideEn: '① Glasses: open Desktop then pick a session (or the new-session item).\n② Glasses: press the temple to talk, press again to stop; the transcript goes straight to Hermes.\n③ Glasses: recognised text appears line by line as you speak and the reply streams in the same history page; double-press cancels a recording or goes back to the session list.\n④ Glasses: tap then press-and-hold the temple for the menu (on the session list there is a delete-session item; tap once more to confirm).\n⑤ Phone: type below on this page (or use the image button) to send; pick a session on the glasses first.\n⑥ Language: the 中文 / English buttons above also switch the glasses menu and hints.',
    save: '保存并重启',
    needFields: '所有 URL / 密钥 / 模型字段均为必填。',
    fillFirst: '✗ 请先填写地址和密钥',
    testing: '… 测试中',
    restartTitle: '配置已保存',
    restartBody: '插件现在将关闭,请从 Even App 重新打开 Hermes Lens —— 重启后新配置才会生效。',
    restartOk: '关闭插件',
    restartCancel: '取消',
  },
  en: {
    title: 'Hermes Lens',
    language: 'Language / 语言',
    gateway: 'Hermes gateway',
    baseUrl: 'Base URL',
    apiKey: 'API key',
    model: 'Model',
    instructions: 'Instructions (optional)',
    instructionsPh: 'e.g. Be concise. Reply in under 800 chars.',
    testHermes: 'Test Hermes',
    stt: 'Speech-to-text',
    testStt: 'Test STT',
    guideTitle: 'How to use',
    guideZh: '① 眼镜端:进入「桌面端」→ 选中一个会话(或「+ 新建会话」)。\n② 眼镜端:单按镜腿开始说话,再按一次结束;识别到的文本会直接发给 Hermes。\n③ 眼镜端:说话时逐句显示识别结果,回复在同一历史页逐字流式;双击镜腿:录音中=取消并回历史页,流式中=回会话列表。\n④ 眼镜端:点击后点按镜腿呼出菜单(会话列表页可「删除会话」,再点一次确认)。\n⑤ 手机端:在本页下方直接打字(或「+ 图片」)发送,需先在眼镜端选中会话。\n⑥ 语言:上面的「中文 / English」同时决定眼镜端菜单与提示的语言。',
    guideEn: '① Glasses: open Desktop then pick a session (or the new-session item).\n② Glasses: press the temple to talk, press again to stop; the transcript goes straight to Hermes.\n③ Glasses: recognised text appears line by line as you speak and the reply streams in the same history page; double-press cancels a recording or goes back to the session list.\n④ Glasses: tap then press-and-hold the temple for the menu (on the session list there is a delete-session item; tap once more to confirm).\n⑤ Phone: type below on this page (or use the image button) to send; pick a session on the glasses first.\n⑥ Language: the 中文 / English buttons above also switch the glasses menu and hints.',
    save: 'Save & restart',
    needFields: 'All URL/key/model fields are required.',
    fillFirst: '✗ fill base URL and key first',
    testing: '… testing',
    restartTitle: 'Settings saved',
    restartBody: 'The plugin will now close. Reopen Hermes Lens from the Even App — the new settings take effect once it restarts.',
    restartOk: 'Close plugin',
    restartCancel: 'Cancel',
  },
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

async function fetchJsonish(url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: string }> {
  try {
    const res = await fetch(url, init)
    const body = await res.text()
    return { ok: res.ok, status: res.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: `network: ${(err as Error).message}` }
  }
}

/**
 * 「保存并重启」确认弹层。
 * 用页面内弹层而不是 window.confirm:Even WebView 里原生 confirm 不一定弹得出来。
 */
function showRestartNotice(
  t: { title: string; body: string; ok: string; cancel: string },
  onConfirm: () => void,
): void {
  const host = document.createElement('div')
  host.id = 'restart-notice'
  host.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;' +
    'z-index:10000;padding:16px'
  host.innerHTML =
    '<div style="max-width:420px;width:100%;background:#1b1b1b;color:#eee;border:1px solid #444;' +
    'border-radius:10px;padding:16px;font:14px/1.5 system-ui,sans-serif">' +
      `<div style="font-weight:600;margin-bottom:8px">${t.title}</div>` +
      `<p style="margin:0 0 14px;white-space:pre-line;opacity:.9">${t.body}</p>` +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        `<button id="restart-cancel" style="padding:8px 14px;border-radius:6px;border:1px solid #555;background:#222;color:#eee;font:inherit">${t.cancel}</button>` +
        `<button id="restart-ok" style="padding:8px 16px;border-radius:6px;border:0;background:#ef4444;color:#fff;font:inherit">${t.ok}</button>` +
      '</div>' +
    '</div>'
  document.body.appendChild(host)
  document.getElementById('restart-cancel')?.addEventListener('click', () => host.remove())
  document.getElementById('restart-ok')?.addEventListener('click', () => {
    host.remove()
    onConfirm()
  })
}

export async function renderSetupView(opts: SetupViewOptions): Promise<void> {
  const root = document.getElementById('app')
  if (!root) throw new Error('no #app element in DOM')

  // 配置页不应出现手机端聊天面板(runtime 可能仍在后台运行)
  const phoneHost = document.getElementById('phone-ui')
  if (phoneHost) phoneHost.style.display = 'none'

  const cfg = await loadConfig(opts.storage)
  const lang: Lang = cfg.lang === 'en' ? 'en' : 'zh'
  const t = T[lang]

  root.innerHTML = `
    <main class="setup">
      <h1>${t.title}</h1>

      <div style="display:flex; align-items:center; gap:.5rem; margin:.5rem 0 1rem;">
        <span style="opacity:.8;">${t.language}</span>
        <button id="lang-zh" style="min-width:auto; padding:.3rem .8rem; ${lang === 'zh' ? 'background:#3b82f6;color:#fff;font-weight:700;' : 'background:#333;color:#ccc;'}">中文</button>
        <button id="lang-en" style="min-width:auto; padding:.3rem .8rem; ${lang === 'en' ? 'background:#3b82f6;color:#fff;font-weight:700;' : 'background:#333;color:#ccc;'}">English</button>
      </div>

      <section>
        <h2>${t.gateway}</h2>
        <label>${t.baseUrl}
          <input id="h-url" value="${escapeAttr(cfg.hermes.baseUrl)}" placeholder="http://your-hermes-host:8642" />
        </label>
        <label>${t.apiKey}
          <input id="h-key" type="password" value="${escapeAttr(cfg.hermes.apiKey)}" />
        </label>
        <label>${t.model}
          <input id="h-model" value="${escapeAttr(cfg.hermes.model)}" placeholder="hermes-agent" />
        </label>
        <label>${t.instructions}
          <textarea id="h-inst" rows="3" placeholder="${escapeAttr(t.instructionsPh)}">${escapeAttr(cfg.hermes.instructions)}</textarea>
        </label>
        <button id="test-hermes">${t.testHermes}</button>
        <pre id="hermes-result"></pre>
      </section>

      <section>
        <h2>${t.stt}</h2>
        <label>${t.baseUrl}
          <input id="s-url" value="${escapeAttr(cfg.stt.baseUrl)}" placeholder="http://your-stt-host:8000" />
        </label>
        <label>${t.apiKey}
          <input id="s-key" type="password" value="${escapeAttr(cfg.stt.apiKey)}" />
        </label>
        <label>${t.model}
          <input id="s-model" value="${escapeAttr(cfg.stt.model)}" placeholder="whisper-1" />
        </label>
        <button id="test-stt">${t.testStt}</button>
        <pre id="stt-result"></pre>
      </section>

      <section>
        <h2>${t.guideTitle}</h2>
        <p style="white-space:pre-line; font-size:.85rem; line-height:1.7; margin:0">${lang === 'zh' ? t.guideZh : t.guideEn}</p>
      </section>

      <section>
        <button id="save-launch" class="primary">${t.save}</button>
        <p id="save-error" style="color:#f66; min-height: 1.2em; margin: 0;"></p>
      </section>
    </main>
  `

  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const url = (id: string) => trimTrailingSlash(($(id) as HTMLInputElement).value.trim())
  const val = (id: string) => ($(id) as HTMLInputElement).value.trim()
  const ta  = (id: string) => ($(id) as HTMLTextAreaElement).value

  const setHermesResult = (msg: string) => { $<HTMLPreElement>('hermes-result').textContent = msg }
  const setSttResult    = (msg: string) => { $<HTMLPreElement>('stt-result').textContent = msg }
  const setSaveError    = (msg: string) => { $<HTMLParagraphElement>('save-error').textContent = msg }

  // 收集当前表单 → AppConfig(带指定语言)
  const collect = (lg: Lang): AppConfig => ({
    hermes: { baseUrl: url('h-url'), apiKey: val('h-key'), model: val('h-model') || 'hermes-agent', instructions: ta('h-inst') },
    stt:    { baseUrl: url('s-url'), apiKey: val('s-key'), model: val('s-model') || 'whisper-1' },
    session: { lastName: cfg.session.lastName, labels: cfg.session.labels },
    lang: lg,
  })

  // 语言切换:保存当前表单 + 新语言,再整体重渲染(页面文案同步切换)
  $('lang-zh').addEventListener('click', async () => {
    if (lang !== 'zh') { await saveConfig(opts.storage, collect('zh')); await renderSetupView(opts) }
  })
  $('lang-en').addEventListener('click', async () => {
    if (lang !== 'en') { await saveConfig(opts.storage, collect('en')); await renderSetupView(opts) }
  })

  $('test-hermes').addEventListener('click', async () => {
    const baseUrl = url('h-url'); const key = val('h-key')
    if (!baseUrl || !key) { setHermesResult(t.fillFirst); return }
    setHermesResult(t.testing)
    const r = await fetchJsonish(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
    setHermesResult(`${r.ok ? '✓' : '✗'} ${r.status}\n${r.body.slice(0, 400)}`)
  })

  $('test-stt').addEventListener('click', async () => {
    const baseUrl = url('s-url'); const key = val('s-key'); const model = val('s-model') || 'whisper-1'
    if (!baseUrl || !key) { setSttResult(t.fillFirst); return }
    setSttResult(t.testing)
    // 1 second of silence at 16 kHz mono 16-bit PCM, wrapped in a tiny WAV
    const pcm = new Uint8Array(32000)
    const { pcmToWav } = await import('./runtime/audio')
    const wav = pcmToWav(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 })
    const form = new FormData()
    form.append('file', wav, 'silence.wav')
    form.append('model', model)
    const r = await fetchJsonish(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    })
    setSttResult(`${r.ok ? '✓' : '✗'} ${r.status}\n${r.body.slice(0, 400)}`)
  })

  $('save-launch').addEventListener('click', async () => {
    const next = collect(lang)
    if (!isConfigured(next)) {
      setSaveError(t.needFields)
      return
    }
    setSaveError('')
    await saveConfig(opts.storage, next)
    // 配置写入后先提示,再由用户确认关闭插件(改动要等插件重启才生效)
    showRestartNotice(
      { title: t.restartTitle, body: t.restartBody, ok: t.restartOk, cancel: t.restartCancel },
      () => opts.onRestart(),
    )
  })
}
