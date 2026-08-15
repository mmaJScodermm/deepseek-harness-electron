# `@deepseek-ai/dsh-electron`

English | [中文](README.zh.md)

Electron desktop application for DeepSeek Harness. Electron Main boots the existing `web` profile with [`cordis.patch.yml`](cordis.patch.yml), which disables the HTTP server, Web-only runtime, and client HMR rows while retaining the Agent, sessions, LLM providers, tools, filesystem, shell, settings, and client plugin roster. The Renderer loads the built React application through `file://`; no local port is opened.

Repository launches retain the profile's normal module fallback, which resolves every workspace plugin through the pnpm development tree. Packaged launches instead pass the application installation as the bare-package base because an external profile symlink cannot traverse into `app.asar`; this distinction leaves profile-relative configuration paths unchanged.

## Runtime

The sandboxed preload exposes two values before the React entry runs: `window.__DSH_BOOT__`, the Host-composed client plugin graph, and `window.__DSH_ELECTRON__`, a narrow request/cancellation/stream API. `ElectronApiClient` uses that API for unary RPC and the `events.mux`/`events.host` streams. Electron Main validates that every IPC message comes from the active Harness window, dispatches unary requests through `ctx.connection`, and aborts all owned work when the window closes.

Client plugin scripts remain outside the static Vite bundle. Electron Main serves only ids present in `ctx.clientModules.graph()` through the privileged `dsh-plugin://` protocol and resolves each id with `ctx.clientModules.clientPath()`; the Renderer receives no arbitrary filesystem reader. `contextIsolation`, Renderer sandboxing, Web security, and disabled Node integration remain enabled.

## Build and run

From the repository root, build all required artifacts and start the desktop application with one command:

```sh
pnpm electron
```

`pnpm install` downloads the platform Electron runtime. A checkout installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` can typecheck and build the application but cannot open the desktop window until the Electron runtime is installed.

Release builds store third-party JavaScript in `app.asar` while leaving all `@deepseek-ai` packages and electron-builder-detected native modules or executables unpacked. Client bundles, worker entries, Harness subprocess entry points, and platform binaries therefore retain real filesystem paths without copying the complete third-party dependency tree as individual files. The package command rejects a production dependency graph that leaves any required workspace peer unprovided before electron-builder runs.

Build the application and create an unsigned release archive for the current platform with:

```sh
pnpm package:electron
```

Artifacts are written under `dist-exe/electron/`: ZIP on macOS and Windows, and tarball on Linux. Code signing, installers, and auto-update are not configured.

## Model Experience

The Electron application adds an `app:electron-surface` system-prompt section that identifies the desktop GUI, states that the Renderer provides no implicit DOM or operating-system context, and locates Agent, filesystem, shell, session, and model execution in Electron Main. No transport payload is added to model requests.

#### KV Cache effect

The stable Electron orientation adds one system-prompt prefix to sessions created through this application; changing IPC frames or preload implementation does not affect the model request.
