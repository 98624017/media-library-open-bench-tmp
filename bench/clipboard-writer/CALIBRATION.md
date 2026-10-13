# One-shot standard native image writer comparison

This generated-fixture experiment compares Electron 39.8.3 `clipboard.writeImage(image)`
against the documented standard `clipboard.write({ image })`. It contains no product
source, customer data or paid API calls. It adds no dependency or routine CI step.
The standalone Mac format helper only reads NSPasteboard after the write; it never writes.

The intentional branch is `native-clipboard-writer-probe`. Its dedicated workflow runs
macOS 15 ARM and Intel with seven fresh-process samples per writer per fixture. Windows
2025 and Ubuntu 24.04 are three-sample controls. Each sample launches a new Electron Main
with a unique user-data directory; variant launch order alternates between samples.
The five stages cover seeded opaque 2048/4096 RGB, transparent/semitransparent RGBA,
a local path with 1x/2x/3x PNG siblings and an explicit `@2x` path. Quick mode uses smaller
RGB inputs and cannot satisfy the full native acceptance gate.

NativeImage preparation is identical for both writers and outside timing. The measured
interval contains only the synchronous writer call; successful return is the completion
boundary. No readImage, toPNG, Sharp decode, helper, IPC roundtrip or memory sampler RPC
is included in writeMs. Input representations are retained, and preparation/readback
records decoded dimensions, every RGBA pixel digest, transparent/partial-alpha counts
and scale representations. The prepared 1x bitmap is the native readback oracle;
ordinary buffer inputs also compare it to all generated source pixels. Retina path
readback is compared to the existing prepared native bitmap without redefining density.
The ready metadata calls `getSize()`; Electron may materialize a default 1x representation
while describing an explicit `@2x` image. Both writers receive that same prepared state.
Retina results compare the writers after preparation, not an untouched path's end-to-end
copy latency. No pre-write `toPNG`/`toBitmap` conversion is added. Original source-scale
pixels and dimensions are checked after writing; inferred 1x uses the native bitmap oracle.

On Mac, NSPasteboard reports actual native types and attempts PNG and TIFF raw readback,
including types not enumerated by Electron's normalized `availableFormats` API. Every
declared image format must be readable. Prepared NativeImage output, API readback and
native PNG must reproduce source RGBA exactly. Ordinary native TIFF RGBA and its color/alpha
metadata must exactly match the current writer's TIFF for the same sample. A native
flavor absent from the baseline is recorded as absent rather than invented or replaced.
Both writers must expose equivalent types and decoded data. These controls do not certify
every application's paste implementation or ICC-profile input; there is no PNG-only writer.

The existing external Python memory sampler watches only the Electron Main PID from the
ready/write handshake through writer return, before readback begins. Its interval is
100 ms, plus immediate observations before/after. Reported peaks are observed lower
bounds; brief peaks may be missed. Startup, fixture preparation, Node coordinator,
renderer/GPU/helper processes and the OS clipboard server are excluded. Main's endpoint
RSS values are recorded separately; OS-reported lifetime high-water marks are not labeled
write-phase peaks. Mac pasteboard allocations cannot be inferred from Main RSS alone.

Each stage uses the existing external 285-second supervisor with bounded tree cleanup
(total at most 294 seconds); individual native runs have outside-process 45-second
deadlines plus a five-second process-group cleanup budget. Native POSIX groups register
with the existing supervisor before the write and stay registered until leaf cleanup,
so the supervisor can also drain them if the coordinator is interrupted. Windows failure
cleanup uses the same existing `taskkill /T /F` owner. Every workflow stage has a five-minute
deadline. Rows checkpoint preparation,
write completion and full validation; incomplete phases, missing stages, duplicate samples,
wrong revision/runtime, failed observers and compatibility differences reject completeness.
Only owned temporary fixture/user-data directories and synthetic clipboard contents are
cleared. A timeout retains partial evidence and cannot claim an already executed write
was undone. Reports preserve exact revision, probe file hashes and dependency/runtime
versions. Full-image temporary evidence is digested and removed after checking.

Run one bounded local control (Xvfb on Linux):

```bash
xvfb-run --auto-servernum node bench/clipboard-writer/launch.mjs --fixture=transparent --quick --samples=1 --label=local-smoke
```

Mac stages require the workflow's precompiled read-only `BENCH_MAC_CLIPBOARD_READER`.
The final summary requires all five full reports for one exact source SHA. The report
retains each writer's timing and observed-memory distribution, including min/median/max;
adoption requires reviewing both architectures' sample spread, stable improvement in
time or observed memory, and no material regression in the other metric. Overlapping or
indistinguishable results are a valid no-adoption outcome. No product change is made here.

Version-pinned sources:

- [Electron standard clipboard APIs](https://github.com/electron/electron/blob/v39.8.3/docs/api/clipboard.md)
- [Electron Write and WriteImage](https://github.com/electron/electron/blob/v39.8.3/shell/common/api/electron_api_clipboard.cc#L126)
- [Electron dependency versions](https://github.com/electron/electron/blob/v39.8.3/DEPS)
- [Chromium Mac bitmap writer and PNG/TIFF fallback](https://github.com/chromium/chromium/blob/142.0.7444.265/ui/base/clipboard/clipboard_mac.mm#L640)
- [Electron NativeImage path/scale loader](https://github.com/electron/electron/blob/v39.8.3/shell/common/skia_util.cc#L135)

Mac native-format diagnosis retains the ordinary strict source and API-readback controls.
Before their assertions, checkpoints contain PNG and TIFF declarations, ordinary decoded
RGBA, encoded digests, ICC/PNG color metadata, per-channel deltas, and bounded examples.
The separate `ignoredIccDiagnostic` decode only tests whether ICC interpretation explains
a delta; it is not an acceptance input or a replacement for ordinary color-managed decode.
Swift's bitmap metadata inspection remains read-only and outside the writer interval.

For a small diagnostic rerun, use `--quick --samples=1 --diagnostic-native-formats` with
`--fixture=rgb-2k` or `--fixture=transparent`. Mac stages then retain generated native PNG,
TIFF, prepared PNG and API-readback PNG under `diagnostics/native-formats/`, with their
lengths and SHA256 values in the checkpoint. Retention requires quick inputs at most 256px
per edge and bounds each encoded file to one MiB; full original-size fixtures are not
retained. A failing baseline stays partial and cannot establish candidate adoption.

The ARM/Intel raw diagnostic at revision `2c2e276d5105ee57f1c492ff3d7f665e029b75d4`
attributed the old baseline failure to TIFF's embedded 3144-byte `sRGB IEC61966-2.1` ICC
profile. Ordinary Sharp decoding added one red code value in 152 opaque or 75 RGBA pixels
of the small fixtures; all alpha bytes were unchanged. The same TIFF decoded with only
`ignoreIcc: true` matched the prepared RGBA. Native PNG and API readback already matched.
This test now compares ordinary TIFF pixels and ICC/native bitmap metadata to the same
format from the current writer, and records TIFF/source differences honestly. It retains
strict source/API/PNG/scale and alpha controls, without tolerances, normalization or profile
removal. Full RGBA digest and metadata equality reject candidate TIFF pixel/color/alpha drift.

The workflow is dispatched explicitly. `diagnostic=true` runs only quick RGB/alpha stages
with one sample and preserves bounded raw evidence; it skips the full-adoption summary.
`diagnostic=false` runs all five full-size stages and validates every expected report.

Native control messages use a nonce-authenticated ephemeral loopback TCP connection,
separate from startup stdout/stderr. Electron 39.8.3 replaces Windows `process.stdin`
with an always-EOF stream, so stdin cannot carry this disposable probe's handshake.
Terminal messages are flushed before process exit. This transport is outside writeMs
and adds no product IPC, server or dependency.
