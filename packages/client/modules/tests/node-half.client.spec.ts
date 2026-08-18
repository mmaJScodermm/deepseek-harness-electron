/** Node-half composition diagnostics for package metadata and built client bundles. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { WebServer, WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { ClientModuleRegistry } from '../src/index.ts'

let root: string | undefined
let profileRoot: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  if (profileRoot !== undefined) rmSync(profileRoot, { recursive: true, force: true })
  root = undefined
  profileRoot = undefined
})

/** Create a resolvable package whose client export points at the returned path. */
function writePackage(
  packageName: string,
  metadata: Record<string, unknown> = { dsh: { client: { platform: 'web' } } },
): string {
  root ??= realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-modules-')))
  const pkgRoot = join(root, 'node_modules', ...packageName.split('/'))
  const clientPath = join(pkgRoot, 'lib', 'client.js')
  mkdirSync(pkgRoot, { recursive: true })
  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: packageName,
    exports: {
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    ...metadata,
  }))
  return clientPath
}

/** Construct a context carrying the enabled fixture entries. */
function constructContext(packageNames: string[]): Context {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root!).href + '/'
  ctx.provide('loader', {
    *entries() {
      for (const packageName of packageNames) {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      }
    },
  })
  return ctx
}

/** Mount the node-half service and capture its plugin-bundle route. */
async function constructWithRoute(packageNames: string[]): Promise<{ service: ClientModuleRegistry; route: WebRoute }> {
  const ctx = constructContext(packageNames)
  let route: WebRoute | undefined
  const webServer: Pick<WebServer, 'port' | 'register' | 'tapIndex'> = {
    port: 0,
    register: (candidate) => {
      if (candidate.path === '/plugins') route = candidate
      return () => {}
    },
    tapIndex: () => () => {},
  }
  ctx.provide('webServer', webServer as WebServer)
  await ctx.plugin(ClientModuleRegistry).await()
  const service = ctx.clientModules
  if (route === undefined) throw new Error('client bundle route was not registered')
  return { service, route }
}

/** Construct the node-half service over the enabled fixture entries. */
function construct(packageNames: string[]): ClientModuleRegistry {
  return new ClientModuleRegistry(constructContext(packageNames))
}

describe('client bundle activation', () => {
  it('composes the graph without an HTTP carrier', () => {
    const packageName = '@fixture/electron-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    ctx.provide('loader', {
      *entries() {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      },
    })
    expect(new ClientModuleRegistry(ctx).graph().entries).toMatchObject([{ id: packageName }])
  })

  it('resolves client packages from the installed host instead of the writable profile', () => {
    const packageName = '@fixture/packaged-client'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    profileRoot = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-client-profile-')))
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(profileRoot).href + '/'
    ctx.provide('dshPackageBaseUrl', pathToFileURL(join(root!, 'package.json')).href)
    ctx.provide('loader', {
      *entries() {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      },
    })

    expect(() => createRequire(ctx.baseUrl!).resolve(`${packageName}/package.json`)).toThrow()
    expect(new ClientModuleRegistry(ctx).graph().entries).toMatchObject([{ id: packageName }])
  })

  it('attaches and disposes the Web carrier when it activates after the registry', async () => {
    const packageName = '@fixture/late-web-carrier'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(root!).href + '/'
    ctx.provide('loader', {
      *entries() {
        yield { options: { name: packageName }, fiber: {}, disabled: false }
      },
    })
    const registryFiber = ctx.plugin(ClientModuleRegistry)
    await registryFiber.await()

    let route: WebRoute | undefined
    let transform: ((html: string) => string) | undefined
    let routeDisposed = false
    let transformDisposed = false
    const webFiber = ctx.plugin({
      apply(webCtx) {
        webCtx.provide('webServer', {
          register: (candidate: WebRoute) => {
            route = candidate
            return () => { routeDisposed = true }
          },
          tapIndex: (candidate: (html: string) => string) => {
            transform = candidate
            return () => { transformDisposed = true }
          },
        } as WebServer)
      },
    })
    await webFiber.await()

    expect(route).toMatchObject({ kind: 'prefix', path: '/plugins' })
    expect(transform?.('<head></head>')).toContain('window.__DSH_BOOT__')
    await webFiber.dispose()
    expect(routeDisposed).toBe(true)
    expect(transformDisposed).toBe(true)
    await registryFiber.dispose()
  })

  it('allows sibling dsh roles', () => {
    const currentName = '@fixture/current-client-field'
    const clientPath = writePackage(currentName, {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        profile: { bundles: [] },
      },
    })
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    expect(construct([currentName]).graph().entries.map(entry => entry.id)).toEqual([currentName])
  })

  it('groups missing bundles under one source-build instruction with a package/path list', () => {
    const firstName = '@fixture/missing-first'
    const secondName = '@fixture/missing-second'
    const firstPath = writePackage(firstName)
    const secondPath = writePackage(secondName)
    expect(() => construct([firstName, secondName])).toThrow([
      'client-modules: 2 client packages failed to compose:',
      '  client bundles not found; run `pnpm run build` before launch:',
      `    - package: ${firstName}`,
      `      path: ${firstPath}`,
      `    - package: ${secondName}`,
      `      path: ${secondPath}`,
    ].join('\n'))
  })

  it('does not report other bundle read failures as missing builds', () => {
    const packageName = '@fixture/unreadable-client'
    const clientPath = writePackage(packageName)
    mkdirSync(clientPath, { recursive: true })
    let thrown: unknown
    try {
      construct([packageName])
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('client-modules: 1 client package failed to compose:')
    expect(String(thrown)).toContain('  other failures:')
    expect(String(thrown)).toContain('EISDIR')
    expect(String(thrown)).not.toContain('pnpm run build')
  })

  it('serves the source map beside a registered client bundle', async () => {
    const packageName = '@fixture/source-map'
    const clientPath = writePackage(packageName)
    mkdirSync(dirname(clientPath), { recursive: true })
    writeFileSync(clientPath, 'module.exports = {}\n')
    const map = '{"version":3,"sources":["src/client/index.tsx"]}\n'
    writeFileSync(`${clientPath}.map`, map)
    const { route } = await constructWithRoute([packageName])
    let status = 0
    let headers: Record<string, string> | undefined
    let body = ''
    const response = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>) {
        status = nextStatus
        headers = nextHeaders
        return response
      },
      end(chunk?: Uint8Array) {
        body = chunk === undefined ? '' : Buffer.from(chunk).toString('utf8')
        return response
      },
    } as unknown as ServerResponse

    await route.handler({
      method: 'GET',
      url: `/plugins/${packageName}/client.js.map`,
    } as IncomingMessage, response)

    expect(status).toBe(200)
    expect(headers).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    })
    expect(body).toBe(map)
  })
})
