/** Private IPC channel names shared by Electron Main and preload. */

/** Stable channel vocabulary for the Electron application's private bridge. */
export const ELECTRON_IPC = {
  boot: 'dsh-electron:boot',
  request: 'dsh-electron:request',
  cancelRequest: 'dsh-electron:cancel-request',
  openStream: 'dsh-electron:open-stream',
  closeStream: 'dsh-electron:close-stream',
  streamMessage: 'dsh-electron:stream-message',
} as const
