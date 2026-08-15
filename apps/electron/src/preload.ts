/** Sandboxed preload: expose only the Harness boot graph and IPC carrier. */

import { contextBridge, ipcRenderer } from 'electron'
import type {
  ElectronBridge,
  ElectronBridgeStreamMessage,
} from '@deepseek-ai/dsh-client-connection/electron-wire'
import { ELECTRON_IPC } from './ipc.ts'

const streamListeners = new Map<string, (message: ElectronBridgeStreamMessage) => void>()

function isStreamMessage(value: unknown): value is ElectronBridgeStreamMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  if (typeof message.streamId !== 'string') return false
  if (message.type === 'frame') return 'value' in message
  if (message.type === 'end') return true
  return message.type === 'error' && typeof message.message === 'string'
}

ipcRenderer.on(ELECTRON_IPC.streamMessage, (_event, message: unknown) => {
  if (!isStreamMessage(message)) return
  const listener = streamListeners.get(message.streamId)
  if (listener === undefined) return
  listener(message)
  if (message.type === 'end' || message.type === 'error') streamListeners.delete(message.streamId)
})

const bridge: ElectronBridge = {
  request: request => ipcRenderer.invoke(ELECTRON_IPC.request, request),
  cancelRequest(requestId) {
    ipcRenderer.send(ELECTRON_IPC.cancelRequest, requestId)
  },
  async openStream(request, listener) {
    if (streamListeners.has(request.streamId)) {
      throw new Error(`electron preload: stream ${JSON.stringify(request.streamId)} is already open`)
    }
    streamListeners.set(request.streamId, listener)
    try {
      await ipcRenderer.invoke(ELECTRON_IPC.openStream, request)
    } catch (error) {
      streamListeners.delete(request.streamId)
      throw error
    }
  },
  closeStream(streamId) {
    streamListeners.delete(streamId)
    ipcRenderer.send(ELECTRON_IPC.closeStream, streamId)
  },
}

contextBridge.exposeInMainWorld('__DSH_BOOT__', ipcRenderer.sendSync(ELECTRON_IPC.boot))
contextBridge.exposeInMainWorld('__DSH_ELECTRON__', bridge)
