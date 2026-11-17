// Pruebas reales del motor: planificador + render con FFmpeg. Ejecutar: npm test
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comboKey, makePlan, replaceSegment, resolveTimings, totalDuration, mulberry32 } from '../src/shared/planner.ts'
import { ffmpegPath, probe, run } from '../src/main/ffmpeg.ts'
import { renderVideo } from '../src/main/render.ts'

const base = {
  duration: 15, auto: true, segmentCount: null, segmentLength: null, speed: 'normal', fps: 30, quality: 'rapida',
  originalAudio: false, musicPath: null, musicVolume: 0.8, versions: 1, watermark: '', useAI: false
} as const
const mk = (id: number, duration: number) => ({ id, path: `/v${id}.mp4`, name: `v${id}`, folder: '/', duration, width: 1920, height: 1080, fps: 30, codec: 'h264', format: 'mp4', size: 1, hasAudio: true, hash: String(id), thumb: null, dupOf: null, missing: false, libraryId: 1, addedAt: 0, scenes: null })

let passed = 0
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { passed++; console.log('  ✔', name) })

console.log('Planificador')
const videos = Array.from({ length: 60 }, (_, i) => mk(i + 1, 40 + (i % 7) * 20))

await ok('la suma de duraciones es exactamente la duración pedida', () => {
  for (const d of [10, 15, 20, 30, 45, 60]) for (const speed of ['lento', 'normal', 'rapido'] as const) {
    for (const auto of [true, false]) {
      const t = resolveTimings({ ...base, duration: d, speed, auto }, mulberry32(d))
      assert.ok(Math.abs(t.reduce((a, b) => a + b, 0) - d) < 0.06, `${d}/${speed}/${auto}: ${t.reduce((a, b) => a + b, 0)}`)
      assert.ok(t.every((x) => x >= 0.39))
    }
  }
})
await ok('respeta cantidad de fragmentos manual', () => {
  const p = makePlan({ videos, settings: { ...base, auto: false, segmentCount: 9, duration: 20 }, used: [], seed: 1 })
  assert.equal(p.segments.length, 9)
  assert.ok(Math.abs(totalDuration(p.segments) - 20) < 0.06)
})
await ok('usa videos distintos y no solapa fragmentos del mismo video', () => {
  const p = makePlan({ videos, settings: { ...base, duration: 30 }, used: [], seed: 7 })
  const ids = new Set(p.segments.map((s) => s.videoId))
  assert.ok(ids.size >= p.segments.length * 0.9, `${ids.size}/${p.segments.length}`)
  for (const a of p.segments) for (const b of p.segments) if (a !== b && a.videoId === b.videoId) assert.ok(a.start + a.duration <= b.start || b.start + b.duration <= a.start)
})
await ok('no se limita a los primeros segundos de cada video', () => {
  let sum = 0; let n = 0
  for (let seed = 1; seed <= 50; seed++) for (const s of makePlan({ videos, settings: base, used: [], seed }).segments) { sum += s.start / videos.find((v) => v.id === s.videoId)!.duration; n++ }
  const mean = sum / n
  assert.ok(mean > 0.35 && mean < 0.65, `posición media relativa ${mean.toFixed(2)}`)
})
await ok('los fragmentos caben dentro de su video', () => {
  for (let seed = 1; seed <= 100; seed++) for (const s of makePlan({ videos, settings: { ...base, duration: 60, speed: 'lento' }, used: [], seed }).segments) {
    const v = videos.find((x) => x.id === s.videoId)!
    assert.ok(s.start >= 0 && s.start + s.duration <= v.duration, `${s.start}+${s.duration} > ${v.duration}`)
  }
})
await ok('evita el historial de fragmentos ya usados', () => {
  const first = makePlan({ videos, settings: base, used: [], seed: 3 })
  const used = first.segments.map((s) => ({ videoId: s.videoId, start: s.start, duration: s.duration }))
  const second = makePlan({ videos, settings: base, used, seed: 3 })
  for (const a of second.segments) for (const u of used) if (a.videoId === u.videoId) assert.ok(a.start + a.duration <= u.start || u.start + u.duration <= a.start, 'solapa con historial')
})
await ok('10 versiones distintas desde una misma biblioteca', () => {
  const avoid: Array<{ videoId: number; start: number; duration: number }> = []
  const keys = new Set<string>()
  for (let v = 0; v < 10; v++) {
    const p = makePlan({ videos, settings: base, used: [], avoid, seed: 100 + v })
    keys.add(comboKey(p.segments)); avoid.push(...p.segments.map((s) => ({ videoId: s.videoId, start: s.start, duration: s.duration })))
  }
  assert.equal(keys.size, 10)
})
await ok('funciona con pocos videos cortos (degradación controlada)', () => {
  const few = [mk(1, 3), mk(2, 2.5)]
  const p = makePlan({ videos: few, settings: { ...base, duration: 20 }, used: [], seed: 5 })
  assert.ok(p.segments.length >= 2)
  for (const s of p.segments) { const v = few.find((x) => x.id === s.videoId)!; assert.ok(s.start + s.duration <= v.duration + 0.01) }
})
await ok('reemplazar un fragmento mantiene la duración y cambia el contenido', () => {
  const p = makePlan({ videos, settings: base, used: [], seed: 9 })
  const q = replaceSegment(p, 2, videos, [], 77)
  assert.equal(q.segments[2].duration, p.segments[2].duration)
  assert.ok(q.segments[2].videoId !== p.segments[2].videoId || q.segments[2].start !== p.segments[2].start)
})

console.log('Render con FFmpeg')
const dir = mkdtempSync(join(tmpdir(), 'clipforge-test-'))
const ff = async (args: string[]) => { const r = await run(ffmpegPath(), ['-y', '-v', 'error', ...args]); assert.equal(r.code, 0, r.stderr) }
try {
  const a = join(dir, 'a.mp4'); const b = join(dir, 'b.mkv'); const c = join(dir, 'c.mov'); const music = join(dir, 'm.mp3'); const png = join(dir, 'overlay.png')
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', a])
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=5', '-c:v', 'libx264', b]) // MKV, sin audio
  await ff(['-f', 'lavfi', '-i', 'smptebars=size=720x1280:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', c]) // vertical
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', music])
  await ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1080x1920,format=rgba', '-vf', 'drawbox=x=440:y=900:w=200:h=120:color=white@1:t=fill:replace=1', '-frames:v', '1', png])
  const infoA = await probe(a)
  assert.equal(infoA.width, 1280); assert.equal(infoA.hasAudio, true)
  assert.equal((await probe(b)).hasAudio, false)
  await ok('ffprobe lee metadatos de MP4/MKV/MOV', () => {})

  const segments = [
    { path: a, start: 1.2, duration: 1.5, hasAudio: true },
    { path: b, start: 0.5, duration: 1.0, hasAudio: false },
    { path: c, start: 0.3, duration: 2.0, hasAudio: true },
    { path: a, start: 3.7, duration: 0.8, hasAudio: true }
  ]
  const total = totalDuration(segments)
  const style = { wholeVideo: true, startAt: 0, endAt: null } as never
  const render = async (name: string, settings: object, wm = false, musicPath: string | null = null) => {
    const out = join(dir, name)
    const prog: number[] = []
    const r = await renderVideo({
      segments, settings: { ...base, ...settings, musicPath } as never, style, textPng: readFileSync(png), watermarkPng: wm ? readFileSync(png) : null,
      outPath: out, tmpDir: join(dir, 't-' + name), onProgress: (f) => prog.push(f), onSpawn: () => {}, isCancelled: () => false
    })
    assert.ok(statSync(out).size > 1000)
    assert.ok(prog.length > 0 && prog[prog.length - 1] === 1, 'progreso')
    return { out, r, info: await probe(out) }
  }

  await ok('exporta 1080x1920 H.264 sin audio, 30fps, duración exacta', async () => {
    const { info, out } = await render('noaudio.mp4', {})
    assert.equal(info.width, 1080); assert.equal(info.height, 1920); assert.equal(info.codec, 'h264'); assert.equal(info.fps, 30); assert.equal(info.hasAudio, false)
    assert.ok(Math.abs(info.duration - total) < 0.1, `${info.duration} vs ${total}`)
    // el texto (cuadro blanco) debe verse en el centro y no en una esquina
    const px = async (x: number, y: number) => {
      const r = await new Promise<Buffer>((res, rej) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const p = require('node:child_process').spawn(ffmpegPath(), ['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', `crop=1:1:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-'])
        const chunks: Buffer[] = []; p.stdout.on('data', (d: Buffer) => chunks.push(d)); p.on('close', () => res(Buffer.concat(chunks))); p.on('error', rej)
      })
      return [...r]
    }
    assert.deepEqual(await px(540, 960), [255, 255, 255])
    assert.notDeepEqual(await px(50, 50), [255, 255, 255])
  })
  await ok('exporta a 60 fps', async () => { const { info } = await render('fps60.mp4', { fps: 60 }); assert.equal(info.fps, 60) })
  await ok('con audio original: AAC y mezcla de fragmentos con/sin audio', async () => {
    const { info } = await render('audio.mp4', { originalAudio: true })
    assert.equal(info.hasAudio, true); assert.ok(Math.abs(info.duration - total) < 0.15)
  })
  await ok('con música de fondo (más corta que el video, se repite)', async () => {
    const { info } = await render('music.mp4', {}, false, music)
    assert.equal(info.hasAudio, true); assert.ok(Math.abs(info.duration - total) < 0.15)
  })
  await ok('audio original + música + marca de agua', async () => {
    const { info } = await render('all.mp4', { originalAudio: true }, true, music)
    assert.equal(info.hasAudio, true); assert.equal(info.width, 1080)
  })
  await ok('el archivo parcial no queda si se cancela', async () => {
    let cancelled = false
    const out = join(dir, 'cancel.mp4')
    await assert.rejects(renderVideo({
      segments, settings: base as never, style, textPng: null, watermarkPng: null, outPath: out, tmpDir: join(dir, 't-c'),
      onProgress: () => {}, onSpawn: (p) => { setTimeout(() => { cancelled = true; p.kill() }, 50) }, isCancelled: () => cancelled
    }))
    assert.throws(() => statSync(out)); assert.throws(() => statSync(out + '.part.mp4'))
  })
  mkdirSync(dir, { recursive: true })
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log(`\n${passed} pruebas OK`)
