// Pruebas reales del exportador del editor (línea de tiempo) con FFmpeg. Ejecutar: npm test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegPath, probe, run } from '../src/main/ffmpeg.ts'
import { atempoChain, buildEditorFilter, renderEditor } from '../src/main/editorRender.ts'

let passed = 0
const ok = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); passed++; console.log('  ✔', name) }
console.log('Render del editor')

const dir = mkdtempSync(join(tmpdir(), 'clipforge-ed-'))
const ff = async (args: string[]): Promise<void> => { const r = await run(ffmpegPath(), ['-y', '-v', 'error', ...args]); assert.equal(r.code, 0, r.stderr) }

/** Color RGB del píxel (x,y) del fotograma en el instante t. */
function pixel(file: string, t: number, x: number, y: number): Promise<[number, number, number]> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])
    const chunks: Buffer[] = []
    p.stdout.on('data', (d: Buffer) => chunks.push(d))
    p.on('error', reject)
    p.on('close', () => { const b = Buffer.concat(chunks); b.length >= 3 ? resolve([b[0], b[1], b[2]]) : reject(new Error('sin fotograma en t=' + t)) })
  })
}
const near = (c: [number, number, number], want: [number, number, number], tol = 40): boolean => c.every((v, i) => Math.abs(v - want[i]) <= tol)

/** Nivel máximo (dB) del audio entre t0 y t1. */
async function maxVolume(file: string, t0: number, t1: number): Promise<number> {
  const r = await run(ffmpegPath(), ['-v', 'info', '-ss', String(t0), '-t', String(t1 - t0), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'])
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m ? (m[1] === '-inf' ? -200 : Number(m[1])) : -200
}

try {
  const red = join(dir, 'red.mp4'); const blue = join(dir, 'blue.mp4'); const green = join(dir, 'green.mp4'); const box = join(dir, 'box.png')
  await ff(['-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', red])
  await ff(['-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=660:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', blue])
  await ff(['-f', 'lavfi', '-i', 'color=c=lime:s=640x360:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', green]) // sin audio
  await ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1080x1920,format=rgba', '-vf', 'drawbox=x=440:y=900:w=200:h=120:color=white@1:t=fill:replace=1', '-frames:v', '1', box])

  const out = join(dir, 'out.mp4')
  const job = (over: object = {}): Parameters<typeof renderEditor>[0] => ({
    clips: [
      { path: red, srcStart: 0, srcEnd: 4, speed: 2, volume: 0, hasAudio: true },      // 0–2 s, rojo, mudo
      { path: blue, srcStart: 0, srcEnd: 2, speed: 1, volume: 1, hasAudio: true },     // 2–4 s, azul, con sonido
      { path: green, srcStart: 0, srcEnd: 1, speed: 0.5, volume: 1, hasAudio: false }  // 4–6 s, verde, cámara lenta, sin audio
    ],
    texts: [{ png: readFileSync(box), start: 3, end: 5 }],
    music: null, fps: 30, quality: 'rapida', outPath: out, tmpDir: join(dir, 'tmp'),
    onProgress: () => {}, onSpawn: () => {}, isCancelled: () => false, ...over
  })

  await ok('atempo encadena para velocidades fuera de 0,5–2×', () => {
    assert.equal(atempoChain(1), '')
    assert.equal(atempoChain(2), 'atempo=2.0000,')
    assert.equal(atempoChain(4), 'atempo=2.0000,atempo=2.0000,')
    assert.equal(atempoChain(0.25), 'atempo=0.5000,atempo=0.5000,')
    assert.equal(atempoChain(3), 'atempo=2.0000,atempo=1.5000,')
  })

  await ok('el filtro incluye un overlay con tiempo por cada texto', () => {
    const f = buildEditorFilter(job().clips, [{ start: 1, end: 2 }, { start: 3, end: 4 }], null, 30)
    assert.equal((f.graph.match(/overlay=/g) ?? []).length, 2)
    assert.ok(f.graph.includes("enable='between(t,3.000,4.000)'"))
    assert.equal(f.musicIdx, -1)
  })

  await ok('exporta 1080x1920 H.264 + AAC con la duración que dan las velocidades', async () => {
    const r = await renderEditor(job())
    assert.ok(Math.abs(r.duration - 6) < 0.01)
    const info = await probe(out)
    assert.equal(info.width, 1080); assert.equal(info.height, 1920); assert.equal(info.codec, 'h264')
    assert.ok(Math.abs(info.duration - 6) < 0.15, `duración ${info.duration}`)
    assert.equal(info.hasAudio, true) // siempre hay pista AAC (silencio si todo está mudo)
  })

  await ok('cada clip aparece en su sitio de la línea de tiempo', async () => {
    assert.ok(near(await pixel(out, 1, 100, 100), [255, 0, 0]), 'rojo en 0–2 s')
    assert.ok(near(await pixel(out, 2.5, 100, 100), [0, 0, 255]), 'azul en 2–4 s')
    assert.ok(near(await pixel(out, 5.5, 100, 100), [0, 255, 0]), 'verde en 4–6 s')
  })

  await ok('el texto solo se ve entre su inicio y su fin', async () => {
    const c = (t: number): Promise<[number, number, number]> => pixel(out, t, 540, 960)
    assert.ok(!near(await c(1), [255, 255, 255]), 'sin texto antes de 3 s')
    assert.ok(!near(await c(2.8), [255, 255, 255]), 'sin texto antes de 3 s (2,8)')
    assert.ok(near(await c(3.5), [255, 255, 255]), 'texto visible a los 3,5 s')
    assert.ok(near(await c(4.8), [255, 255, 255]), 'texto visible a los 4,8 s (clip verde)')
    assert.ok(!near(await c(5.5), [255, 255, 255]), 'sin texto tras 5 s')
  })

  await ok('el volumen por clip funciona: mudo, con sonido y sin pista', async () => {
    assert.ok(await maxVolume(out, 0.2, 1.8) < -60, 'clip rojo con volumen 0 debe estar en silencio')
    assert.ok(await maxVolume(out, 2.2, 3.8) > -40, 'clip azul debe sonar')
    assert.ok(await maxVolume(out, 4.2, 5.8) < -60, 'clip sin audio: silencio')
  })

  await ok('varios textos a la vez y música de fondo (más corta, en bucle)', async () => {
    const music = join(dir, 'm.mp3')
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:d=2', music])
    const two = join(dir, 'two.mp4')
    const r = await renderEditor(job({ outPath: two, texts: [{ png: readFileSync(box), start: 0, end: 6 }, { png: readFileSync(box), start: 1, end: 2 }], music: { path: music, volume: 0.5 }, tmpDir: join(dir, 'tmp2') }))
    assert.ok(Math.abs(r.duration - 6) < 0.01)
    const info = await probe(two)
    assert.ok(Math.abs(info.duration - 6) < 0.15)
    assert.ok(await maxVolume(two, 0.2, 1.8) > -40, 'la música suena aunque el clip esté mudo')
    assert.ok(near(await pixel(two, 0.5, 540, 960), [255, 255, 255]))
  })

  const one = (clip: object, over: object = {}, name = 'look.mp4'): Parameters<typeof renderEditor>[0] => job({
    clips: [{ path: red, srcStart: 0, srcEnd: 4, speed: 1, volume: 1, hasAudio: true, ...clip }], texts: [], outPath: join(dir, name), tmpDir: join(dir, 'tmp-' + name), ...over
  })
  const lum = (c: [number, number, number]): number => (c[0] + c[1] + c[2]) / 3

  await ok('fundido de entrada y de salida (imagen y sonido)', async () => {
    const o = join(dir, 'fade.mp4')
    await renderEditor(one({ fadeIn: 1, fadeOut: 1 }, {}, 'fade.mp4'))
    const a = await pixel(o, 0.05, 100, 100); const b = await pixel(o, 2, 100, 100); const c = await pixel(o, 3.95, 100, 100)
    assert.ok(lum(a) < 60, 'empieza casi negro ' + a)
    assert.ok(near(b, [255, 0, 0]), 'rojo pleno en el centro')
    assert.ok(lum(c) < 60, 'termina casi negro ' + c)
    assert.ok(await maxVolume(o, 3.8, 4) < (await maxVolume(o, 1.5, 2.5)) - 10, 'el sonido baja al final')
  })

  await ok('saturación 0 deja el clip en grises y el brillo lo aclara', async () => {
    const o = join(dir, 'gray.mp4')
    await renderEditor(one({ sat: 0 }, {}, 'gray.mp4'))
    const g = await pixel(o, 1, 100, 100)
    assert.ok(Math.max(...g) - Math.min(...g) < 12, 'gris ' + g)
    const o2 = join(dir, 'bright.mp4')
    await renderEditor(one({ bright: 0.3, sat: 0 }, {}, 'bright.mp4'))
    assert.ok(lum(await pixel(o2, 1, 100, 100)) > lum(g) + 20)
  })

  await ok('encuadre: zoom 0,5 deja bordes negros y px desplaza el clip', async () => {
    const o = join(dir, 'small.mp4')
    await renderEditor(one({ scale: 0.5 }, {}, 'small.mp4'))
    assert.ok(near(await pixel(o, 1, 540, 960), [255, 0, 0]), 'centro rojo')
    assert.ok(lum(await pixel(o, 1, 20, 20)) < 40, 'esquina negra')
    const o2 = join(dir, 'moved.mp4')
    await renderEditor(one({ scale: 0.5, px: 0.25 }, {}, 'moved.mp4'))
    assert.ok(near(await pixel(o2, 1, 540 + 270, 960), [255, 0, 0]), 'rojo desplazado a la derecha')
    assert.ok(lum(await pixel(o2, 1, 540 - 400, 960)) < 40, 'a la izquierda queda negro')
  })

  await ok('encuadre: giro 45° con espejo exporta 1080x1920 y conserva el centro', async () => {
    const o = join(dir, 'rot.mp4')
    await renderEditor(one({ rot: 45, flip: true, scale: 0.6 }, {}, 'rot.mp4'))
    const info = await probe(o)
    assert.equal(info.width, 1080); assert.equal(info.height, 1920)
    assert.ok(near(await pixel(o, 1, 540, 960), [255, 0, 0]))
    assert.ok(lum(await pixel(o, 1, 10, 10)) < 40)
  })

  await ok('giro positivo = sentido horario (izquierda arriba) y espejo', async () => {
    const split = join(dir, 'split.mp4')
    await ff(['-f', 'lavfi', '-i', 'color=c=red:s=360x1280:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=360x1280:r=30:d=2', '-filter_complex', '[0][1]hstack', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', split])
    const o = join(dir, 'rot90.mp4')
    await renderEditor(one({ path: split, srcEnd: 2, rot: 90, hasAudio: false }, {}, 'rot90.mp4'))
    assert.ok(near(await pixel(o, 0.8, 540, 600), [255, 0, 0]), 'rojo arriba')
    assert.ok(near(await pixel(o, 0.8, 540, 1300), [0, 0, 255]), 'azul abajo')
    const o2 = join(dir, 'flip.mp4')
    await renderEditor(one({ path: split, srcEnd: 2, flip: true, hasAudio: false }, {}, 'flip.mp4'))
    assert.ok(near(await pixel(o2, 0.8, 200, 960), [0, 0, 255]) && near(await pixel(o2, 0.8, 900, 960), [255, 0, 0]), 'espejo')
  })

  await ok('pistas de audio con inicio propio suenan solo desde ese instante', async () => {
    const tone = join(dir, 'tone.mp3')
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=330:d=3', tone])
    const o = join(dir, 'aud.mp4')
    await renderEditor(one({ volume: 0 }, { audios: [{ path: tone, start: 2, duration: 1, volume: 1, fadeIn: 0, fadeOut: 0 }] }, 'aud.mp4'))
    assert.ok(await maxVolume(o, 0.2, 1.8) < -60, 'silencio antes del inicio')
    assert.ok(await maxVolume(o, 2.1, 2.9) > -40, 'suena desde 2 s')
    assert.ok(await maxVolume(o, 3.2, 3.9) < -60, 'se corta tras su duración')
  })

  await ok('cancelar no deja archivos a medias', async () => {
    let cancelled = false
    const c = join(dir, 'cancel.mp4')
    await assert.rejects(renderEditor(job({ outPath: c, tmpDir: join(dir, 'tmp3'), onSpawn: (p: { kill: () => void }) => { setTimeout(() => { cancelled = true; p.kill() }, 40) }, isCancelled: () => cancelled })))
    await assert.rejects(probe(c))
    await assert.rejects(probe(c + '.part.mp4'))
  })
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log(`\n${passed} pruebas del exportador OK`)
