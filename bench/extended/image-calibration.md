# Image-chain calibration

This is a one-shot synthetic native-library investigation. It never imports product
source and uses only generated raster/PSD files. All six scenarios run the same
jobs under serial execution, a bounded queue of two, and one fresh Worker per job.
There are 18 profiles and `18 * sampleCount` emitted timing rows.

## Inspected responsibilities

The product's image-orientation contract applies EXIF before crop, resize, output
encoding and layout. Editor composition orders source/brush, eraser, text, then
user rotation on the already composited image. Expanded rotation corners retain
alpha; JPEG flattening uses the selected white/black background.

Image batch export/collage currently processes sources serially. Image-text-edit
composition has an existing fresh-Worker entry with its own queue/timeout; it is
already offloaded in that path. Bounded image concurrency is an experiment here,
not a claim that the existing product always uses two jobs or still performs text
composition on Main. Actual product performance needs product runtime evidence.

Text edit removes trailing model-canvas padding, restores original dimensions,
extracts mask strength from alpha, mixes generated pixels using both mask and
generated alpha, and retains original alpha. Local patch composition uses a
Lanczos3 square resize, a raw smoothstep alpha mask, hard edges where the patch
touches image boundaries, and PNG intermediates.

PSD V2 receives and preserves an unchanged upstream PSD. Its editor readback uses
`readPsd` with composite/layer image data and thumbnails skipped. Local raster PSD
reconstruction/export is not the current V2 delivery path; it is a separate library
stress experiment. No legacy compatibility decision or product behavior is changed.

## Workload and assertions

| Scenario                  | Synthetic timed work                                                                                                                | Correctness outside timing                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `exif-crop-export`        | Eight JPEG EXIF inputs, rotate, crop, lossless PNG intermediate, white-flattened quality-95 MozJPEG                                 | All eight independent quadrant mappings, final dimensions and removed EXIF                                                 |
| `editor-alpha-rotation`   | Alpha PNG crop, SVG brush, hard eraser, generic sans-serif text, final 90/37-degree rotation, PNG plus both JPEG background encodes | Brush/erase/text ordering, retained alpha, transformed dimensions, transparent expansion corners, white/black JPEG corners |
| `local-crop-feather`      | Scene PNG normalization, non-square generated patch resized with Lanczos3, raw feather alpha encoding, `dest-in`, patch composite   | Original dimensions, center replacement, unchanged outside sample, mixed feather pixels and hard top/left boundary pixels  |
| `text-mask-restore-blend` | Mock model right-padding removal, original-size restoration/write, raw alpha mask, three image reads, JS pixel blend and PNG write  | Removed padding, full original alpha-byte equality, protected sample, generated opacity and intermediate feather samples   |
| `psd-metadata-read`       | File read plus metadata-only nested-layer PSD parse                                                                                 | Expected dimensions and nested layer names; no input writes                                                                |
| `psd-raster-roundtrip`    | File read, full raster PSD parse, lossless PSD rewrite and output write                                                             | PSD signature, nested metadata, every raster layer/composite pixel digest, including semi/fully transparent pixels         |

Full sources are 1536x1024 for editor/EXIF/patch work and 1280x1920 for the
protected blend; quick sources are 512x384 and 400x600. Raster PSDs are 640x480
with six layers in two groups (quick: 256x192, two layers). Full job counts are
8/4/4/2/2/2; quick job counts are 8/2/2/2/1/1. Each editor job intentionally
encodes both background choices. These sizes bound runtime and do not represent
the maximum product input limits or very large PSDs.

The timed PSD composite is opaque. Semi/fully transparent pixel claims in the
table apply to every raster layer; the supplied opaque composite is also checked
byte for byte. Separate transparent-composite observations are described below.

Fixtures use deterministic low-amplitude patterned quadrants, alpha bands and
constant generated patches. Setup verifies that each JPEG actually has the
requested EXIF tag. Input hashes must remain unchanged. Validation reads decoded
pixels, not only file headers; complete outputs must also have equal semantic
digests across every variant and sample on the same platform.

Preparation, validation and cleanup are excluded from timing. Variant order
rotates by sample. Worker timing includes thread startup, module/native-library
imports, a small path-based message, work and thread exit. Main imports happen
before the suite. This compares fresh per-job Worker overhead, not a prewarmed
pool. Jobs never send large buffers through Worker messages. Output writes are
included except for metadata-only readback; all output paths are owned unique
temporary directories and are reclaimed on success and failure.

The four ordinary raster scenarios load Sharp in each fresh Worker and do not
load ag-psd or initialize its Canvas hooks. PSD branches lazily import ag-psd and
initialize raw ImageData on first use; that first load is included for PSD Worker
profiles. Main's PSD fixture/observation preparation loads and initializes the
library before timed rows. The cold Worker dependency set therefore follows its
actual work, rather than charging normal image composition for an unrelated PSD
library. A fresh-process module-load regression verifies this separation.

## Memory and runtime meaning

Common `measure` RSS and CPU describe the entire process, including native Sharp
allocations and all Worker threads. RSS observed in a Worker is the same process
RSS and is not added or labeled as thread-only memory. Extra memory observations
separately record Main/Worker isolate `heapUsed`, `external` and `arrayBuffers`.
They are snapshots/sampled peaks, exclude native libvips allocations, and may miss
short transient allocations. Process lifetime RSS includes earlier profiles,
fixture creation and validation; it is not a fresh-process per-profile peak.

All runners use Sharp 0.34.5 and ag-psd 31.0.1. Windows disables Sharp caching to
match the product's file-handle strategy; other platforms retain default caching.
The Linux development Sharp 0.33.5 arrangement is unchanged and is not modeled by
this matrix. Native Sharp work already uses libvips threads; a JavaScript Worker
need not make codec throughput faster. Shared native caches/thread pools can also
influence repeated samples, so this investigation does not reset OS caches or
claim physically cold disks.

## Limits

The synthetic SVG uses the available default sans-serif and a hard rectangular
eraser. It does not certify real fonts, brush interpolation, radial eraser styles,
browser Canvas/Retina appearance, Photoshop or Photopea. Font differences may
change cross-platform glyphs; digest equality is required within a platform only.

The mask is rectangular and does not reproduce polygon-union geometry, concave
regions, bridges or every protected-pixel diagnostic counter. The encode profile
does not model the product's iterative target-byte/quality search, animated files,
AVIF/TIFF roundtrips or maximum-size payloads. Those are separate workload shapes.

PSD uses raw typed ImageData and supplies its composite explicitly; ag-psd does
not render/rebuild that composite from layers. No native Canvas, editable text,
font injection, Adobe interoperability or download/publication/IPC/root lifecycle
is certified. Real photographs, physical devices, paid providers and complete
product UI are outside this investigation.

The timed PSD fixture has an opaque supplied composite and transparent raster
layers. This keeps the byte-exact assertion valid for the chosen lossless workload:
ag-psd's 8-bit composite encoding adds/removes a white matte, so a semitransparent
composite is not byte-lossless even with raw ImageData. An independent 8x8 probe
observes up to one RGB level of change after initial serialization and two levels
on the subsequent rewrite, while composite alpha and every layer byte remain
unchanged. Its 2x2 counterpart also observes composite alpha corruption at the
very-small RLE boundary. Both probes run outside timing and are retained in suite
summary observations, rather than weakening pixel assertions or certifying those
facilities. The product's unchanged V2 download/metadata path does not perform
these raster rewrites. Each platform records its actual probe values.

The small logic tests cover feather alpha/hard boundaries, generated transparency,
preserved source alpha, immutability and invalid input rejection. The runner's
emitted rows provide the full native decode/encode/pixel controls. Unsupported
dependencies or failed controls fail the suite rather than produce success.
