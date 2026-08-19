// Web e2e scenario: an image-capable auxiliary route reads the uploaded PNG,
// then the text-only DeepSeek route receives the durable description and owns
// the user-facing response. The visual route is selected through the real
// Models settings page before the image is pasted into the real composer.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-image-analysis'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/image-analysis', import.meta.url))
const REPLAY_OVERRIDE = join(SNAPSHOT_DIR, 'replay.override.json')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PROMPT = 'Explain the error shown in this screenshot and suggest the first debugging step.'
const ANALYSIS = 'A screenshot shows a red error banner reading "TypeError: handler is not a function" above a file named app.ts.'
const RESPONSE = 'DeepSeek received the vision description. Check where app.ts assigns or calls handler, then verify that value is a function.'

describe('web e2e: optional vision model hands image context to DeepSeek', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const requests: GenerateOptions[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: join(SNAPSHOT_DIR, 'session.jsonl'),
      replayOverride: REPLAY_OVERRIDE,
      replayProviders: [
        {
          id: 'qwen',
          name: 'Qwen',
          models: [{
            id: 'qwen-vl',
            name: 'Qwen VL',
            contextWindow: 128_000,
            inputModalities: ['text', 'image'],
          }],
        },
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{
            id: 'deepseek-v4-flash',
            name: 'DeepSeek-V4-Flash',
            contextWindow: 128_000,
            inputModalities: ['text'],
          }],
        },
      ],
    })
    scaffold.ctx.on('llm/stream', (options, next) => {
      requests.push(options)
      return next()
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'image-analysis e2e teardown failed')
  })

  it.skipIf(MODE === 'record')('configures Qwen for vision, then keeps DeepSeek as the conversation model', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-image-analysis'))

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Models' }).click()
    await settings.getByRole('switch', { name: 'Image understanding enhancement' }).click()
    const visualModel = settings.getByLabel('Vision model for image reading')
    await visualModel.waitFor({ timeout: 10_000 })
    await visualModel.selectOption({ label: 'Qwen VL (qwen-vl)' })
    await settings.getByText('Image understanding updated.', { exact: true }).waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Close' }).click()

    const settingsDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(settingsDocument).toContain('llm-image-analysis:')
    expect(settingsDocument).toContain('provider: qwen')
    expect(settingsDocument).toContain('model: qwen-vl')

    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.evaluate((element, base64) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'error-screenshot.png', { type: 'image/png' }))
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }))
    }, PNG_1X1)
    await page.getByRole('group', { name: 'Pending images' }).waitFor({ timeout: 10_000 })

    const settled = scaffold.whenTurnSettled()
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText(RESPONSE, { exact: true }).waitFor({ timeout: 10_000 })
    await page.getByRole('img', { name: 'error-screenshot.png' }).waitFor({ timeout: 10_000 })

    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      provider: 'qwen',
      model: 'qwen-vl',
      purpose: 'image-analysis',
    })
    expect(JSON.stringify(requests[0]?.messages)).toContain('"type":"image"')
    expect(requests[1]).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    expect(requests[1]).not.toHaveProperty('purpose')
    expect(requests[1]?.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes(ANALYSIS)))).toBe(true)
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('"type":"image"')

    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error(`image-analysis e2e: no live agent for ${sessionId}`)
    const imageMessage = agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'user'
      && event.data.content.some(block => block.type === 'image'))
    const analysisRequest = agent.session.events.find(event => event.type === 'image-analysis/request')
    const analysisResult = agent.session.events.find(event => event.type === 'image-analysis/result')
    const replacement = agent.session.events.find(event =>
      event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'image-analysis')
    expect(imageMessage).toBeDefined()
    expect(analysisRequest?.type === 'image-analysis/request' && analysisRequest.data.config)
      .toMatchObject({ provider: 'qwen', model: 'qwen-vl' })
    expect(analysisResult?.type === 'image-analysis/result' && analysisResult.data.analysis).toBe(ANALYSIS)
    expect(replacement?.type === 'user/message' ? replacement.sourceEventSeqs : undefined).toEqual([
      imageMessage?.seq,
      analysisRequest?.seq,
      analysisResult?.seq,
    ])
    const derived = agent.session.deriveMessages()
    expect(derived.some(message => message.content.some(block =>
      block.type === 'text' && block.text.includes(ANALYSIS)))).toBe(true)
    expect(JSON.stringify(derived)).not.toContain('"type":"image"')
    const conversationRequest = agent.session.events.findLast(event => event.type === 'request/header')
    expect(conversationRequest?.type === 'request/header'
      ? conversationRequest.data.header.config
      : undefined).toMatchObject({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['replay.override.json', 'ui.expected.md'])
  }, 60_000)
})
