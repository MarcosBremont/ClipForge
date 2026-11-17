// Pruebas de integración reales dentro de Electron.
//   npm run build && npm run test:e2e            → flujo completo (importar, generar, exportar, verificar)
//   npm run build && npm run test:playback       → reproductor con videos grandes (saltos de fragmento sincronizados)
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const playback = process.argv[2] === 'playback'
const require = createRequire(import.meta.url)
const work = process.env.E2E_DIR ?? mkdtempSync(join(tmpdir(), 'clipforge-e2e-'))
const env = { ...process.env, [playback ? 'CLIPFORGE_E2E_PLAYBACK' : 'CLIPFORGE_E2E']: work }
delete env.ELECTRON_RUN_AS_NODE // algunos entornos (VS Code) lo definen y harían correr Electron como Node
const r = spawnSync(require('electron'), ['.'], { stdio: 'inherit', env, timeout: 10 * 60 * 1000 })
let log = ''
try { log = readFileSync(join(work, playback ? 'diag.log' : 'e2e.log'), 'utf8') } catch { console.log('No se generó el log') }
console.log(log)
console.log('Resultados en', work)
const bad = playback ? /desajustes: (?!0\b)\d+|EXCEPCION|sin fotogramas nuevos: (?!0\b)\d+/.test(log) : /FAIL|EXCEPCION/.test(log)
process.exit(bad || !log ? 1 : (r.status ?? 0))
