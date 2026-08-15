# `@deepseek-ai/dsh-electron`

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面应用。Electron Main 通过 [`cordis.patch.yml`](cordis.patch.yml) 启动现有 `web` profile；该 overlay 会禁用 HTTP 服务器、Web 专用运行时和客户端 HMR 配置项，同时保留 Agent、会话、LLM provider、工具、文件系统、shell、设置与客户端插件名单。Renderer 通过 `file://` 加载已构建的 React 应用，不会打开本地端口。

从仓库启动时保留 profile 的常规模块回退，从而经 pnpm 开发依赖树解析每个 workspace 插件。打包启动则把应用安装目录作为裸包解析基准，因为 profile 外部的 symlink 无法穿入 `app.asar`；两种方式都不会改变 profile 相对配置路径的解析。

## 运行时

经过 sandbox 的 preload 会在 React 入口运行前暴露两个值：`window.__DSH_BOOT__` 是 Host 组合出的客户端插件图，`window.__DSH_ELECTRON__` 是仅包含请求、取消与事件流的窄 API。`ElectronApiClient` 使用该 API 承载 unary RPC 以及 `events.mux`／`events.host` 两条流。Electron Main 会校验每条 IPC 消息均来自当前 Harness 窗口，经 `ctx.connection` 分发 unary 请求，并在窗口关闭时中止其拥有的全部工作。

客户端插件脚本仍不进入 Vite 静态 bundle。Electron Main 通过 privileged `dsh-plugin://` 协议仅提供 `ctx.clientModules.graph()` 中存在的 id，并用 `ctx.clientModules.clientPath()` 解析每个 id；Renderer 不会获得任意文件系统读取能力。`contextIsolation`、Renderer sandbox、Web security 与禁用 Node integration 均保持开启。

## 构建与运行

在仓库根目录执行一个命令即可构建全部所需产物并启动桌面应用：

```sh
pnpm electron
```

`pnpm install` 会下载当前平台的 Electron runtime。通过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 安装的 checkout 可以完成类型检查和构建，但在补装 Electron runtime 前无法打开桌面窗口。

发布构建会把第三方 JavaScript 写入 `app.asar`，同时保持所有 `@deepseek-ai` 包以及 electron-builder 检测出的原生模块或可执行文件处于解包状态。因此，客户端 bundle、worker 入口、Harness 子进程入口与平台二进制文件仍使用真实文件系统路径，而不需要把完整的第三方依赖树逐文件复制到应用中。在 electron-builder 运行前，打包命令会拒绝任何未提供必需 workspace peer 的生产依赖图。

执行以下命令可构建应用，并为当前平台生成未签名的发布压缩包：

```sh
pnpm package:electron
```

产物写入 `dist-exe/electron/`：macOS 与 Windows 生成 ZIP，Linux 生成 tarball。代码签名、安装程序和自动更新尚未配置。

## 模型体验

Electron 应用会增加一个 `app:electron-surface` 系统提示词段，标明当前桌面 GUI，说明 Renderer 不提供隐式 DOM 或操作系统上下文，并说明 Agent、文件系统、shell、会话与模型执行位于 Electron Main。传输载荷不会进入模型请求。

#### KV Cache 影响

稳定的 Electron 方位说明会为通过该应用创建的会话增加一段系统提示词前缀；IPC 帧或 preload 实现的变化不影响模型请求。
