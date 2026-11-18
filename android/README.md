# ClipForge para Android

Versión Android nativa (Kotlin + Jetpack Compose) de ClipForge. Crea videos verticales 9:16 (1080×1920) para TikTok, Reels y Shorts con fragmentos de tu propia biblioteca, texto centrado y exportación en el propio teléfono. **Todo el procesamiento es local**; la IA es opcional.

Requiere **Android 10 o superior** (API 29).

## Qué incluye

| Área | Estado |
|---|---|
| Biblioteca | Importar de la galería, de carpetas (selector del sistema: discos externos y carpetas de nube sincronizadas) y archivos sueltos. Miniaturas, duración, resolución, tamaño. Detección de duplicados por huella (tamaño + 3 bloques de 128 KB). Importación en segundo plano (4 a la vez) con progreso y cancelación. Verificación de archivos desconectados. |
| Crear | Texto, duración 10–60 s, modo automático o manual (nº de fragmentos, velocidad de cortes), 30/60 fps, calidad, audio original, música con volumen (en bucle si es corta), marca de agua propia, varias versiones. |
| Selección | Mismo planificador que escritorio (portado y probado): fragmentos repartidos por todo el video, sin solapes, evitando lo usado antes y entre versiones del mismo lote, con registro de combinaciones. |
| Texto | Editor con vista previa en vivo y plantillas. La vista previa, el reproductor y la exportación usan **el mismo dibujado**, así que lo que ves es lo que se exporta. |
| Editor de video | Línea de tiempo táctil: agrega videos, **divide**, **recorta arrastrando las asas**, reordena (mantén pulsado y arrastra), duplica y borra; **velocidad** y **volumen** por clip; **textos** con tiempo propio que se **arrastran sobre la vista previa** (con imán al centro); música; deshacer/rehacer; zoom; proyectos del editor con guardado automático. Se abre desde la pestaña **Editor** o con «Abrir en el editor» en la previsualización de un video creado. Mismas reglas que el editor de escritorio. |
| Previsualización | Reproductor con línea de tiempo global, ±1 s, saltar fragmentos; cambiar por otro al azar, elegir de la biblioteca, eliminar, agregar, reordenar y «Regenerar todo». |
| Exportación | Media3 Transformer: H.264 + AAC, 1080×1920, servicio en primer plano con notificación y cancelación, guardado en `Movies/ClipForge`, lotes de hasta 10 versiones. |
| Proyectos | Autoguardado y recuperación al reabrir. |
| IA (opcional) | Gemini, OpenRouter, Grok, Qwen y Claude: sugerir frases y priorizar videos con una hoja de 4 fotogramas. Claves cifradas con Android Keystore; nunca en el código. |
| Actualizaciones | Busca en los Releases de GitHub (`android-vX.Y.Z`), descarga, verifica el SHA-256 e invoca el instalador del sistema. |

## Compilar

Necesitas JDK 17+ y el SDK de Android (plataforma 34 y build-tools 34.0.0). Crea `android/local.properties` con `sdk.dir=RUTA_DEL_SDK` (o define `ANDROID_HOME`).

```bash
cd android
./gradlew assembleDebug          # APK de depuración  → app/build/outputs/apk/debug/
./gradlew assembleRelease        # APK firmado y minimizado → app/build/outputs/apk/release/
./gradlew testDebugUnitTest      # planificador, editor (modelo de línea de tiempo) y actualizador (JVM)
./gradlew connectedDebugAndroidTest   # pruebas reales en un emulador/teléfono conectado
```

Las pruebas instrumentadas incluyen la exportación del editor con colores sólidos: verifican que cada clip aparece donde toca, la duración con velocidades (2× y 0,5×), el volumen por clip medido en el audio decodificado, la música sobre un clip mudo y que un texto solo se ve entre su inicio y su fin, también al cruzar de un clip a otro. La prueba del generador genera la exportación con el motor real y comprueba con `MediaMetadataRetriever`/`MediaExtractor`: 1080×1920 (con la etiqueta de rotación habitual de las cámaras), duración exacta, pista H.264 y AAC, y que el **texto realmente se dibuja** en el centro del fotograma. También prueba la importación y la detección de duplicados.

## Firma (necesaria para las actualizaciones)

Android solo instala una actualización si el APK está firmado con **la misma clave** que el instalado. Por eso la clave debe ser siempre la misma y **no está en el repositorio** (`android/keystore/` está en `.gitignore`).

1. Genera una vez tu clave (si no la tienes):
   ```bash
   keytool -genkeypair -keystore android/keystore/clipforge.jks -alias clipforge -keyalg RSA -keysize 2048 -validity 10000
   ```
   y crea `android/keystore/signing.properties` con `storePassword=…`, `keyAlias=clipforge`, `keyPassword=…`. Gradle la usa solo para `assembleRelease` local.
2. **Guarda una copia de seguridad del `.jks` y de las contraseñas fuera del PC.** Si la pierdes, nadie podrá actualizar la app instalada: habría que desinstalar y reinstalar.
3. Para el CI, en GitHub → Settings → Secrets and variables → Actions crea:
   - `ANDROID_KEYSTORE_BASE64` — el `.jks` en base64 (`base64 -w0 android/keystore/clipforge.jks`)
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`clipforge`) y `ANDROID_KEY_PASSWORD`

## Publicar una versión

```bash
git tag android-v1.0.1 && git push origin android-v1.0.1
```

El workflow `.github/workflows/android.yml` compila el APK firmado, lo sube al release `android-v1.0.1` y la app lo detecta (Más → Configuración → Buscar actualizaciones, y automáticamente al abrir). El número de la etiqueta pasa a ser `versionName`; `versionCode` se deriva (`1.2.3` → `10203`), así que cada versión debe ser mayor que la anterior. Si faltan los secretos, el workflow falla a propósito en vez de publicar un APK que no podría actualizar.

La primera vez que se actualiza, Android pide permitir «Instalar apps desconocidas» a ClipForge.

## Limitaciones conocidas

- **Fotogramas por segundo:** Transformer limita a 30 fps (descarta fotogramas) pero **no interpola**: un video de 24 fps se queda en 24 fps, y «60 fps» conserva el ritmo nativo del original. Una mezcla de orígenes da un video de velocidad variable (reproduce bien en cualquier app).
- **Vertical:** Media3 1.4 codifica 1920×1080 con la etiqueta de rotación 90° (igual que las cámaras de los teléfonos). Se ve y se publica como 1080×1920; un reproductor que ignore la etiqueta lo mostraría girado.
- No hay detección de cambios de escena. En el editor, los textos no se pueden escalar con gestos (el tamaño se cambia en «Editar texto») y la línea de tiempo no tiene zoom con dos dedos (usa − / +).
- Sin importación por enlace URL (en Android se usan los archivos del teléfono).
- La actualización automática fuera de Google Play requiere el permiso de instalar apps desconocidas. Si publicas en Play Store, usa su sistema de actualizaciones.
- Pruebas hechas en un emulador Android 14 (x86_64). No se ha probado en teléfonos físicos ni con bibliotecas de miles de videos, ni la IA con claves reales, ni el flujo completo de actualización contra un release publicado.
