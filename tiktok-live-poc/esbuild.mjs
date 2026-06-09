import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', external: ['electron'] }

await build({ ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/main.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/preload.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload-viewer.ts'], outfile: 'dist/preload-viewer.cjs' })
await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  outfile: 'dist/renderer.js',
})

// The renderer HTML is loaded from dist/ (alongside main.cjs), so copy it there.
mkdirSync('dist', { recursive: true })
copyFileSync('src/renderer/index.html', 'dist/index.html')

console.log('build complete')
