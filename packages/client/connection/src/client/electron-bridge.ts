/** Renderer-side access to the narrow Electron preload capability. */

import type {
  ElectronBridge,
  ElectronBridgeRequest,
  ElectronBridgeResponse,
} from '../electron-wire.ts'
import { randomUuid } from './random-uuid.ts'

type ElectronGlobal = typeof globalThis & { __DSH_ELECTRON__?: unknown }

/**
 * Return the preload bridge when this client runs inside the Electron shell.
 * @returns the validated bridge, or undefined outside Electron.
 */
export function currentElectronBridge(): ElectronBridge | undefined {
  const value = (globalThis as ElectronGlobal).__DSH_ELECTRON__
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error('client-connection: window.__DSH_ELECTRON__ must be an object')
  }
  const candidate = value as Partial<ElectronBridge>
  if (typeof candidate.request !== 'function'
    || typeof candidate.cancelRequest !== 'function'
    || typeof candidate.openStream !== 'function'
    || typeof candidate.closeStream !== 'function') {
    throw new Error('client-connection: window.__DSH_ELECTRON__ is missing a bridge method')
  }
  return candidate as ElectronBridge
}

/**
 * Carry one Fetch-shaped JSON POST through the Electron bridge.
 * @param bridge - validated preload capability.
 * @param channel - logical Connection channel.
 * @param input - internal-authority request URL.
 * @param init - POST body and optional cancellation signal.
 * @returns a Response reconstructed from the Main result.
 */
export async function electronFetch(
  bridge: ElectronBridge,
  channel: string,
  input: URL,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'POST') {
    throw new Error(`client-connection: Electron IPC only carries JSON POST requests, got ${method}`)
  }
  if (typeof init?.body !== 'string') {
    throw new Error('client-connection: Electron IPC requires a JSON string request body')
  }
  const signal = init.signal ?? undefined
  signal?.throwIfAborted()
  const message: ElectronBridgeRequest = {
    requestId: randomUuid(),
    channel,
    path: `${input.pathname}${input.search}`,
    body: init.body,
  }
  const response = signal === undefined
    ? await bridge.request(message)
    : await abortableRequest(bridge, message, signal)
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

async function abortableRequest(
  bridge: ElectronBridge,
  request: ElectronBridgeRequest,
  signal: AbortSignal,
): Promise<ElectronBridgeResponse> {
  const pending = bridge.request(request)
  if (signal.aborted) {
    bridge.cancelRequest(request.requestId)
    throw abortError(signal)
  }
  return new Promise<ElectronBridgeResponse>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', handleAbort)
      callback()
    }
    const handleAbort = (): void => {
      bridge.cancelRequest(request.requestId)
      finish(() => { reject(abortError(signal)) })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    void pending.then(
      (value) => { finish(() => { resolve(value) }) },
      (error: unknown) => {
        finish(() => { reject(error instanceof Error ? error : new Error(String(error))) })
      },
    )
  })
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  return reason instanceof Error ? reason : new Error(String(reason))
}
