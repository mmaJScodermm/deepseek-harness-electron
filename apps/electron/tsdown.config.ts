import { defineConfig } from 'tsdown'

/** Build Electron Main as ESM and its sandbox-compatible preload as CJS. */
export default defineConfig([
  {
    entry: ['lib/types/main.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    deps: { neverBundle: ['electron'] },
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { preload: 'lib/types/preload.js' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'node',
    target: 'es2024',
    deps: { neverBundle: ['electron'] },
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
