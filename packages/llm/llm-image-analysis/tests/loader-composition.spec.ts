import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ImageAnalysis from '@deepseek-ai/dsh-llm-image-analysis'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('llm-image-analysis real Loader composition', () => {
  it('loads the optional visual route from flat YAML plugin rows', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-image-analysis-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-llm-image-analysis'",
      '  config:',
      '    provider: qwen',
      '    model: qwen-vl-max',
      '    maxOutputTokens: 2048',
      '    timeoutMs: 60000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (specifier === '@deepseek-ai/dsh-llm') return LlmRuntime
        if (specifier === '@deepseek-ai/dsh-llm-image-analysis') return ImageAnalysis
        throw new Error(`unexpected Loader import: ${specifier}`)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    expect(context.get('imageAnalysis')).toBeInstanceOf(ImageAnalysis)
    expect(context.imageAnalysis.currentRoute()).toEqual({
      provider: 'qwen',
      model: 'qwen-vl-max',
    })
  })
})
