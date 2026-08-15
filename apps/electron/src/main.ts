/** Electron Main application: local Host, controlled plugin protocol, and IPC carriage. */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron'
import type { Context } from '@deepseek-ai/cordis'
import { addHarnessSourceSection, loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { API_PATH, type HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {
  ElectronBridgeRequest,
  ElectronBridgeResponse,
  ElectronBridgeStreamMessage,
  ElectronBridgeStreamRequest,
} from '@deepseek-ai/dsh-client-connection/electron-wire'
import type { ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import {
  RpcId,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
  type ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { ELECTRON_IPC } from './ipc.ts'

interface BootedHost {
  ctx: Context
  shutdown: { shutdown(code: number): Promise<void> }
}

interface ElectronIpcHost {
  disconnect(): void
  dispose(): Promise<void>
}

interface ElectronHostServices {
  connection: HostConnectionHandle
  apiProxy: ApiProxy
  clientModules: ClientModuleRegistry
}

const INTERNAL_BASE = 'http://dsh.internal'
const PLUGIN_SCHEME = 'dsh-plugin'
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const SOURCE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const PROFILE_OVERLAY = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const PRELOAD_PATH = fileURLToPath(new URL('./preload.cjs', import.meta.url))
const BARE_MODULE_BASE_URL = new URL('../package.json', import.meta.url).href

let host: BootedHost | undefined
let mainWindow: BrowserWindow | undefined
let electronIpc: ElectronIpcHost | undefined
let quitting = false

protocol.registerSchemesAsPrivileged([{
  scheme: PLUGIN_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBridgeRequest(value: unknown): ElectronBridgeRequest {
  if (!isRecord(value)
    || typeof value.requestId !== 'string' || value.requestId === ''
    || typeof value.channel !== 'string' || !CHANNEL_PATTERN.test(value.channel)
    || typeof value.path !== 'string' || !value.path.startsWith('/')
    || typeof value.body !== 'string') {
    throw new Error('electron: malformed IPC request')
  }
  const url = new URL(value.path, INTERNAL_BASE)
  if (url.origin !== INTERNAL_BASE
    || `${url.pathname}${url.search}` !== value.path
    || (url.pathname !== value.channel && !url.pathname.startsWith(`${value.channel}/`))) {
    throw new Error(`electron: invalid IPC target ${JSON.stringify(value.path)}`)
  }
  return {
    requestId: value.requestId,
    channel: value.channel,
    path: value.path,
    body: value.body,
  }
}

function parseStreamRequest(value: unknown): ElectronBridgeStreamRequest {
  if (!isRecord(value)
    || typeof value.streamId !== 'string' || value.streamId === ''
    || (value.kind !== 'mux' && value.kind !== 'host')) {
    throw new Error('electron: malformed IPC stream request')
  }
  return { streamId: value.streamId, kind: value.kind }
}

function pluginToken(id: string): string {
  return Buffer.from(id).toString('base64url')
}

function pluginUrl(id: string, rev: string): string {
  return `${PLUGIN_SCHEME}://bundle/${pluginToken(id)}/client.js?rev=${encodeURIComponent(rev)}`
}

function electronBootGraph(modules: ClientModuleRegistry): WebBootGraph {
  const graph = modules.graph()
  return {
    rev: graph.rev,
    entries: graph.entries.map(entry => ({ ...entry, url: pluginUrl(entry.id, entry.rev) })),
  }
}

function serverRequest(frame: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function failureRequest(error: unknown): ServerRequest {
  return {
    type: 'server-request',
    rpcId: RpcId(randomUUID()),
    method: 'stream/error',
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

function requireHostService<Key extends keyof ElectronHostServices>(
  ctx: Context,
  key: Key,
): ElectronHostServices[Key] {
  const service = ctx.get(key) as ElectronHostServices[Key] | undefined
  if (service === undefined) throw new Error(`electron: Host did not provide ${key}`)
  return service
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function assertCurrentSender(event: IpcMainEvent | IpcMainInvokeEvent): WebContents {
  const contents = mainWindow?.webContents
  if (contents === undefined || contents.isDestroyed() || event.sender !== contents) {
    throw new Error('electron: IPC sender is not the active Harness window')
  }
  return contents
}

function isCurrentSender(event: IpcMainEvent): boolean {
  const contents = mainWindow?.webContents
  return contents !== undefined && !contents.isDestroyed() && event.sender === contents
}

function installPluginProtocol(modules: ClientModuleRegistry): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
    const url = new URL(request.url)
    const match = /^\/([^/]+)\/(client\.js(?:\.map)?)$/.exec(url.pathname)
    if (url.host !== 'bundle' || match === null) return new Response('not found', { status: 404 })
    const token = match[1] as string
    const id = Buffer.from(token, 'base64url').toString('utf8')
    if (pluginToken(id) !== token) return new Response('not found', { status: 404 })
    const entry = modules.graph().entries.find(candidate => candidate.id === id)
    const sourceMap = match[2] === 'client.js.map'
    if (entry === undefined || (!sourceMap && url.searchParams.get('rev') !== entry.rev)) {
      return new Response('not found', { status: 404 })
    }
    const clientPath = modules.clientPath(id)
    if (clientPath === undefined) return new Response('not found', { status: 404 })
    try {
      const body = await readFile(sourceMap ? `${clientPath}.map` : clientPath)
      return new Response(body, {
        headers: {
          'content-type': sourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
          'cache-control': 'no-cache',
          'access-control-allow-origin': '*',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function installElectronIpc(ctx: Context): ElectronIpcHost {
  const connection = requireHostService(ctx, 'connection')
  const api = requireHostService(ctx, 'apiProxy')
  const modules = requireHostService(ctx, 'clientModules')
  const fallback = toFetchHandler(api)
  const requests = new Map<string, AbortController>()
  const streams = new Map<string, AbortController>()
  const pumps = new Set<Promise<void>>()

  const bootListener = (event: IpcMainEvent): void => {
    event.returnValue = isCurrentSender(event) ? electronBootGraph(modules) : undefined
  }
  const cancelRequestListener = (event: IpcMainEvent, requestId: unknown): void => {
    if (!isCurrentSender(event)) return
    if (typeof requestId === 'string') requests.get(requestId)?.abort()
  }
  const closeStreamListener = (event: IpcMainEvent, streamId: unknown): void => {
    if (!isCurrentSender(event)) return
    if (typeof streamId === 'string') streams.get(streamId)?.abort()
  }

  ipcMain.on(ELECTRON_IPC.boot, bootListener)
  ipcMain.on(ELECTRON_IPC.cancelRequest, cancelRequestListener)
  ipcMain.on(ELECTRON_IPC.closeStream, closeStreamListener)
  ipcMain.handle(ELECTRON_IPC.request, async (event, raw): Promise<ElectronBridgeResponse> => {
    assertCurrentSender(event)
    const message = parseBridgeRequest(raw)
    if (requests.has(message.requestId)) {
      throw new Error(`electron: request ${JSON.stringify(message.requestId)} is already active`)
    }
    const abort = new AbortController()
    requests.set(message.requestId, abort)
    try {
      const request = new Request(new URL(message.path, INTERNAL_BASE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: message.body,
        signal: abort.signal,
      })
      const response = await connection.fetch(
        message.channel,
        request,
        message.channel === API_PATH ? candidate => fallback.fetch(candidate) : undefined,
      )
      return {
        status: response.status,
        headers: [...response.headers.entries()],
        body: await response.text(),
      }
    } finally {
      if (requests.get(message.requestId) === abort) requests.delete(message.requestId)
    }
  })
  ipcMain.handle(ELECTRON_IPC.openStream, (event, raw): void => {
    const contents = assertCurrentSender(event)
    const request = parseStreamRequest(raw)
    if (streams.has(request.streamId)) {
      throw new Error(`electron: stream ${JSON.stringify(request.streamId)} is already active`)
    }
    const abort = new AbortController()
    streams.set(request.streamId, abort)
    const source = request.kind === 'mux'
      ? api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
      : api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
    const pump = (async (): Promise<void> => {
      try {
        for await (const frame of source) {
          if (abort.signal.aborted || contents.isDestroyed()) return
          const message: ElectronBridgeStreamMessage = {
            streamId: request.streamId,
            type: 'frame',
            value: serverRequest(frame),
          }
          contents.send(ELECTRON_IPC.streamMessage, message)
        }
      } catch (error) {
        if (!abort.signal.aborted && !contents.isDestroyed()) {
          const message: ElectronBridgeStreamMessage = {
            streamId: request.streamId,
            type: 'frame',
            value: failureRequest(error),
          }
          contents.send(ELECTRON_IPC.streamMessage, message)
        }
      } finally {
        abort.abort()
        if (streams.get(request.streamId) === abort) streams.delete(request.streamId)
        if (!contents.isDestroyed()) {
          const message: ElectronBridgeStreamMessage = { streamId: request.streamId, type: 'end' }
          try {
            contents.send(ELECTRON_IPC.streamMessage, message)
          } catch (error) {
            if (!contents.isDestroyed()) console.error('electron: failed to close Renderer stream', error)
          }
        }
      }
    })()
    pumps.add(pump)
    void pump.then(
      () => { pumps.delete(pump) },
      (error: unknown) => {
        pumps.delete(pump)
        console.error('electron: Renderer stream pump failed', error)
      },
    )
  })

  const disconnect = (): void => {
    for (const abort of requests.values()) abort.abort()
    for (const abort of streams.values()) abort.abort()
  }
  return {
    disconnect,
    async dispose() {
      ipcMain.removeListener(ELECTRON_IPC.boot, bootListener)
      ipcMain.removeListener(ELECTRON_IPC.cancelRequest, cancelRequestListener)
      ipcMain.removeListener(ELECTRON_IPC.closeStream, closeStreamListener)
      ipcMain.removeHandler(ELECTRON_IPC.request)
      ipcMain.removeHandler(ELECTRON_IPC.openStream)
      disconnect()
      await Promise.all(pumps)
    },
  }
}

function addElectronSurface(ctx: Context): void {
  if (ctx.get('systemPrompt') === undefined) return
  ctx.effect(
    () => addHarnessSourceSection(ctx, SOURCE_ROOT) ?? (() => {}),
    'electron: harness source prompt section',
  )
  ctx.effect(
    () => ctx.systemPrompt.section({
      name: 'app:electron-surface',
      order: -98,
      text: 'You are interacting with the user through the DeepSeek Harness Electron desktop GUI. '
        + 'When the user refers to "this window", "this GUI", or "this app" without naming another target, they mean this Electron application. '
        + 'The Renderer provides no implicit DOM, route, screenshot, or operating-system context. '
        + 'The Agent, session, filesystem, shell, and model providers run locally in Electron Main; the sandboxed Renderer communicates with them only through the Harness IPC carrier. '
        + 'Starting an HTTP server does not update this desktop window.',
    }),
    'electron: surface prompt section',
  )
}

async function bootHost(): Promise<BootedHost> {
  const booted = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [PROFILE_OVERLAY],
    args: [],
    ...(app.isPackaged ? { bareModuleBaseUrl: BARE_MODULE_BASE_URL } : {}),
  })
  try {
    addElectronSurface(booted.ctx)
    const modules = requireHostService(booted.ctx, 'clientModules')
    installPluginProtocol(modules)
    electronIpc = installElectronIpc(booted.ctx)
    return booted
  } catch (error) {
    if (protocol.isProtocolHandled(PLUGIN_SCHEME)) protocol.unhandle(PLUGIN_SCHEME)
    await booted.shutdown.shutdown(1)
    throw error
  }
}

function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    throw new Error('electron: frontend dist not built; run `pnpm run build` before launch')
  }
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 960,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => { window.show() })
  window.on('closed', () => {
    if (mainWindow !== window) return
    mainWindow = undefined
  })
  window.webContents.once('destroyed', () => {
    electronIpc?.disconnect()
    if (mainWindow === window) mainWindow = undefined
  })
  await window.loadFile(resolveDistIndex())
}

async function disposeHost(): Promise<void> {
  const currentIpc = electronIpc
  electronIpc = undefined
  let teardownError: unknown
  try {
    await currentIpc?.dispose()
  } catch (error) {
    teardownError = error
  }
  if (protocol.isProtocolHandled(PLUGIN_SCHEME)) protocol.unhandle(PLUGIN_SCHEME)
  if (host !== undefined) {
    const current = host
    host = undefined
    try {
      await current.shutdown.shutdown(0)
    } catch (error) {
      teardownError ??= error
    }
  }
  if (teardownError !== undefined) throw errorFromUnknown(teardownError)
}

app.on('before-quit', (event) => {
  if (quitting || (host === undefined && electronIpc === undefined)) return
  event.preventDefault()
  quitting = true
  void disposeHost().then(
    () => { app.exit(0) },
    (error: unknown) => {
      console.error('electron: failed to dispose Host', error)
      app.exit(1)
    },
  )
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow !== undefined || host === undefined) return
  void createMainWindow().catch((error: unknown) => {
    console.error('electron: failed to recreate window', error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
})

async function startApplication(): Promise<void> {
  try {
    host = await bootHost()
    await createMainWindow()
  } catch (error) {
    console.error('electron: failed to start', error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    try {
      await disposeHost()
    } catch (disposeError) {
      console.error('electron: failed to dispose Host after startup failure', disposeError)
    }
    app.exit(1)
  }
}

// Electron waits for an ESM main module to finish evaluating before it can emit ready.
void app.whenReady().then(startApplication)
