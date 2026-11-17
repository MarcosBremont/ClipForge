// Prueba del autoactualizador: sirve un "release" falso (v9.9.9) desde un servidor local y comprueba
// que la app lo detecta, lo descarga y valida su sha512. Requiere un instalador en release/ (npm run dist:win).
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const exe = readdirSync('release').find((f) => /Setup.*\.exe$/.test(f))
if (!exe) { console.error('No hay instalador en release/. Ejecuta npm run dist:win primero.'); process.exit(1) }
const work = process.env.E2E_DIR ?? mkdtempSync(join(tmpdir(), 'clipforge-upd-'))
const feed = join(work, 'feed'); mkdirSync(feed, { recursive: true })
const name = 'ClipForge-Setup-9.9.9.exe'
copyFileSync(join('release', exe), join(feed, name))
const sha512 = createHash('sha512').update(readFileSync(join(feed, name))).digest('base64')
const size = statSync(join(feed, name)).size
writeFileSync(join(feed, 'latest.yml'), `version: 9.9.9\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '2026-11-18T00:00:00.000Z'\nreleaseNotes: Versión de prueba\n`)

const server = createServer((req, res) => {
  const f = join(feed, decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, ''))
  try { const st = statSync(f); res.writeHead(200, { 'Content-Length': st.size }); createReadStream(f).pipe(res) } catch { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const env = { ...process.env, CLIPFORGE_E2E_UPDATE: work, CLIPFORGE_UPDATE_URL: url }
delete env.ELECTRON_RUN_AS_NODE
// spawn asíncrono: spawnSync bloquearía este proceso y el servidor local no podría responder.
// Con --packed se prueba la app instalada/empaquetada (caso real); sin él, el modo desarrollo.
const child = process.argv.includes('--packed')
  ? spawn(join('release', 'win-unpacked', 'ClipForge.exe'), [], { env, stdio: 'inherit' })
  : spawn(createRequire(import.meta.url)('electron'), ['.'], { env, stdio: 'inherit' })
const timer = setTimeout(() => child.kill(), 5 * 60 * 1000)
const r = { status: await new Promise((res) => child.on('close', res)) }
clearTimeout(timer)
server.close()
let log = ''; try { log = readFileSync(join(work, 'update.log'), 'utf8') } catch { /* sin log */ }
console.log(log)
process.exit(/FAIL/.test(log) || !log ? 1 : (r.status ?? 0))
