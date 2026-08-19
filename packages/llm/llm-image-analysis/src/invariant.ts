/** Durable request/result and replacement invariants for image analysis. @module @deepseek-ai/dsh-llm-image-analysis/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  IMAGE_ANALYSIS_MESSAGE_SOURCE,
  IMAGE_ANALYSIS_SYSTEM_PROMPT,
} from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-image-analysis'

/** Cordis companion plugin name. */
export const name = 'llm-image-analysis-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Require the request to describe an image message in the currently open step. */
function validateRequest(
  history: readonly SessionEvent[],
  event: SessionEvent<'image-analysis/request'>,
  fail: InvariantFailure,
): void {
  const { turn, step, messageSeq, config, system, messages } = event.data
  const turnBoundary = history.findLast(prior => prior.type === 'turn/start' || prior.type === 'turn/end')
  if (turnBoundary?.type !== 'turn/start' || turnBoundary.data.turn !== turn) {
    fail('image-analysis/request must name the currently open turn')
  }
  const stepBoundary = history.findLast(prior => prior.type === 'step/start' || prior.type === 'step/end')
  if (stepBoundary?.type !== 'step/start'
    || stepBoundary.data.turn !== turn
    || stepBoundary.data.step !== step) {
    fail('image-analysis/request must name the currently open step')
  }
  const message = history.find(prior => prior.seq === messageSeq)
  if (message?.type !== 'user/message' || !contentHasImage(message.data.content)) {
    fail('image-analysis/request messageSeq must reference a prior image-bearing user/message')
  }
  if (config.provider.length === 0 || config.model.length === 0) {
    fail('image-analysis/request config must name a non-empty provider and model')
  }
  if (system !== IMAGE_ANALYSIS_SYSTEM_PROMPT) {
    fail('image-analysis/request must carry the package system prompt')
  }
  if (JSON.stringify(messages) !== JSON.stringify([message.data])) {
    fail('image-analysis/request messages must contain only the referenced user/message')
  }
}

/** Require a successful result to pair once with its exact request and route. */
function validateResult(
  history: readonly SessionEvent[],
  event: SessionEvent<'image-analysis/result'>,
  fail: InvariantFailure,
): void {
  const { requestSeq, messageSeq, provider, model, analysis } = event.data
  const request = history.find(prior => prior.seq === requestSeq)
  if (request?.type !== 'image-analysis/request') {
    fail('image-analysis/result requestSeq must reference a prior image-analysis/request')
  }
  if (request.data.messageSeq !== messageSeq) {
    fail('image-analysis/result messageSeq must match its request')
  }
  if (request.data.config.provider !== provider || request.data.config.model !== model) {
    fail('image-analysis/result route must match its request config')
  }
  if (analysis.trim().length === 0) {
    fail('image-analysis/result analysis must contain non-whitespace text')
  }
  if (history.some(prior => prior.type === 'image-analysis/result'
    && prior.data.requestSeq === requestSeq)) {
    fail('image-analysis/result must be unique for one request')
  }
}

/** Require each package replacement to name the exact original, request, and result. */
function validateReplacement(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  if (event.data.source.kind !== 'plugin'
    || event.data.source.plugin !== IMAGE_ANALYSIS_MESSAGE_SOURCE) return
  if (event.surfaceOp === undefined || event.surfaceOp === 'append') {
    fail('image-analysis user/message must replace one image-bearing surface message')
  }
  const { start, end } = event.surfaceOp
  if (start !== end) fail('image-analysis user/message must replace exactly one surface message')
  const original = history.find(prior => prior.seq === start)
  if (original?.type !== 'user/message' || !contentHasImage(original.data.content)) {
    fail('image-analysis user/message must replace an image-bearing user/message')
  }
  const sources = event.sourceEventSeqs
  if (sources === undefined || sources.length !== 3 || sources[0] !== original.seq) {
    fail('image-analysis user/message must cite original, request, and result source events')
  }
  const request = history.find(prior => prior.seq === sources[1])
  const result = history.find(prior => prior.seq === sources[2])
  if (request?.type !== 'image-analysis/request'
    || result?.type !== 'image-analysis/result'
    || request.data.messageSeq !== original.seq
    || result.data.messageSeq !== original.seq
    || result.data.requestSeq !== request.seq) {
    fail('image-analysis user/message provenance must form one request/result chain')
  }
  if (contentHasImage(event.data.content)
    || event.data.content.some(block => block.type !== 'text')) {
    fail('image-analysis user/message replacement must contain text only')
  }
}

/** Validate all package-owned events already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  for (const [index, event] of session.events.entries()) {
    const history = session.events.slice(0, index)
    if (event.type === 'image-analysis/request') validateRequest(history, event, fail)
    else if (event.type === 'image-analysis/result') validateResult(history, event, fail)
    else if (event.type === 'user/message') validateReplacement(history, event, fail)
  }
}

/** Install validation for loaded and newly appended image-analysis records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'image-analysis/request') validateRequest(session.events, event, fail)
    else if (event.type === 'image-analysis/result') validateResult(session.events, event, fail)
    else if (event.type === 'user/message') validateReplacement(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the image-analysis invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
