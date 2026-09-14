# 已知坑与排错 / Pitfalls & Troubleshooting

中英对照,每条一行。中文在前,English after。
Bilingual, one item per block — 中文 then English.

**范围**:只覆盖**部署**——把 Hermes 端服务跑起来、让插件连上时会遇到的问题。
**Scope**: **deployment only** — issues you hit while getting the Hermes-side services running and the plugin connected.

---

## 1. 插件报 `Failed to fetch`(眼镜端/手机端都一样)

**原因**:Hermes 某些版本里 `POST /api/sessions/{id}/chat/stream` 的 **200 SSE 响应没有 CORS 头**(aiohttp 的 CORS 中间件不处理 `StreamResponse`)。WebView 跨域,浏览器直接拒绝该响应。注意 404 之类的响应**反而带头**,别被误导。
**处理**:跑 `scripts/check-cors.ps1`;缺头就按 `SKILL.md` 步骤 3 给 `api_server.py` 的 `StreamResponse` 加 CORS 头,然后 `hermes gateway restart`。

**Cause**: on some Hermes builds the 200 SSE response of `/chat/stream` carries **no CORS header**
(aiohttp's CORS middleware skips `StreamResponse`); the cross-origin WebView then rejects it.
Plain 404 responses DO carry the header, which misleads.
**Fix**: run `scripts/check-cors.ps1`; if missing, patch the `StreamResponse` headers per step 3, then restart the gateway.

---

## 2. 升级 Hermes 之后,这个补丁还需不需要重新打

**新版(≥ 0.21.2)不需要**:CORS 头已由网关自带,`api_server.py` 里手工加的补丁即使被 `hermes update` 覆盖也没关系(实测该端点仍返回完整 CORS 头)。
**旧版(≤ 0.21.1)**:`hermes update` 会覆盖补丁 → 插件又开始 `Failed to fetch`,需要重新打。
**通用做法**:每次升级后跑一次 `scripts/check-cors.ps1` —— 退出 0 就什么都不用做,返回 1 才按 `SKILL.md` 步骤 3 打补丁。

**Newer builds (≥ 0.21.2) don't need it**: the gateway sends the CORS headers itself, so losing the manual
patch to `hermes update` is harmless (verified: the endpoint still returns full CORS headers).
**Older builds (≤ 0.21.1)**: `hermes update` wipes the patch → `Failed to fetch` returns; re-apply it.
**Either way**: run `scripts/check-cors.ps1` after an upgrade — exit 0 means do nothing, exit 1 means patch per step 3.

---

## 3. 本地 STT 第一次转写就 500(`cublas64_12.dll` 找不到)

**原因**:Windows 上 ctranslate2 首次跑模型时要 dlopen `cublas64_12.dll` / `cudnn*.dll` / `cudart64_12.dll`。这些来自 nvidia pip wheels,位于 `<site-packages>/nvidia/*/bin`,**不在默认 PATH 里**。
**处理**:用 `scripts/start-stt.ps1` 启动(它会把 `nvidia/*/bin` 前置进 PATH);连 `cudart64_12.dll` 都缺时执行 `uv pip install nvidia-cuda-runtime-cu12`。
**注意**:只在 Python 里 `os.add_dll_directory()` **不一定够**(`scripts/server.py` 里两边都做了,双保险)。

**Cause**: on Windows ctranslate2 dlopens `cublas64_12.dll` / `cudnn*.dll` / `cudart64_12.dll` on first run;
they ship in the nvidia pip wheels under `<site-packages>/nvidia/*/bin` and are **not on PATH**.
**Fix**: always start via `scripts/start-stt.ps1` (prepends those dirs); if `cudart64_12.dll` is missing,
`uv pip install nvidia-cuda-runtime-cu12`. `os.add_dll_directory()` alone is not always enough.

---

## 4. 插件只在眼镜前台工作(别期待后台提醒)

Even Hub 插件**没有通知/推送接口**,而且**只能在眼镜前台运行**:息屏或切到后台时,WebView 被系统挂起,连网络请求都会停。所以"息屏时自动检测并提醒"这类功能是做不到的。需要提醒请走**插件之外**的渠道(例如让 Hermes 把消息推到手机上的即时通讯,再由 Even App 的通知设置同步给眼镜)。

The SDK exposes **no notification/push API** and the plugin is **foreground-only** (a backgrounded WebView is
suspended, network stalls). So "detect while the screen is off and notify" is not possible. If you need an
alert, use an **out-of-plugin** channel (e.g. Hermes pushing to a phone messenger, then Even App's
notification settings mirroring it to the glasses).

---

## 5. 手机 Even App 版本太旧,插件装不上/黑屏

新 SDK 打包会把**最低 Even App 版本**抬上去(例如 SDK 0.0.15 → **≥2.2.10**)。手机端 Even App 低于该版本时,插件可能装不上或打开即黑屏。
**处理**:把 Even App 升级到最新;仍然失败时确认插件 build 的最低版本要求。

A newer SDK raises the **minimum Even App version** (e.g. SDK 0.0.15 → **≥2.2.10**). An older Even App may
fail to install the plugin or show a black screen. Update Even App; if it still fails, check the build's
minimum version requirement.

---

## 6. 说话时眼镜上不出现实时文字(但转写本身是对的)

**原因**:插件优先走 **WebSocket 流式**;"边说边出字"依赖服务端支持它。若 8765 上跑的不是自带的那份
`scripts/server.py`(例如早期副本、或换成只用 REST 的 OpenAI 兼容端点),握手失败后插件会**静默回落**成
整段转写 —— 功能还在,只是说完才出文字,容易误判成"没在转写"。
**处理**:用自带的 `scripts/server.py` 启动(见步骤 5);确认服务端版本支持流式(REST 之外的 `/` WebSocket 端点)。
**另**:流式只在**录音过程中**显示;停止录音后,识别结果会作为这一轮的输入发出去。

**Cause**: the plugin prefers **WebSocket streaming**, and the live text depends on the server supporting it.
If port 8765 is served by something else (an early copy, or a REST-only OpenAI-compatible endpoint), the
handshake fails and the plugin **silently falls back** to one-shot transcription — it still works, the text
just appears only after you stop, which easily reads as "nothing is being transcribed".
**Fix**: start the bundled `scripts/server.py` (step 5) and make sure the server exposes the streaming endpoint
alongside the REST one.

---

## 7. 模型又下载了一遍(几个 GB)

`scripts/start-stt.ps1` 默认把模型缓存放在 `~/stt-models`。如果模型已经在别处(比如 `D:\Models\STT`),
不指定就会重新下载。
**处理**:加 `-ModelDir "D:\Models\STT"`(该目录就是 `HF_HOME`,里面应有 `hub/` 子目录)。

**Cause**: `start-stt.ps1` defaults the cache to `~/stt-models`; an existing model elsewhere is ignored.
**Fix**: pass `-ModelDir "D:\Models\STT"` (that path is used as `HF_HOME` and should contain `hub/`).
