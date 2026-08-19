import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import ImageAnalysis, {
  IMAGE_ANALYSIS_MESSAGE_SOURCE,
  IMAGE_ANALYSIS_SYSTEM_PROMPT,
  IMAGE_ANALYSIS_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-llm-image-analysis'
import type { Config as ImageAnalysisConfig } from '@deepseek-ai/dsh-llm-image-analysis'

const CONFIG = {
  provider: 'qwen',
  model: 'qwen-vl',
  maxOutputTokens: 512,
  timeoutMs: 1_000,
} as const

const SUCCESS: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'A terminal shows TypeError on line 42.' },
  { type: 'finish', reason: { kind: 'stop' } },
]

class VisionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private script: readonly StreamChunk[],
    private readonly modalities: LlmResolvedModelInfo['inputModalities'] = ['text', 'image'],
  ) {
    super()
  }

  setScript(script: readonly StreamChunk[]): void {
    this.script = script
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.modalities === undefined ? {} : { inputModalities: this.modalities },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends VisionAdapter {
  constructor() {
    super([])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected image-analysis signal')
    await new Promise<never>((_resolve, reject) => {
      const abort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact timeout reason
        reject(signal.reason)
      }
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }
}

async function setup(
  adapter: LlmAdapter,
  config: ImageAnalysisConfig = CONFIG,
): Promise<{ ctx: Context; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['qwen'], adapter)
  const fiber = await ctx.plugin(ImageAnalysis, config)
  return { ctx, fiber }
}

function imageAgent(ctx: Context, id: string): { agent: Agent; event: ReturnType<Agent['session']['append']> } {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const event = session.append('user/message', {
    id: `${id}-message`,
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text: 'What failed?' },
      {
        type: 'image',
        attachment: {
          attachmentId: `sha256:${'a'.repeat(64)}`,
          mediaType: 'image/png',
          bytes: 10,
          width: 2,
          height: 2,
          name: 'error.png',
        },
      },
    ],
  } as never, { surfaceOp: 'append' })
  return {
    agent: { id: session.id, session, ctx } as Agent,
    event,
  }
}

async function process(ctx: Context, agent: Agent, event: ReturnType<Agent['session']['append']>): Promise<void> {
  await agentEvents(ctx, agent).serial('agent/step-input-logged', {
    events: [event as never],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  })
}

describe('image analysis', () => {
  it('logs the auxiliary request and result, then gives the main model text-only history', async () => {
    const adapter = new VisionAdapter(SUCCESS)
    const { ctx } = await setup(adapter)
    const { agent, event } = imageAgent(ctx, 'image-success')

    await process(ctx, agent, event)

    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({
      provider: 'qwen',
      model: 'qwen-vl',
      maxTokens: 512,
      purpose: 'image-analysis',
      system: IMAGE_ANALYSIS_SYSTEM_PROMPT,
      messages: [event.data],
    })
    const request = agent.session.events.find(candidate => candidate.type === 'image-analysis/request')
    const result = agent.session.events.find(candidate => candidate.type === 'image-analysis/result')
    const replacement = agent.session.events.findLast(candidate => candidate.type === 'user/message')
    expect(request?.type).toBe('image-analysis/request')
    expect(result?.type === 'image-analysis/result' && result.data.analysis)
      .toBe('A terminal shows TypeError on line 42.')
    expect(replacement?.type === 'user/message' && replacement.data.source)
      .toEqual({ kind: 'plugin', plugin: IMAGE_ANALYSIS_MESSAGE_SOURCE })
    expect(replacement?.sourceEventSeqs).toEqual([event.seq, request?.seq, result?.seq])
    expect(agent.session.events.filter(candidate => candidate.seq === event.seq)).toHaveLength(1)
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('What failed?')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('TypeError on line 42')
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('"type":"image"')
  })

  it('does nothing without a configured route and rejects incomplete or invalid limits at load', async () => {
    const adapter = new VisionAdapter(SUCCESS)
    const disabled = await setup(adapter, { maxOutputTokens: 512, timeoutMs: 1_000 })
    const { agent, event } = imageAgent(disabled.ctx, 'image-disabled')
    await process(disabled.ctx, agent, event)
    expect(adapter.requests).toEqual([])
    expect(agent.session.deriveMessages()[0]?.content.some(block => block.type === 'image')).toBe(true)

    const invalid = new Context()
    await invalid.plugin(SessionStore)
    await invalid.plugin(LlmRuntime)
    await expect(invalid.plugin(ImageAnalysis, {
      provider: 'qwen', maxOutputTokens: 1, timeoutMs: 1,
    })).rejects.toThrow(/provider and model must be supplied together/)
    await expect(invalid.plugin(ImageAnalysis, {
      provider: 'qwen', model: 'qwen-vl', maxOutputTokens: 0, timeoutMs: 1,
    })).rejects.toThrow(/maxOutputTokens expected number >= 1/)
  })

  it('requires an explicit image modality before dispatch or replacement', async () => {
    const adapter = new VisionAdapter(SUCCESS, ['text'])
    const { ctx } = await setup(adapter)
    const { agent, event } = imageAgent(ctx, 'image-text-only')

    await expect(process(ctx, agent, event)).rejects.toMatchObject({
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
    })
    expect(adapter.requests).toEqual([])
    expect(agent.session.events.some(candidate => candidate.type === 'image-analysis/request')).toBe(false)
    expect(agent.session.surface.nodes).toContain(event.seq)
    await expect(ctx.imageAnalysis.resolveConfiguredRoute()).rejects.toBeInstanceOf(LlmError)
  })

  it('leaves the original image retryable after a failed output', async () => {
    const adapter = new VisionAdapter([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    const { ctx } = await setup(adapter)
    const { agent, event } = imageAgent(ctx, 'image-retry')

    await expect(process(ctx, agent, event)).rejects.toMatchObject({ code: 'IMAGE_ANALYSIS_MAX_TOKENS' })
    expect(agent.session.surface.nodes).toContain(event.seq)
    expect(agent.session.events.some(candidate => candidate.type === 'image-analysis/result')).toBe(false)

    adapter.setScript(SUCCESS)
    await process(ctx, agent, event)
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain('"type":"image"')
  })

  it('aborts a cooperative provider at the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const { ctx } = await setup(new CooperativeAdapter(), { ...CONFIG, timeoutMs: 10 })
      const { agent, event } = imageAgent(ctx, 'image-timeout')
      const pending = process(ctx, agent, event)
      const rejected = expect(pending).rejects.toMatchObject({
        code: IMAGE_ANALYSIS_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
      expect(agent.session.surface.nodes).toContain(event.seq)
    } finally {
      vi.useRealTimers()
    }
  })

  it('removes its step listener when the plugin fiber disposes', async () => {
    const adapter = new VisionAdapter(SUCCESS)
    const { ctx, fiber } = await setup(adapter)
    await fiber.dispose()
    const { agent, event } = imageAgent(ctx, 'image-disposed')
    await process(ctx, agent, event)
    expect(adapter.requests).toEqual([])
  })
})
