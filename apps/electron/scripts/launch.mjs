/** Launch the desktop application without an inherited Electron Node-mode flag. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const result = spawnSync(electronPath, [appRoot], {
  cwd: appRoot,
  env: environment,
  stdio: 'inherit',
})

if (result.error !== undefined) throw result.error
if (result.signal !== null) process.kill(process.pid, result.signal)
process.exitCode = result.status ?? 1
