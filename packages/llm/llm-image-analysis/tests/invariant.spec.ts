import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { IMAGE_ANALYSIS_MESSAGE_SOURCE, IMAGE_ANALYSIS_SYSTEM_PROMPT } from '@deepseek-ai/dsh-llm-image-analysis'
import * as ImageAnalysisInvariant from '@deepseek-ai/dsh-llm-image-analysis/invariant'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(ImageAnalysisInvariant)
  return ctx
}

function openImage(ctx: Context, id: string) {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const original = session.append('user/message', {
    id: `${id}-message`, role: 'user', source: { kind: 'user' },
    content: [{
      type: 'image',
      attachment: {
        attachmentId: `sha256:${'b'.repeat(64)}`,
        mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      },
    }],
  } as never, { surfaceOp: 'append' })
  return { session, original }
}

function appendRequest(session: ReturnType<Context['sessions']['create']>, original: ReturnType<ReturnType<Context['sessions']['create']>['append']>) {
  return session.append('image-analysis/request', {
    turn: 1,
    step: 1,
    messageSeq: original.seq,
    config: { provider: 'qwen', model: 'qwen-vl', maxTokens: 256 },
    system: IMAGE_ANALYSIS_SYSTEM_PROMPT,
    messages: [original.data as never],
  })
}

describe('image-analysis invariants', () => {
  it('accepts one request, result, and text-only replacement chain', async () => {
    const ctx = await setup()
    const { session, original } = openImage(ctx, 'image-invariant-valid')
    const request = appendRequest(session, original)
    const result = session.append('image-analysis/result', {
      requestSeq: request.seq,
      messageSeq: original.seq,
      provider: 'qwen',
      model: 'qwen-vl',
      analysis: 'red square',
    })
    expect(() => session.append('user/message', {
      id: MessageId('replacement'), role: 'user',
      source: { kind: 'plugin', plugin: IMAGE_ANALYSIS_MESSAGE_SOURCE },
      content: [{ type: 'text', text: 'red square' }],
    }, {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq, request.seq, result.seq],
    })).not.toThrow()
  })

  it('rejects an unpaired result and malformed replacement provenance', async () => {
    const ctx = await setup()
    const missing = openImage(ctx, 'image-invariant-missing')
    expect(() => missing.session.append('image-analysis/result', {
      requestSeq: 99, messageSeq: missing.original.seq,
      provider: 'qwen', model: 'qwen-vl', analysis: 'text',
    })).toThrow(/requestSeq must reference/)

    const malformed = openImage(ctx, 'image-invariant-malformed')
    const request = appendRequest(malformed.session, malformed.original)
    const result = malformed.session.append('image-analysis/result', {
      requestSeq: request.seq, messageSeq: malformed.original.seq,
      provider: 'qwen', model: 'qwen-vl', analysis: 'text',
    })
    expect(() => malformed.session.append('user/message', {
      id: MessageId('replacement'), role: 'user',
      source: { kind: 'plugin', plugin: IMAGE_ANALYSIS_MESSAGE_SOURCE },
      content: [{ type: 'text', text: 'text' }],
    }, {
      surfaceOp: { op: 'replace', start: malformed.original.seq, end: malformed.original.seq },
      sourceEventSeqs: [malformed.original.seq, result.seq, request.seq],
    })).toThrow(/provenance must form one request\/result chain/)
  })

  it('rejects duplicate results and requests that name text-only input', async () => {
    const ctx = await setup()
    const duplicate = openImage(ctx, 'image-invariant-duplicate')
    const request = appendRequest(duplicate.session, duplicate.original)
    duplicate.session.append('image-analysis/result', {
      requestSeq: request.seq, messageSeq: duplicate.original.seq,
      provider: 'qwen', model: 'qwen-vl', analysis: 'first',
    })
    expect(() => duplicate.session.append('image-analysis/result', {
      requestSeq: request.seq, messageSeq: duplicate.original.seq,
      provider: 'qwen', model: 'qwen-vl', analysis: 'second',
    })).toThrow(/must be unique/)

    const text = ctx.sessions.create(SessionId('image-invariant-text'))
    text.append('turn/start', { turn: 1 })
    text.append('step/start', { turn: 1, step: 1 })
    const message = text.append('user/message', {
      id: MessageId('text'), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: 'plain' }],
    }, { surfaceOp: 'append' })
    expect(() => appendRequest(text, message)).toThrow(/image-bearing user\/message/)
  })
})
