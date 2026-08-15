/** Verify that Electron's production dependency closure provides every required workspace peer. */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))

async function readManifest(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

async function expandWorkspace(pattern) {
  let directories = [repositoryRoot]
  for (const segment of pattern.split('/')) {
    if (segment !== '*') {
      directories = directories.map(directory => join(directory, segment))
      continue
    }
    const expanded = []
    for (const directory of directories) {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) expanded.push(join(directory, entry.name))
      }
    }
    directories = expanded
  }
  return directories
}

function dependencyNames(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
}

function productionClosure(rootManifest, manifests) {
  const closure = new Set()
  const pending = dependencyNames(rootManifest)
  while (pending.length > 0) {
    const name = pending.shift()
    if (closure.has(name)) continue
    closure.add(name)
    const manifest = manifests.get(name)
    if (manifest !== undefined) pending.push(...dependencyNames(manifest))
  }
  return closure
}

function missingWorkspacePeers(closure, manifests) {
  const missing = new Map()
  for (const owner of [...closure].sort()) {
    const manifest = manifests.get(owner)
    if (manifest === undefined) continue
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[peer]?.optional === true
        || !manifests.has(peer)
        || closure.has(peer)) continue
      const owners = missing.get(peer) ?? []
      owners.push(owner)
      missing.set(peer, owners)
    }
  }
  return missing
}

const rootManifest = await readManifest(repositoryRoot)
const workspaceDirectories = (await Promise.all(
  rootManifest.workspaces.map(pattern => expandWorkspace(pattern)),
)).flat()
const workspaceManifests = new Map()
for (const directory of workspaceDirectories) {
  const manifest = await readManifest(directory)
  if (typeof manifest.name === 'string') workspaceManifests.set(manifest.name, manifest)
}

const electronManifest = workspaceManifests.get('@deepseek-ai/dsh-electron')
if (electronManifest === undefined) throw new Error('electron runtime dependencies: package not found')
const closure = productionClosure(electronManifest, workspaceManifests)
const missing = missingWorkspacePeers(closure, workspaceManifests)
if (missing.size > 0) {
  const details = [...missing]
    .map(([peer, owners]) => {
      const shownOwners = owners.slice(0, 3).join(', ')
      const remainder = owners.length > 3 ? `, and ${owners.length - 3} more` : ''
      return `- ${peer} (required by ${shownOwners}${remainder})`
    })
    .join('\n')
  throw new Error(`electron runtime dependencies: missing required workspace peers:\n${details}`)
}

console.log(`electron runtime dependencies: ${closure.size} production packages, all required workspace peers provided`)
