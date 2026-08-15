/** Browser-safe wire types for the Electron preload bridge. */

/** One JSON request carried from the Renderer to Electron Main. */
export interface ElectronBridgeRequest {
  /** Renderer-minted cancellation key. */
  requestId: string
  /** Logical Connection channel, such as `/api`. */
  channel: string
  /** Absolute path within the internal fake authority. */
  path: string
  /** JSON request body. */
  body: string
}

/** One Fetch-compatible response returned from Electron Main. */
export interface ElectronBridgeResponse {
  /** HTTP-compatible status emitted by the logical handler. */
  status: number
  /** Response headers preserved across IPC. */
  headers: [string, string][]
  /** UTF-8 response body. */
  body: string
}

/** The two server-to-client event streams exposed by ApiProxy. */
export type ElectronBridgeStreamKind = 'mux' | 'host'

/** Request to start one event stream in Electron Main. */
export interface ElectronBridgeStreamRequest {
  /** Renderer-minted stream ownership key. */
  streamId: string
  /** ApiProxy stream to open. */
  kind: ElectronBridgeStreamKind
}

/** One message delivered from Electron Main to a Renderer stream. */
export type ElectronBridgeStreamMessage =
  | { streamId: string; type: 'frame'; value: unknown }
  | { streamId: string; type: 'end' }
  | { streamId: string; type: 'error'; message: string }

/** Narrow capability exposed by the sandboxed preload script. */
export interface ElectronBridge {
  /**
   * Carry one logical JSON request over IPC.
   * @param request - validated logical channel, path, body, and cancellation id.
   * @returns the Fetch-compatible status, headers, and UTF-8 body.
   */
  request(request: ElectronBridgeRequest): Promise<ElectronBridgeResponse>
  /**
   * Cancel a request previously sent with the matching id.
   * @param requestId - Renderer-minted request ownership key.
   */
  cancelRequest(requestId: string): void
  /**
   * Open a server event stream and subscribe to its messages.
   * @param request - stream ownership key and ApiProxy stream kind.
   * @param listener - receives frames and terminal messages in arrival order.
   * @returns a promise resolving once Electron Main accepts stream ownership.
   */
  openStream(
    request: ElectronBridgeStreamRequest,
    listener: (message: ElectronBridgeStreamMessage) => void,
  ): Promise<void>
  /**
   * Close a stream previously opened with the matching id.
   * @param streamId - Renderer-minted stream ownership key.
   */
  closeStream(streamId: string): void
}
