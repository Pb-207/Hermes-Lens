import { loadConfig, isConfigured } from './config'
import { renderSetupView } from './setup-view'
import { startRuntime } from './runtime/runtime'
import { getBridgeWithDevFallback } from './dev-bridge'
import { createAnimationPage, playLogoIntro, typeName, waitForStartTap, prepareRuntimePage, showConfigureHint } from './startup-animation'

async function boot(): Promise<void> {
  const bridge = await getBridgeWithDevFallback()

  // 官方要求:app 启动后眼镜上必须「立刻」有渲染,不能黑屏。
  // 第一步就建启动动画页(LOGO + 名称),所以首帧一定有内容。
  const pageMode = await createAnimationPage(bridge)

  // 运行时提示页:始终带「Configure / 配置」按钮(否则保存启动后按钮会消失)
  const mountShim = (): void => {
    const app = document.getElementById('app')
    if (!app) return
    app.innerHTML = `
    <main class="runtime-shim">
      Glasses runtime active. See your G2.
      <br /><button id="reconfigure">Configure / 配置</button>
    </main>
  `
    document.getElementById('reconfigure')?.addEventListener('click', () => { void openSetup() })
  }

  // 保存并重启:配置已写入,这里只负责关闭插件(用户从 Even App 重新打开即生效)
  const onRestart = async (): Promise<void> => {
    try {
      await bridge.shutDownPageContainer(0)   // 0 = 立即退出
    } catch (err) {
      console.warn('[main] shutdown failed:', err)
    }
  }

  const openSetup = async (): Promise<void> => {
    await renderSetupView({ storage: bridge, onRestart })
  }

  // DEV-ONLY:模拟器演示模式(?demo=1)预置一份指向本地 mock 网关的配置,便于抓原始截图
  if (import.meta.env.DEV) {
    const demo = await import('./dev-demo')
    if (demo.isDemoMode()) await demo.seedDemoConfig(bridge)
  }

  // 读配置与动画并行(只是一次本地读,不会拖慢启动)
  const config = await loadConfig(bridge)
  const configured = isConfigured(config)

  if (pageMode === 'fail') {
    // 连动画页都建不出来(极罕见):直接交还 runtime 布局,至少不黑屏
    await prepareRuntimePage(bridge)
  } else {
    // 1. LOGO(He -> 头像) 2. 打字机打出名字 3. —— Tap to start —— 闪烁,直到点击
    await playLogoIntro(bridge, pageMode)
    await typeName(bridge)
    await waitForStartTap(bridge)
  }

  if (!configured) {
    // 未配置:停在这一页给提示,并打开手机端配置页
    await showConfigureHint(bridge)
    await openSetup()
    return
  }

  // 已配置:点击后立刻进入会话界面(不再有中间提示页 / 等待)
  await prepareRuntimePage(bridge)
  mountShim()
  await startRuntime({ bridge, config, pageCreated: true })
}

boot().catch((err) => {
  console.error('[boot] fatal:', err)
  const root = document.getElementById('app')
  if (root) root.innerHTML = `<main class="runtime-shim">⚠ ${String(err)}</main>`
})
