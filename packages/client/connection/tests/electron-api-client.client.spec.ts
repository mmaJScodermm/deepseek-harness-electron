/** Electron Renderer carrier: unary requests, cancellation, and event streams. */

import { describe, expect, it, vi } from 'vitest'
import type {
  ElectronBridge,
  ElectronBridgeRequest,
  ElectronBridgeResponse,
  ElectronBridgeStreamMessage,
  ElectronBridgeStreamRequest,
} from '../src/electron-wire.ts'
import { ElectronApiClient } from '../src/client/electron-api-client.ts'
import { createElectronConnectionRpc } from '../src/client/electron-rpc.ts'

type WithoutStreamId<Message> = Message extends unknown ? Omit<Message, 'streamId'> : never

class FakeElectronBridge implements ElectronBridge {
  readonly requests: ElectronBridgeRequest[] = []
  readonly cancelled: string[] = []
  readonly closed: string[] = []
  readonly streams = new Map<string, (message: ElectronBridgeStreamMessage) => void>()
  responder: (request: ElectronBridgeRequest) => Promise<ElectronBridgeResponse> = async (request) => {
    const envelope = JSON.parse(request.body) as { rpcId: string; method: string }
    return {
      status: 200,
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({
        type: 'server-response',
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: envelope.method === 'session.list' ? { items: [] } : { ref: 'goal-electron' },
        },
      }),
    }
  }

  async request(request: ElectronBridgeRequest): Promise<ElectronBridgeResponse> {
    this.requests.push(request)
    return this.responder(request)
  }

  cancelRequest(requestId: string): void {
    this.cancelled.push(requestId)
  }

  async openStream(
    request: ElectronBridgeStreamRequest,
    listener: (message: ElectronBridgeStreamMessage) => void,
  ): Promise<void> {
    this.streams.set(request.streamId, listener)
  }

  closeStream(streamId: string): void {
    this.closed.push(streamId)
    this.streams.delete(streamId)
  }

  emit(streamId: string, message: WithoutStreamId<ElectronBridgeStreamMessage>): void {
    this.streams.get(streamId)?.({ streamId, ...message })
  }
}

describe('ElectronApiClient', () => {
  it('carries unary and generic RPC calls through their logical channels', async () => {
    const bridge = new FakeElectronBridge()
    const client = new ElectronApiClient(bridge)
    await expect(client.sessions.list({})).resolves.toMatchObject({ result: { ok: true, value: { items: [] } } })
    await expect(createElectronConnectionRpc(bridge).call(
      '/api',
      'goals/create',
      { args: { agentId: 'agent-electron' } },
    )).resolves.toEqual({ ok: true, value: { ref: 'goal-electron' } })
    expect(bridge.requests.map(request => ({ channel: request.channel, path: request.path }))).toEqual([
      { channel: '/api', path: '/api/session.list' },
      { channel: '/api', path: '/api/goals/create' },
    ])
    expect(bridge.requests.every((request) => {
      const body = JSON.parse(request.body) as { type?: unknown }
      return body.type === 'client-request'
    })).toBe(true)
  })

  it('cancels an active IPC request when its caller signal aborts', async () => {
    const bridge = new FakeElectronBridge()
    bridge.responder = () => new Promise(() => {})
    const client = new ElectronApiClient(bridge)
    const abort = new AbortController()
    const pending = client.sessions.list({}, abort.signal)
    await vi.waitFor(() => { expect(bridge.requests).toHaveLength(1) })
    abort.abort(new Error('stop request'))
    await expect(pending).rejects.toThrow('stop request')
    expect(bridge.cancelled).toEqual([bridge.requests[0]?.requestId])
  })

  it('parses mux frames, drops malformed input, observes envelopes, and closes on abort', async () => {
    const bridge = new FakeElectronBridge()
    const client = new ElectronApiClient(bridge)
    const batches: unknown[][] = []
    client.subscribeEnvelopes((batch) => { batches.push([...batch]) })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const opened = vi.fn()
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal, opened)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(bridge.streams.size).toBe(1) })
    const streamId = [...bridge.streams.keys()][0] as string
    bridge.emit(streamId, { type: 'frame', value: { broken: true } })
    bridge.emit(streamId, {
      type: 'frame',
      value: {
        type: 'server-request',
        rpcId: 'electron-frame',
        method: 'session/subscribed',
        payload: { type: 'session/subscribed', sessionId: 'session-electron', lastSeq: 3 },
      },
    })
    await expect(pending).resolves.toMatchObject({
      value: { rpcId: 'electron-frame', payload: { type: 'session/subscribed', lastSeq: 3 } },
    })
    expect(opened).toHaveBeenCalledOnce()
    expect(errors).toHaveBeenCalledOnce()
    await vi.waitFor(() => { expect(batches.flat()).toHaveLength(1) })
    const ended = iterator.next()
    abort.abort()
    await expect(ended).resolves.toMatchObject({ done: true })
    expect(bridge.closed).toContain(streamId)
    errors.mockRestore()
  })

  it('surfaces bridge stream failures and normal stream ends', async () => {
    const bridge = new FakeElectronBridge()
    const client = new ElectronApiClient(bridge)
    const failed = client.events.host({}, new AbortController().signal)[Symbol.asyncIterator]()
    const failure = failed.next()
    await vi.waitFor(() => { expect(bridge.streams.size).toBe(1) })
    const failedId = [...bridge.streams.keys()][0] as string
    bridge.emit(failedId, { type: 'error', message: 'ipc stream failed' })
    await expect(failure).rejects.toThrow('ipc stream failed')

    const ended = client.events.host({}, new AbortController().signal)[Symbol.asyncIterator]()
    const end = ended.next()
    await vi.waitFor(() => { expect(bridge.streams.size).toBe(1) })
    const endedId = [...bridge.streams.keys()][0] as string
    bridge.emit(endedId, { type: 'end' })
    await expect(end).resolves.toMatchObject({ done: true })
  })
})
