import {
  EvenAppBridge,
  TextContainerProperty,
  ImageContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
  ImageRawDataUpdateResult,
} from '@evenrealities/even_hub_sdk'
import { LOGO_SIZE, LOGO_PORTRAIT_PNG_BASE64, logoPortraitBytes } from './logo-data'
import { APP_DISPLAY_NAME, makeLayoutContainers, sleep } from './startup-page'

/**
 * 启动动画(官方要求「启动后立刻有 OS 渲染」+ 开场设计):
 *   1. 画面中央显示 Hermes Lens 的 LOGO(图像容器,灰度数据)
 *   2. 下方用打字机效果逐字打出「Hermes Lens」
 *   3. 再下方「—— Tap to start ——」闪烁,直到用户在眼镜上点击
 *   4. 点击后换成「已启动,请在手机上配置」的提示页(runtime 的容器布局),随后交给 runtime
 *
 * 动画页的容器 ID 与 runtime 不同(以免冲突);结束时用 rebuildPageContainer
 * 换成 runtime 期望的 1/2/3 布局,因此 runtime 走的是「复用已有页面」路径。
 */

const CANVAS_W = 576
const CANVAS_H = 288

/** 动画页容器 ID(与 runtime 的 1/2/3 不冲突) */
const C_NAME = 10
const C_HINT = 11
const C_LOGO = 12
/** 「粗体」副本容器:与名字容器重叠、右移几像素,形成 faux bold */
const C_NAME_BOLD = 13

/**
 * "清空"用空格而不是空串:实测真机上 `content: ''` 会被当作"无变化"忽略,
 * 导致清屏/闪烁失效(模拟器则正常)。任何"看不见但要有内容"的地方都用它。
 */
const EMPTY = ' '

/** 打字机要打出的名字(固定字符串,便于校准居中偏移) */
export const NAME_TEXT = 'Hermes Lens'
/** 闪烁提示语 */
export const HINT_TEXT = '—— Tap to start ——'

/**
 * 固件字体非等宽、SDK 也没有对齐字段,所以水平居中只能自己算:
 * 在模拟器里实测字符串的点亮像素宽度后,把 容器左边界 = (576 - 宽度)/2 填在这里。
 * 名字的粗体副本向右/下各偏 1px(偏移大了会出现重影)。
 */
export const BOLD_DX = 1
export const BOLD_DY = 1
export const NAME_X = 233
export const HINT_X = 206

const CONTENT_DY = 0 // 整屏内容微调:负值整体上移
/** LOGO 区的中心线(两个素材尺寸不同也共用同一条中心线,切换时不会跳) */
const LOGO_CY = 100 + CONTENT_DY
const LOGO_X = Math.round((CANVAS_W - LOGO_SIZE) / 2)
const LOGO_Y = Math.round(LOGO_CY - LOGO_SIZE / 2)
const NAME_Y = 178 + CONTENT_DY
const HINT_Y = 214 + CONTENT_DY
const LINE_H = 40

const TYPE_START_DELAY_MS = 0     // 立刻开始打字
const TYPE_STEP_MS = 25
const TYPE_HOLD_MS = 350
const BLINK_MS = 650

// 启动即显示 Hermes 头像;留一点点时间让图像落屏,然后立刻开始打字
const LOGO_PORTRAIT_MS = 250

function nameBox(content: string, dx = 0, dy = 0, bold = false): TextContainerProperty {
  const x = NAME_X + dx
  return new TextContainerProperty({
    xPosition: x,
    yPosition: NAME_Y + dy,
    width: CANVAS_W - x,
    height: LINE_H,
    borderWidth: 0,
    paddingLength: 0,
    containerID: bold ? C_NAME_BOLD : C_NAME,
    containerName: bold ? 'name-bold' : 'name',
    content,
    // 只有主容器捕获事件;粗体副本只负责显示
    isEventCapture: bold ? 0 : 1,
  })
}

function hintBox(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: HINT_X,
    yPosition: HINT_Y,
    width: CANVAS_W - HINT_X,
    height: LINE_H,
    borderWidth: 0,
    paddingLength: 0,
    containerID: C_HINT,
    containerName: 'hint',
    content,
    isEventCapture: 0,
  })
}

/** 组装动画页的容器(建页与重建共用)。 */
function animationPageParts(): { textObject: TextContainerProperty[]; imageObject: ImageContainerProperty[] } {
  return {
    textObject: [nameBox(EMPTY), nameBox(EMPTY, BOLD_DX, BOLD_DY, true), hintBox(EMPTY)],
    imageObject: [new ImageContainerProperty({
      xPosition: LOGO_X,
      yPosition: LOGO_Y,
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      containerID: C_LOGO,
      containerName: 'logo',
    })],
  }
}

/** 创建启动动画页:LOGO 容器 + 名字行(含粗体副本)+ 提示行。
 *  首帧就有名字,保证启动即有渲染。若页面已存在(例如 WebView 热重载后),
 *  退化为用 rebuildPageContainer 换成动画页,保证动画照常播放。 */
export type PageMode = 'new' | 'reuse' | 'fail'

export async function createAnimationPage(bridge: EvenAppBridge): Promise<PageMode> {
  const { textObject, imageObject } = animationPageParts()
  try {
    const result = await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
      containerTotalNum: 4,
      textObject,
      imageObject,
    }))
    if (result === 0) return 'new'
    console.warn('[startup] animation page rejected:', result, '-> try rebuild')
  } catch (err) {
    console.warn('[startup] animation page failed:', err, '-> try rebuild')
  }
  try {
    await bridge.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: 4,
      textObject,
      imageObject,
    }))
    return 'reuse'
  } catch (err) {
    console.error('[startup] animation rebuild failed:', err)
    return 'fail'
  }
}

export type LogoPush = { ok: boolean; how: 'bytes' | 'base64' | 'none'; ms: number }

/** 把 LOGO 推给图像容器(必须在建页之后调用)。
 *  宿主差异:模拟器只认 base64 的真实图片字节;真机更可能吃文档推荐的裸字节(number[])。
 *  所以两种都试,谁先成功算谁,并把结果返回给调用方做诊断。 */
export async function pushLogo(bridge: EvenAppBridge): Promise<LogoPush> {
  const variants: Array<{ how: 'bytes' | 'base64'; data: Uint8Array | string }> = [
    { how: 'bytes', data: logoPortraitBytes() },
    { how: 'base64', data: LOGO_PORTRAIT_PNG_BASE64 },
  ]
  for (const v of variants) {
    const t0 = Date.now()
    try {
      const res = await bridge.updateImageRawData({
        containerID: C_LOGO,
        containerName: 'logo',
        imageData: v.data,
      })
      const ms = Date.now() - t0
      console.log('[startup] logo', v.how, '->', res, ms + 'ms')
      if (res === ImageRawDataUpdateResult.success) return { ok: true, how: v.how, ms }
    } catch (err) {
      console.warn('[startup] logo', v.how, 'threw:', err)
    }
  }
  return { ok: false, how: 'none', ms: 0 }
}

/** 名字两行(主 + 粗体副本)一起设,用于字面兜底。 */
async function setPlainName(bridge: EvenAppBridge, content: string): Promise<void> {
  try {
    await bridge.textContainerUpgrade({ containerID: C_NAME, containerName: 'name', content })
    void bridge.textContainerUpgrade({ containerID: C_NAME_BOLD, containerName: 'name-bold', content }).catch(() => {})
  } catch { /* ignore */ }
}

/**
 * 开场:启动即显示 Hermes 的黑白头像(已去掉 He 图标那一帧),随后立刻开始打字。
 * 诊断信息只写日志(真机实测:裸字节可用,推送耗时约 620ms,比模拟器慢很多)。
 */
export async function playLogoIntro(bridge: EvenAppBridge, pageMode: PageMode): Promise<string> {
  const p = await pushLogo(bridge)
  if (!p.ok) await setPlainName(bridge, NAME_TEXT) // LOGO 推不上去时不能留白屏
  await sleep(LOGO_PORTRAIT_MS)
  const tag = (r: LogoPush): string => (r.ok ? (r.how === 'bytes' ? 'B' : 'b') + r.ms : 'x')
  const dbg = `${pageMode} P:${tag(p)}`
  console.log('[startup] intro', dbg)
  return dbg
}

/** 「Hermes Lens」逐字打出(粗体副本同步,但不等它,免得拖慢主行)。 */
export async function typeName(bridge: EvenAppBridge): Promise<void> {
  await sleep(TYPE_START_DELAY_MS)
  const setText = (content: string, bold: boolean): Promise<unknown> =>
    bridge.textContainerUpgrade({
      containerID: bold ? C_NAME_BOLD : C_NAME,
      containerName: bold ? 'name-bold' : 'name',
      content,
    }).catch(() => undefined) as Promise<unknown>
  await setText(EMPTY, false) // 首帧 await,确保清屏真的上屏
  void setText(EMPTY, true)
  for (let i = 1; i <= NAME_TEXT.length; i += 1) {
    const slice = NAME_TEXT.slice(0, i)
    // 不 await:文本是全量覆盖 + 通道有序,万一丢一帧会被下一帧自动纠正。
    // 真机通道比模拟器慢一个量级,等回执会把打字卡慢一倍,这是最关键的一处提速。
    void setText(slice, false)
    if (i % 4 === 0) void setText(slice, true) // 粗体副本每 4 字同步一次
    await sleep(TYPE_STEP_MS)
  }
  void setText(NAME_TEXT, true) // 收尾对齐粗体副本
  await sleep(TYPE_HOLD_MS)
}

function isStartTap(evt: { textEvent?: { eventType?: unknown }; sysEvent?: { eventType?: unknown; eventSource?: unknown } }): boolean {
  const sub = evt.textEvent ?? evt.sysEvent
  if (!sub) return false
  const t = OsEventTypeList.fromJson(sub.eventType)
  if (t === OsEventTypeList.CLICK_EVENT || t === OsEventTypeList.DOUBLE_CLICK_EVENT) return true
  // 模拟器/宿主 quirk:sysEvent 带 eventSource(眼镜左右)但没有 eventType,等同于单击
  if (evt.sysEvent && sub.eventType == null) {
    const src = evt.sysEvent.eventSource
    if (src === 1 || src === 2) return true
  }
  return false
}

/** 「—— Tap to start ——」闪烁,直到用户点击。 */
export function waitForStartTap(bridge: EvenAppBridge): Promise<void> {
  return new Promise<void>((resolve) => {
    let visible = false
    let done = false
    let timer: ReturnType<typeof setInterval> | null = null
    const unsub = bridge.onEvenHubEvent((evt) => {
      if (isStartTap(evt as never)) finish()
    })
    const finish = (): void => {
      if (done) return
      done = true
      if (timer) { clearInterval(timer); timer = null }
      unsub()
      // 点击后把提示定住(重建前的一帧不至于空着)
      void bridge.textContainerUpgrade({ containerID: C_HINT, containerName: 'hint', content: HINT_TEXT }).catch(() => {})
      resolve()
    }
    visible = true
    void bridge.textContainerUpgrade({ containerID: C_HINT, containerName: 'hint', content: HINT_TEXT }).catch(() => {})
    timer = setInterval(() => {
      if (done) return
      visible = !visible
      void bridge.textContainerUpgrade({
        containerID: C_HINT,
        containerName: 'hint',
        content: visible ? HINT_TEXT : EMPTY,
      }).catch(() => {})
    }, BLINK_MS)
  })
}

/**
 * 换成「提示配置 / 已启动」页:用 runtime 期望的 1/2/3 容器几何重建,
 * 这样连同 LOGO 图像容器一起被替换掉,runtime 随后只需 textContainerUpgrade。
 */
/** 把页面交还给 runtime:用 runtime 期望的 1/2/3 容器重建(内容清空)。
 *  不再显示中间的「已启动」提示页 —— 点击 Tap to start 后直接进入会话界面。 */
export async function prepareRuntimePage(bridge: EvenAppBridge): Promise<void> {
  try {
    const [status, main, footer] = makeLayoutContainers(APP_DISPLAY_NAME, EMPTY, '')
    await bridge.rebuildPageContainer(new RebuildPageContainer({
      containerTotalNum: 3,
      textObject: [status, main, footer],
    }))
  } catch (err) {
    console.error('[startup] prepareRuntimePage failed:', err)
  }
}

/** 未配置时:直接在动画页上给出「去手机端配置」提示(不再有单独的提示页)。 */
export async function showConfigureHint(bridge: EvenAppBridge): Promise<void> {
  try {
    await bridge.textContainerUpgrade({ containerID: C_NAME, containerName: 'name', content: 'Hermes Lens 已启动,请在手机上配置。' })
    void bridge.textContainerUpgrade({ containerID: C_NAME_BOLD, containerName: 'name-bold', content: EMPTY }).catch(() => {})
    await bridge.textContainerUpgrade({ containerID: C_HINT, containerName: 'hint', content: 'Configure it on the phone.' })
  } catch { /* ignore */ }
}

/** 是否双击(与 isStartTap 同一套事件归一化)。 */
function isDoubleClick(evt: { textEvent?: { eventType?: unknown }; sysEvent?: { eventType?: unknown } }): boolean {
  const sub = evt.textEvent ?? evt.sysEvent
  if (!sub) return false
  return OsEventTypeList.fromJson(sub.eventType) === OsEventTypeList.DOUBLE_CLICK_EVENT
}

/**
 * 未配置(停在「请在手机上配置」页)时,插件同样是一个 app:
 * 双击镜腿应能呼出「退出」提示 —— 官方审阅意见要求,没有手机配置时也要能退出。
 * 返回退订函数(正常流程里一直保留,直到插件退出)。
 */
export function keepDoubleTapExit(bridge: EvenAppBridge): () => void {
  return bridge.onEvenHubEvent((evt) => {
    if (!isDoubleClick(evt as never)) return
    console.log('[startup] double-tap -> exit prompt')
    void bridge.shutDownPageContainer(1)   // 1 = 弹前台交互层,由用户决定是否退出
  })
}
