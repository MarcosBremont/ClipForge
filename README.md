# ClipForge — Editor automático de videos virales verticales

Aplicación de escritorio para **Windows 10/11 y macOS** que crea videos 9:16 (1080×1920) para TikTok, Reels y Shorts a partir de tu propia biblioteca de videos: eliges una carpeta, escribes una frase o pregunta, y la app selecciona fragmentos variados, los une con cortes rápidos, centra tu texto y exporta un MP4 listo para publicar.

**Todo el procesamiento es local** (FFmpeg + SQLite). La IA es opcional y nunca se necesita para editar.

> **Android:** hay una versión nativa para Android en la carpeta [android/](android/) (Kotlin + Jetpack Compose + Media3). Ver [android/README.md](android/README.md).

## Qué hace

| Área | Funciones |
|---|---|
| Biblioteca | Importar carpetas (recursivo), archivos sueltos, arrastrar y soltar, discos externos, carpetas de Drive/Dropbox/OneDrive sincronizadas y enlaces directos a archivos de video. Miniaturas, duración, resolución, formato, tamaño. Detección de duplicados (huella rápida por contenido). Verificación de archivos desconectados. Biblioteca persistente entre sesiones. Importación en segundo plano con progreso y cancelación. |
| Crear video | Texto, duración (10–60 s), modo automático o manual (nº de fragmentos, duración de cada uno, velocidad de cortes), 30/60 fps, calidad, audio original on/off, música de fondo, marca de agua propia, varias versiones. |
| Selección | Elige videos distintos, fragmentos repartidos por **todo** el video (no solo el inicio), sin solapes, evitando lo ya usado en proyectos anteriores y en el mismo lote. Opcional: ajuste a cambios de escena (detección local con FFmpeg) y priorización por puntuaciones de IA. |
| Previsualización | Reproductor con línea de tiempo, play/pausa, ±1 s, saltar fragmentos, ver cada fragmento, cambiar por otro (aleatorio o elegido de la biblioteca), eliminar, agregar, reordenar, «Volver a generar selección». |
| Texto | Editor en tiempo real: tipografía, tamaño, grosor, color, posición, alineación, sombra, contorno, mayúsculas, tiempo de aparición. Plantillas guardables. La vista previa y la exportación usan el mismo dibujado, así que lo que ves es lo que se exporta. |
| Lotes | N versiones distintas por proyecto. Registro de combinaciones para no repetir. |
| Exportación | MP4, H.264 + AAC, 1080×1920, 30/60 fps, calidad configurable, carpeta de salida elegible, barra de progreso, cancelación, aceleración por hardware opcional (NVENC/QSV/AMF/VideoToolbox) con reintento automático por CPU. |
| IA (opcional) | Gemini, OpenRouter, Grok, Qwen y Claude. Sugerir frases y valorar videos. Claves cifradas con DPAPI (Windows) / Keychain (macOS). |
| Robustez | Guardado automático de proyectos y recuperación tras cerrar, procesos en segundo plano, errores mostrados con mensajes claros, escritura atómica de los MP4 (no quedan archivos a medias). |

> La app **no añade marcas de agua de otras plataformas**. Solo se dibuja la que tú escribas.

## Requisitos

- **Node.js 20 o superior** (probado con 24) y npm.
- No necesitas instalar FFmpeg: se incluye mediante `ffmpeg-static` y `ffprobe-static`.

## Instalar y ejecutar en desarrollo

```bash
npm install
npm run dev
```

> En npm 12 los scripts de instalación están bloqueados por defecto. El proyecto ya aprueba `ffmpeg-static` (campo `allowScripts` de `package.json`), que necesita descargar su binario. Si Electron no se descargó: `node node_modules/electron/install.js`.

> Si lanzas Electron desde un terminal de VS Code y la ventana no abre, desactiva `ELECTRON_RUN_AS_NODE` en esa sesión.

## Compilar instaladores

```bash
npm run dist:win     # instalador NSIS .exe  → carpeta release/   (ejecutar en Windows)
npm run dist:mac     # .dmg x64 y arm64      → carpeta release/   (ejecutar en macOS)
npm run pack         # solo carpeta desempaquetada, para probar rápido
```

**Importante:** `ffmpeg-static` descarga el binario de FFmpeg del sistema donde haces `npm install`. Por eso el instalador de macOS debe generarse **en un Mac** y el de Windows **en Windows**. El workflow [.github/workflows/build.yml](.github/workflows/build.yml) lo hace automáticamente en GitHub Actions (un runner por sistema) y publica los instaladores como artefactos.

Los instaladores no están firmados. En Windows, SmartScreen mostrará un aviso la primera vez. En macOS, sin firma ni notarización Gatekeeper pedirá abrir con clic derecho → *Abrir* (o configurar `CSC_LINK`/`APPLE_ID`… para firmar). Para añadir un icono, coloca `build/icon.ico` (Windows) y `build/icon.icns` (macOS).

## Actualizaciones automáticas (GitHub Releases)

La app se actualiza sola con `electron-updater`. **No hace falta GitHub Pages**: las versiones se publican como *Releases* de un repositorio **público** de GitHub. Al abrir, la app busca actualizaciones (y desde Configuración → Actualizaciones puedes buscar a mano); si hay una nueva, la descarga (verificando su sha512) y la instala al reiniciar. Los proyectos y la biblioteca se conservan.

### Configuración inicial (una sola vez)
1. Crea un repositorio público en GitHub y sube este proyecto.
2. En `package.json`, dentro de `build.publish`, cambia `owner` por tu usuario (y `repo` si usas otro nombre).
3. (Opcional, para publicar desde tu PC) crea un token en GitHub → Settings → Developer settings → Personal access tokens con permiso `repo` y defínelo: `setx GH_TOKEN "tu_token"` (reabre la terminal).

### Publicar una versión nueva
1. Sube el número en `package.json` (`"version": "1.0.1"`). **Debe ser mayor que el instalado**.
2. Publica, con cualquiera de estas dos vías:
   - **Automática (recomendada, Windows y macOS):** `git tag v1.0.1 && git push --tags`. El workflow compila los instaladores y los sube al release junto a `latest.yml`.
   - **Desde tu PC (solo Windows):** `npm run release:win` (necesita `GH_TOKEN`). Crea el release como borrador si no existe: entra en GitHub → Releases y pulsa **Publish release**. Mientras sea borrador la app no lo ve.
3. Los usuarios con la app abierta verán «Actualización 1.0.1» en el menú lateral.

Notas: la primera versión que instalen los usuarios ya debe incluir esta función. En macOS la actualización automática exige que la app esté **firmada y notarizada** (Apple Developer); sin eso, macOS no podrá autoinstalar y habrá que reinstalar el `.dmg` a mano. En Windows funciona sin firma (con el aviso de SmartScreen).

Prueba local del flujo sin GitHub: `npm run dist:win && node tests/update-e2e.mjs --packed` (simula un release 9.9.9 con un servidor local).

## Pruebas

```bash
npm run typecheck
npm test          # motor: planificador + render real con FFmpeg (16 pruebas)
npm run build && npm run test:e2e   # app completa en Electron (17 comprobaciones)
```

La prueba e2e genera videos de muestra, importa una carpeta anidada, comprueba duplicados, previsualiza, exporta 3 versiones, verifica con ffprobe (1080×1920, H.264, AAC, duración exacta), guarda/recupera un proyecto y toma capturas de la interfaz.

## Arquitectura

```
src/
  main/        Proceso principal de Electron (Node)
    index.ts     ventana, protocolo media://, IPC, orquestación de lotes
    db.ts        SQLite (node:sqlite integrado, sin módulos nativos)
    library.ts   importación recursiva, huella de duplicados, descarga de enlaces
    ffmpeg.ts    rutas de ffmpeg/ffprobe, sondeo, miniaturas, detección de escenas
    render.ts    construcción del filtergraph y exportación (+ proxies de previsualización)
    ai.ts        proveedores de IA (Gemini, OpenRouter, Grok, Qwen, Claude) y claves cifradas
    jobs.ts      tareas en segundo plano, progreso y cancelación
    e2e.ts       prueba de integración (solo con CLIPFORGE_E2E)
  shared/      Código común
    planner.ts   selección de fragmentos (pura y probada)
    types.ts     tipos y valores por defecto
  preload/     Puente seguro (contextIsolation) entre interfaz y proceso principal
  renderer/    Interfaz React + TypeScript + Zustand
tests/         Pruebas del motor y e2e
```

**Cómo se genera un video:** `planner.ts` decide fragmentos (video, inicio, duración). La interfaz dibuja el texto en un PNG transparente de 1080×1920 con un canvas. `render.ts` lanza **una sola** llamada a FFmpeg: cada fragmento se busca con `-ss`, se escala/recorta a 1080×1920, se concatena, se superpone el PNG (y la marca de agua), se mezcla audio original/música y se codifica a H.264 + AAC. Los datos se guardan en SQLite (`clipforge.db` en la carpeta de datos del usuario: `%APPDATA%/ClipForge` o `~/Library/Application Support/ClipForge`).

**Memoria y almacenamiento:** los videos no se copian ni se cargan en memoria; solo se guardan miniaturas (~20 KB cada una) y los proxies de vista previa se crean bajo demanda solo para formatos que Chromium no reproduce (MKV, AVI, HEVC…). La importación usa un máximo de 4 tareas simultáneas y huellas de 3 bloques de 128 KB, por lo que miles de videos no bloquean la interfaz.

## Notas sobre la IA

- Se configura en **Inteligencia artificial**: clave, modelo y proveedor activo. «Probar conexión» valida la clave.
- Los identificadores de modelo por defecto (`gemini-2.5-flash`, `grok-4`, `qwen-vl-plus`, `claude-sonnet-5-5`…) pueden quedar desfasados; cámbialos en el campo *Modelo*.
- Para valorar videos se envía **solo una hoja de 4 miniaturas por video**, nunca el archivo. Las solicitudes pueden tener coste según tu proveedor.
- Sin IA configurada todo lo demás funciona igual.

## Limitaciones conocidas

- Los enlaces pegados deben ser **enlaces directos a un archivo de video** (`.mp4`, etc.). Páginas de TikTok/YouTube/Drive no son descargables de forma fiable y no se admiten.
- La detección de escenas por IA/visual avanzada se limita a la valoración por miniaturas; la detección de cambios de escena es local y básica (umbral fijo).
- No hay transiciones: solo cortes directos (como pide el estilo de referencia).
- Los instaladores no están firmados (ver arriba).
