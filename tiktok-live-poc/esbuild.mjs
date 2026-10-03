import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

const VERSION = JSON.parse(readFileSync('./package.json', 'utf8')).version

// Sourcemaps ship in the installer. They cost ~1MB in an 82MB package and turn an
// uncaughtException stack in the flight log from "main.cjs:1:84210" into a real
// file:line — the flight log is the only postmortem a live show ever gets.
const SOURCEMAP = 'linked'

const common = { bundle: true, platform: 'node', target: 'node20', format: 'cjs', sourcemap: SOURCEMAP, external: ['electron', 'electron-updater'] }

// The journal worker is bundled to a STRING and inlined into main (new Worker(src, { eval: true })),
// so the packaged app has no worker file to locate inside app.asar. No sourcemap: it is eval'd.
const journalWorker = await build({ ...common, sourcemap: false, entryPoints: ['src/electron/journalWorker.ts'], write: false })
const JOURNAL_WORKER_SRC = journalWorker.outputFiles[0].text

await build({ ...common, entryPoints: ['src/electron/main.ts'], outfile: 'dist/main.cjs', define: { __JOURNAL_WORKER_SRC__: JSON.stringify(JOURNAL_WORKER_SRC) } })
await build({ ...common, entryPoints: ['src/electron/preload.ts'], outfile: 'dist/preload.cjs' })
await build({ ...common, entryPoints: ['src/electron/preload-viewer.ts'], outfile: 'dist/preload-viewer.cjs' })
await build({
  entryPoints: ['src/renderer/renderer.ts'],
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  sourcemap: SOURCEMAP,
  outfile: 'dist/renderer.js',
  define: { __APP_VERSION__: JSON.stringify(VERSION) }, // real version for the UI badge
})

// The renderer HTML + logo are loaded from dist/ (alongside main.cjs), so copy them there.
mkdirSync('dist', { recursive: true })
copyFileSync('src/renderer/index.html', 'dist/index.html')
copyFileSync('src/renderer/sf-logo.png', 'dist/sf-logo.png')

console.log('build complete')
