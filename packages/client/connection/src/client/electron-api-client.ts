/** Electron API carrier: IPC upstream plus IPC event streams. */

import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { serverRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/rpc.schema'
import type {
  ApiProxy,
  HostFrame,
  MuxFrame,
  RpcRequest,
  ServerRequest,
} from './api.ts'
import { AbstractApiClient } from './api.ts'
import type {
  ElectronBridge,
  ElectronBridgeStreamKind,
  ElectronBridgeStreamMessage,
} from '../electron-wire.ts'
import { electronFetch } from './electron-bridge.ts'
import { randomUuid } from './random-uuid.ts'

type StreamItem<F> =
  | { kind: 'frame'; envelope: RpcRequest<F> }
  | { kind: 'end' }
  | { kind: 'error'; error: Error }
type Parser<F> = { parse(value: unknown): F }

/** ApiProxy client whose physical carrier is the sandboxed preload bridge. */
export class ElectronApiClient extends AbstractApiClient {
  /** @param bridge - preload capability injected into the Renderer. */
  constructor(private readonly bridge: ElectronBridge) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    return electronFetch(this.bridge, '/api', input, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readIpcStream('mux', signal, muxFrameSchema, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readIpcStream('host', signal, hostFrameSchema, onOpen)
  }

  private async *readIpcStream<F extends MuxFrame | HostFrame>(
    kind: ElectronBridgeStreamKind,
    signal: AbortSignal,
    frameSchema: Parser<F>,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const streamId = randomUuid()
    const inbox: StreamItem<F>[] = []
    let wake: (() => void) | undefined
    let finished = false
    const enqueue = (item: StreamItem<F>): void => {
      if (finished) return
      if (item.kind !== 'frame') finished = true
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleMessage = (message: ElectronBridgeStreamMessage): void => {
      if (message.streamId !== streamId || finished) return
      if (message.type === 'end') {
        enqueue({ kind: 'end' })
        return
      }
      if (message.type === 'error') {
        enqueue({ kind: 'error', error: new Error(message.message) })
        return
      }
      let full: ServerRequest
      let frame: F
      try {
        full = serverRequestSchema.parse(message.value)
        frame = frameSchema.parse(full.payload)
      } catch (error) {
        console.error(`[client-connection] dropping malformed Electron frame on ${kind}:`, error)
        return
      }
      this.onEnvelope(full)
      enqueue({ kind: 'frame', envelope: { rpcId: full.rpcId, payload: frame } })
    }
    const handleAbort = (): void => {
      this.bridge.closeStream(streamId)
      inbox.length = 0
      enqueue({ kind: 'end' })
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) {
      handleAbort()
    }
    try {
      if (!signal.aborted) {
        try {
          await this.bridge.openStream({ streamId, kind }, handleMessage)
          if (!inbox.some(item => item.kind !== 'frame')) onOpen?.()
        } catch (error) {
          enqueue({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) })
        }
      }
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      finished = true
      signal.removeEventListener('abort', handleAbort)
      this.bridge.closeStream(streamId)
    }
  }
}
