// Pruebas del modelo del editor (línea de tiempo). Ejecutar: npm test
import assert from 'node:assert/strict'
import {
  addClip, addText, clipDur, clipStarts, duplicateClip, duplicateText, fromPlan, locate, moveClip, moveText, newProject, normalize,
  removeClip, removeText, resizeText, setClip, setText, snap, splitAt, textsAt, totalDuration, trimClip, MIN_CLIP,
  addAudio, addSticker, applyMotion, frameAt, textAnim, animLen, captionsFromText, splitCaptions, applyFilter, clipLook, hasColor, hasFrame, moveAudio, removeAudio, setAudio, setTransition, transitionAt, FILTERS
} from '../src/shared/editor.ts'
import { DEFAULT_TEXT_STYLE } from '../src/shared/types.ts'

let passed = 0
const ok = (name: string, fn: () => void): void => { fn(); passed++; console.log('  ✔', name) }
const close = (a: number, b: number, eps = 0.002): void => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

console.log('Editor de video (modelo)')

const base = (): ReturnType<typeof newProject> => {
  let p = newProject()
  p = addClip(p, 1, 10) // 0–10
  p = addClip(p, 2, 6)  // 10–16
  return p
}

ok('la duración total suma los clips y respeta la velocidad', () => {
  let p = base()
  close(totalDuration(p), 16)
  p = setClip(p, p.clips[0].id, { speed: 2 })
  close(totalDuration(p), 5 + 6)
  p = setClip(p, p.clips[1].id, { speed: 0.5 })
  close(totalDuration(p), 5 + 12)
  close(clipDur(p.clips[1]), 12)
})

ok('la velocidad se limita a 0,25–4× y el volumen a 0–1', () => {
  const p = base()
  assert.equal(setClip(p, p.clips[0].id, { speed: 99 }).clips[0].speed, 4)
  assert.equal(setClip(p, p.clips[0].id, { speed: 0 }).clips[0].speed, 0.25)
  assert.equal(setClip(p, p.clips[0].id, { volume: 3 }).clips[0].volume, 1)
  assert.equal(setClip(p, p.clips[0].id, { volume: -1 }).clips[0].volume, 0)
})

ok('cortar divide un clip en dos sin perder ni duplicar tiempo', () => {
  const p = base()
  const r = splitAt(p, 4)!
  assert.equal(r.project.clips.length, 3)
  close(totalDuration(r.project), 16)
  const [a, b] = r.project.clips
  close(a.srcEnd, 4); close(b.srcStart, 4); assert.equal(a.videoId, b.videoId)
  assert.equal(r.selectId, b.id)
})

ok('cortar un clip acelerado usa el instante correcto del video original', () => {
  let p = base()
  p = setClip(p, p.clips[0].id, { speed: 2 }) // 10 s de video → 5 s en pantalla
  const r = splitAt(p, 2)! // 2 s de pantalla = 4 s del original
  close(r.project.clips[0].srcEnd, 4)
  close(totalDuration(r.project), 11)
})

ok('no se corta demasiado cerca de un borde ni fuera del video', () => {
  const p = base()
  assert.equal(splitAt(p, 0.1), null)
  assert.equal(splitAt(p, 10 - 0.1), null)
  assert.equal(splitAt(newProject(), 1), null)
})

ok('recortar mueve solo el borde pedido y respeta el mínimo y la duración del original', () => {
  let p = base()
  const id = p.clips[0].id
  p = trimClip(p, id, 'start', 3, 10)
  close(p.clips[0].srcStart, 3); close(totalDuration(p), 13)
  p = trimClip(p, id, 'end', 99, 10)
  close(p.clips[0].srcEnd, 10) // no pasa de la duración del video
  p = trimClip(p, id, 'end', 3.01, 10)
  close(clipDur(p.clips[0]), MIN_CLIP) // mínimo
  p = trimClip(p, id, 'start', -5, 10)
  assert.equal(p.clips[0].srcStart, 0)
})

ok('mover, duplicar y borrar clips', () => {
  let p = base()
  const [a, b] = p.clips.map((c) => c.id)
  p = moveClip(p, 0, 1)
  assert.deepEqual(p.clips.map((c) => c.id), [b, a])
  const d = duplicateClip(p, a)!
  assert.equal(d.project.clips.length, 3); assert.equal(d.project.clips[2].videoId, p.clips[1].videoId)
  p = removeClip(d.project, b)
  assert.equal(p.clips.length, 2)
  close(clipStarts(p)[1], clipDur(p.clips[0]))
})

ok('locate devuelve el clip y el instante del original (con velocidad)', () => {
  let p = base()
  p = setClip(p, p.clips[1].id, { speed: 2 }) // segundo clip: 3 s en pantalla, 6 s de video
  const l = locate(p, 10 + 1)! // 1 s dentro del 2.º clip → 2 s del original
  assert.equal(l.index, 1); close(l.start, 10); close(l.src, 2)
  assert.equal(locate(p, 9999)!.index, 1) // más allá del final: último clip
  assert.equal(locate(newProject(), 1), null)
})

ok('los textos se mantienen dentro de la duración al acortar el video', () => {
  let p = base()
  p = addText(p, 12, 'hola').project
  assert.ok(p.texts[0].start + p.texts[0].duration <= 16 + 1e-6)
  p = removeClip(p, p.clips[1].id) // total pasa a 10
  const t = p.texts[0]
  assert.ok(t.start <= 10 - 0.3 + 1e-6 && t.start + t.duration <= 10 + 1e-6, JSON.stringify(t))
  p = removeClip(p, p.clips[0].id) // sin clips: no hay textos
  assert.equal(p.texts.length, 0)
})

ok('texto: añadir, mover, redimensionar, duplicar, borrar', () => {
  let p = base()
  const r = addText(p, 2, 'uno')
  p = r.project
  const id = r.selectId
  close(p.texts[0].start, 2); close(p.texts[0].duration, 3)
  p = moveText(p, id, 100)
  close(p.texts[0].start, 16 - 3) // tope: el final del video
  p = moveText(p, id, -5)
  close(p.texts[0].start, 0)
  p = resizeText(p, id, 'end', 8)
  close(p.texts[0].duration, 8)
  p = resizeText(p, id, 'start', 2) // el borde derecho se queda en 8
  close(p.texts[0].start, 2); close(p.texts[0].start + p.texts[0].duration, 8)
  p = resizeText(p, id, 'end', 2.05) // mínimo
  close(p.texts[0].duration, 0.3)
  const d = duplicateText(p, id)!
  assert.equal(d.project.texts.length, 2)
  assert.ok(d.project.texts[1].style.y > d.project.texts[0].style.y) // la copia se ve distinta
  assert.equal(removeText(d.project, id).texts.length, 1)
})

ok('textsAt devuelve los textos visibles (y varios a la vez)', () => {
  let p = base()
  p = addText(p, 1, 'a').project
  p = addText(p, 2, 'b').project
  assert.deepEqual(textsAt(p, 0.5).map((t) => t.text), [])
  assert.deepEqual(textsAt(p, 2.5).map((t) => t.text), ['a', 'b'])
  assert.deepEqual(textsAt(p, 4.5).map((t) => t.text), ['b'])
})

ok('setText cambia posición y estilo sin tocar el resto', () => {
  let p = base()
  const r = addText(p, 0, 'x', { ...DEFAULT_TEXT_STYLE, x: 0.5, y: 0.5 })
  p = setText(r.project, r.selectId, { text: 'nuevo', style: { x: 0.2, y: 0.8, fontSize: 100 } })
  assert.equal(p.texts[0].text, 'nuevo'); close(p.texts[0].style.x, 0.2); close(p.texts[0].style.y, 0.8)
  assert.equal(p.texts[0].style.color, DEFAULT_TEXT_STYLE.color)
})

ok('snap atrae al punto más cercano solo dentro del umbral', () => {
  assert.equal(snap(3.04, [0, 3, 10], 0.1), 3)
  assert.equal(snap(3.5, [0, 3, 10], 0.1), 3.5)
})

ok('fromPlan crea clips en orden con el texto durante todo el video', () => {
  const p = fromPlan([{ videoId: 1, start: 5, duration: 2 }, { videoId: 2, start: 0, duration: 3 }], 'hola', DEFAULT_TEXT_STYLE, false, 30, 'media')
  assert.equal(p.clips.length, 2); close(totalDuration(p), 5)
  assert.equal(p.clips[0].volume, 0)
  assert.equal(p.texts.length, 1); close(p.texts[0].duration, 5)
})

ok('normalize es idempotente', () => {
  let p = addText(base(), 3, 'a').project
  p = normalize(p)
  assert.deepEqual(normalize(p), p)
})

ok('setClip limita los valores de aspecto y clipLook devuelve los de fábrica', () => {
  let p = addClip(newProject(), 1, 10)
  const id = p.clips[0].id
  assert.deepEqual(clipLook(p.clips[0]), { fadeIn: 0, fadeOut: 0, bright: 0, contrast: 1, sat: 1, warmth: 0, scale: 1, rot: 0, flip: false, px: 0, py: 0, kScale: 1, kPx: 0, kPy: 0, animated: false })
  assert.equal(hasColor(p.clips[0]), false); assert.equal(hasFrame(p.clips[0]), false)
  p = setClip(p, id, { scale: 99, rot: 400, sat: -3, bright: 2, px: 5 })
  const l = clipLook(p.clips[0])
  assert.equal(l.scale, 4); assert.equal(l.rot, 180); assert.equal(l.sat, 0); assert.equal(l.bright, 0.5); assert.equal(l.px, 1)
  assert.ok(hasColor(p.clips[0])); assert.ok(hasFrame(p.clips[0]))
})

ok('los fundidos nunca pasan de la mitad del clip', () => {
  let p = addClip(newProject(), 1, 1) // dura 1 s
  p = setClip(p, p.clips[0].id, { fadeIn: 3, fadeOut: 3 })
  close(clipLook(p.clips[0]).fadeIn, 0.5); close(clipLook(p.clips[0]).fadeOut, 0.5)
})

ok('applyFilter ajusta los cuatro parámetros y none los restablece', () => {
  let p = addClip(newProject(), 1, 5)
  p = applyFilter(p, p.clips[0].id, 'bw')
  assert.equal(p.clips[0].filter, 'bw'); assert.equal(clipLook(p.clips[0]).sat, FILTERS.bw.sat)
  p = applyFilter(p, p.clips[0].id, 'none')
  assert.equal(hasColor(p.clips[0]), false)
  assert.equal(applyFilter(p, p.clips[0].id, 'inventado'), p)
})

ok('setTransition pone fundido a ambos lados de la unión y 0 lo quita', () => {
  let p = addClip(addClip(newProject(), 1, 4), 2, 4)
  p = setTransition(p, 0, 0.6)
  close(transitionAt(p, 0), 0.6); close(p.clips[0].fadeOut ?? 0, 0.6); close(p.clips[1].fadeIn ?? 0, 0.6)
  p = setTransition(p, 0, 0)
  assert.equal(transitionAt(p, 0), 0)
  assert.equal(setTransition(p, 1, 1), p) // no hay clip siguiente
})

ok('audios: se agregan con su duración, se mueven, se recortan y se quitan', () => {
  let p = addClip(newProject(), 1, 10)
  const r = addAudio(p, 'a.mp3', 'a', 'sfx', 8, 5) // solo caben 2 s
  p = r.project
  close(p.audios![0].start, 8); close(p.audios![0].duration, 2)
  p = moveAudio(p, r.selectId, 99); close(p.audios![0].start, 8)
  p = moveAudio(p, r.selectId, 1); close(p.audios![0].start, 1)
  p = setAudio(p, r.selectId, { duration: 1, fadeIn: 5, volume: 3 })
  close(p.audios![0].fadeIn, 0.5); assert.equal(p.audios![0].volume, 1)
  p = removeAudio(p, r.selectId); assert.equal(p.audios!.length, 0)
})

ok('normalize recorta los audios si el video se acorta y los quita si queda vacío', () => {
  let p = addClip(newProject(), 1, 10)
  p = addAudio(p, 'a.mp3', 'a', 'voice', 2).project // 2..10
  p = trimClip(p, p.clips[0].id, 'end', 5, 10)
  close(p.audios![0].duration, 3)
  p = removeClip(p, p.clips[0].id)
  assert.equal(p.audios!.length, 0)
})

ok('splitCaptions corta por palabras y por puntuación', () => {
  assert.deepEqual(splitCaptions('Hola mundo. Esto es una prueba de subtitulos largos para el video', 4), ['Hola mundo.', 'Esto es una prueba', 'de subtitulos largos para', 'el video'])
  assert.deepEqual(splitCaptions('  ', 4), [])
  assert.deepEqual(splitCaptions('uno', 4), ['uno'])
})

ok('captionsFromText reparte las frases sin huecos ni solapes dentro del rango', () => {
  const p = addClip(newProject(), 1, 10)
  const r = captionsFromText(p, 'Primera frase corta. Segunda frase un poco mas larga que la primera. Tercera.', DEFAULT_TEXT_STYLE, { from: 2, to: 8, maxWords: 4 })
  const ts = r.project.texts
  assert.ok(ts.length >= 3 && ts.length === r.ids.length)
  close(ts[0].start, 2)
  for (let i = 1; i < ts.length; i++) close(ts[i].start, ts[i - 1].start + ts[i - 1].duration)
  close(ts[ts.length - 1].start + ts[ts.length - 1].duration, 8)
  assert.ok(ts[1].duration > ts[0].duration * 0.5)
  assert.equal(captionsFromText(newProject(), 'hola', DEFAULT_TEXT_STYLE).ids.length, 0) // sin clips no hay dónde ponerlos
})

ok('applyMotion crea y quita animaciones de zoom/paneo y frameAt interpola', () => {
  let p = addClip(newProject(), 1, 10)
  const id = p.clips[0].id
  assert.equal(clipLook(p.clips[0]).animated, false)
  p = applyMotion(p, id, 'zoomIn')
  assert.equal(clipLook(p.clips[0]).animated, true); assert.ok(hasFrame(p.clips[0]))
  close(frameAt(p.clips[0], 0).scale, 1); close(frameAt(p.clips[0], 0.5).scale, 1.15); close(frameAt(p.clips[0], 1).scale, 1.3); close(frameAt(p.clips[0], 5).scale, 1.3)
  p = applyMotion(p, id, 'panLeft')
  close(frameAt(p.clips[0], 0).px, 0.1); close(frameAt(p.clips[0], 1).px, -0.1); close(frameAt(p.clips[0], 0.5).px, 0)
  p = applyMotion(p, id, 'none')
  assert.equal(clipLook(p.clips[0]).animated, false)
  p = setClip(p, id, { kScale: 3 })
  assert.equal(clipLook(p.clips[0]).animated, true); assert.equal(p.clips[0].kScale, 3)
})

ok('textAnim: entra con fundido y deslizamiento y sale igual; sin animación no cambia nada', () => {
  let p = addClip(newProject(), 1, 10)
  const r = addText(p, 2, 'hola'); p = r.project
  assert.deepEqual(textAnim(p.texts[0], 3), { alpha: 1, dx: 0, dy: 0 })
  p = setText(p, r.selectId, { anim: 'up', animDur: 0.5, duration: 4 })
  const t = p.texts[0]
  close(animLen(t), 0.5)
  let a = textAnim(t, 2); close(a.alpha, 0); close(a.dy, 120); close(a.dx, 0)
  a = textAnim(t, 2.25); close(a.alpha, 0.5); close(a.dy, 60)
  a = textAnim(t, 4); close(a.alpha, 1); close(a.dy, 0)
  a = textAnim(t, 5.75); close(a.alpha, 0.5); close(a.dy, -60)
  a = textAnim(t, 6); close(a.alpha, 0)
  p = setText(p, r.selectId, { anim: 'left' })
  close(textAnim(p.texts[0], 2).dx, 120)
  p = setText(p, r.selectId, { anim: 'fade', duration: 0.4 })
  close(animLen(p.texts[0]), 0.2) // nunca más de la mitad
})

ok('addSticker crea un emoji grande con animación de entrada', () => {
  const p = addClip(newProject(), 1, 10)
  const r = addSticker(p, 1, '🔥')
  const t = r.project.texts[0]
  assert.equal(t.text, '🔥'); assert.equal(t.anim, 'up'); assert.ok(t.style.fontSize >= 150); assert.equal(t.style.outline, false)
})

console.log(`\n${passed} pruebas del editor OK`)
