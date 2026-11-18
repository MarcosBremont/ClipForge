// Pruebas del modelo del editor (línea de tiempo). Ejecutar: npm test
import assert from 'node:assert/strict'
import {
  addClip, addText, clipDur, clipStarts, duplicateClip, duplicateText, fromPlan, locate, moveClip, moveText, newProject, normalize,
  removeClip, removeText, resizeText, setClip, setText, snap, splitAt, textsAt, totalDuration, trimClip, MIN_CLIP
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

console.log(`\n${passed} pruebas del editor OK`)
