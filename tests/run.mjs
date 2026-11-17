// Empaqueta y ejecuta las pruebas del motor (TypeScript) con rolldown, que ya viene con Vite.
import { build } from 'rolldown'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const out = mkdtempSync(join(tmpdir(), 'clipforge-bundle-'))
const file = join(out, 'engine.test.mjs')
await build({
  input: resolve('tests/engine.test.ts'),
  platform: 'node',
  resolve: { alias: { '@shared': resolve('src/shared') } },
  external: [/^node:/, 'ffmpeg-static', 'ffprobe-static', 'electron'],
  output: {
    file, format: 'esm',
    banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(" + JSON.stringify(resolve('package.json')) + ');'
  }
})
const req = createRequire(import.meta.url)
const env = { ...process.env, CLIPFORGE_FFMPEG: req('ffmpeg-static'), CLIPFORGE_FFPROBE: req('ffprobe-static').path }
const r = spawnSync(process.execPath, [file], { stdio: 'inherit', env })
process.exit(r.status ?? 1)
