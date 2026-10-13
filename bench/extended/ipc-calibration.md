# Native IPC and image clipboard

The suite has eight profiles and three samples (24 rows). It runs in isolated Electron
39.8.3 with an actual context-isolated preload, ipcMain.handle/ipcRenderer.invoke, and
contextBridge return copying into the main renderer world. Its main path returns a PNG
as Base64, an owned ArrayBuffer, or a file URL. Renderer conversion, image.decode, drawing,
and four independent pixel samples define completion. The full generated RGB PNG sizes
are 1024x1024 and 2048x2048; quick sizes are 128x128 and 512x512. Four repeated requests
(quick: two) are included per measured row. Source generation and file writes are excluded.

Every representation must decode the expected dimensions and sampled source pixels.
Base64 includes per-request Main encoding, IPC/bridge string copying, a native data URL
and PNG decode. It does not add an unrelated JavaScript atob/byte-mapping conversion.
ArrayBuffer includes creation of an owned Main buffer, IPC/bridge copying
and decode. File URLs transfer a short descriptor and let Chromium read/decode the file.
Repeated file URLs may use Chromium's decoded-image/file caches. These are mechanisms,
not interchangeable authorization contracts; no product local-file access boundary changes.

The clipboard profile uses actual nativeImage/clipboard.writeImage/readImage/toPNG.
NativeImage creation is outside timing. The measured synchronous roundtrip records
writeImage, readImage and toPNG durations separately, so readback/encoding cost cannot
be mistaken for the cost of a product copy action that only writes the clipboard.
Every decoded RGB pixel must equal the source. An unavailable/empty native clipboard is
recorded explicitly as unsupported, not claimed as a passing clipboard certificate.
Common metrics observe Main responsiveness/CPU/RSS; they exclude renderer/native helper
process peaks. Post-operation renderer working-set observations are KiB, not precise peaks.
Renderer timings retain transport and decode/sample components. GPU is disabled for this
headless harness, so no product UI/input/Retina/GPU claim follows from these numbers.

The product currently has Base64 clipboard, ArrayBuffer clipboard, local path copy and
ArrayBuffer image-paste owners. This harness calibrates these transport and native image
primitives without copying handlers, public APIs, private file policies or application UI.
Windows Sharp fixture caching is disabled; Linux's special development version is unchanged.
