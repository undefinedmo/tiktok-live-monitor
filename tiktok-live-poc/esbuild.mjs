import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron', 'better-sqlite3', 'electron-updater'] }

await build({ ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/main.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/preload.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload-viewer.ts'], outfile: 'dist/preload-viewer.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload-seller.ts'], outfile: 'dist/preload-seller.cjs' })
await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  outfile: 'dist/renderer.js',
})

// The renderer HTML + logo are loaded from dist/ (alongside main.cjs), so copy them there.
mkdirSync('dist', { recursive: true })
copyFileSync('src/renderer/index.html', 'dist/index.html')
copyFileSync('src/renderer/sf-logo.png', 'dist/sf-logo.png')

console.log('build complete')
