# Synthetic video encoding and process lifecycle investigation

The `video` suite exports 14 profiles: ten timed rows for every sample and four one-time
process observations. Three samples produce 34 rows. All inputs are locally generated
`testsrc2` clips plus a sine tone; there is no customer media or network access.

## Product calibration

Reference policy is `reference-mp4-h264-24-v2`, read from the shared video-reference policy
and its compression/geometry owners. The control uses software H.264 (`libx264`), preset
`fast`, CRF 23, two encoder threads, 4 Mbps maximum rate and 8 Mbps buffer. The video is
converted to 24 fps CFR, square pixels and `yuv420p`. Scaling/padding uses the same 1280
maximum edge, 300 minimum height, 407696 minimum pixel count and rotation/SAR rules.
Retained audio becomes AAC at 96 kbps and 48 kHz. Selected duration is rounded down to an
integer video frame. Metadata is removed, rotation cleared, fast-start MP4 written, and
movie timescale is 24000. Every output remains below the real 20000000-byte cap.

Encoding controls cover H.264 with audio, HEVC without audio, and an H.264 clip with a real
90-degree MP4 display matrix. The first two source rates are 30 and 25 fps.
The rotated fixture uses FFmpeg's input `-display_rotation:v:0 90` override during stream
copy; `-metadata:s:v:0 rotate=90` did not write a display matrix with FFmpeg 7.0.2 and must
not be accepted as a valid fixture. Structured probing must still report rotation ±90.

Candidate `threads=4` changes only encoder thread count. A two-clip batch compares sequential
encoding with two concurrent children using two threads each. Candidate order is reversed
on alternate samples. Additional control recipes cover fractional selection with retained
audio and a rotated crop/selection with audio removed.

The suite resolves FFmpeg from `FFMPEG_PATH` or `ffmpeg-static`, and FFprobe from
`FFPROBE_PATH` or `@ffprobe-installer/ffprobe` (explicitly labelled PATH fallback if the
installer is unavailable). It records both actual binary version strings and path
origins. Fixtures use the same FFmpeg as encoding; no host FFmpeg substitution occurs.
FFprobe provides structured validation, unlike the product's FFmpeg text probe and separate
container-duration reader. Source codec, dimensions, actual source duration, audio, fps,
SAR and rotation are recorded so workload differences remain visible.

## Measurement and correctness

Timed rows include only encoding children and their spawn/close boundary. Input probe,
fixture creation, output probe, SSIM, full decode, hashing and cleanup are outside timing.
This isolates the encoding stage and does not claim end-to-end product compression latency.
Shared Node metrics measure coordinator responsiveness/CPU/RSS; FFmpeg native CPU and RSS
are excluded from those metrics. Wall time includes the FFmpeg work. A batch row includes
all its children. `nativeChildMemory` separately records real FFmpeg process RSS, successful
sample counts, per-PID peaks and missing observations (null, never fabricated zero).

A Python standard-library observer is started and warmed before the timed work, then
monitors only encoding children. Its target interval is 100 ms; OS queries add some cadence
and scheduler overhead. Linux reads `/proc/{pid}/status` VmRSS/VmHWM, macOS uses one batched
`ps` query for active PIDs, and Windows holds a GetProcessMemoryInfo handle for WorkingSet
and PeakWorkingSet. Same-tick sums give an approximate concurrent RSS peak; per-child peaks
are not added and presented as an observed concurrent maximum. Queries and IPC registration
introduce the same observation policy for every variant. Startup, row setup, final result
collection and shutdown are outside timing; small spawn/close hook and during-encode query
overhead remain. Short peaks can be missed, especially on macOS. CPU of native FFmpeg,
Python and ps is not included in coordinator CPU. FFprobe, fixture creation and quality
validation children are not watched. Every watch and the observer itself must finish.

Every output is checked for the reference codec, pixel format, frame rate, geometry,
square pixels, cleared rotation, MP4 container, audio presence/codec/sample rate, file size
and selected-duration boundary. SSIM compares output to a reference decoded from the same
source with the intended autorotation/crop/scale/fps recipe; 0.88 is a diagnostic floor for
these generated fixtures, not a real-footage quality promise. Full decoding checks both
video and retained audio. Input SHA-256 must remain unchanged. Equivalent output means
contract and reference image agreement; thread variants need not be bit-identical.

## Subprocess observations

The compression-timeout observation runs actual standalone FFmpeg, forces a bounded
timeout, waits for `close`, and confirms its PID no longer runs. The product's compression
helper uses direct `SIGKILL`; the suite does not add cancellation to that product helper.

A synthetic Node parent creates a non-detached Node leaf. The parent exposes its PID for
ownership before acknowledging leaf readiness over IPC. The leaf must finish startup and
registration and enter its idle loop before the parent-only termination observation begins.
Whether the leaf survives is a platform fact in `observation.descendantSurvived` and
`observation.counterexampleObserved`, not a universally required successful counterexample.
The retained profile name does not imply the counterexample occurred on every platform.

The first Windows Server 2022/2025 run observed the parent and leaf both exited after
parent-only kill. This matches [libuv 1.51.0's Windows job ownership](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c):
non-detached `uv_spawn` children are assigned to the Node parent's non-inheritable Job
Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The Node parent exiting may therefore
kill that direct leaf as well. This says nothing universal about grandchildren created
by Python or other external tools, detached children, or standalone FFmpeg.

Controls require real leaf readiness, the expected cancellation/timeout reason, parent
exit and verified harness cleanup. A surviving leaf is explicitly stopped before declaring
`ownedCleanupComplete`; an already-exited leaf is verified absent. Positive tree controls
still require the requested tree kill itself to stop the leaf, before fallback cleanup.

The tree cancellation and timeout controls use the downloader's native primitives:
detached process groups and negative-PID `SIGKILL` on Unix; `taskkill /T /F` on Windows.
Windows waits for taskkill itself to close before observing both PIDs. Any fallback to a
direct kill is recorded and descendant-exit checks still determine success. Zombie states
are treated as exited, not running children. All observed PIDs are created by the suite.
Every child command has a deadline of at most 90000 ms; lifetime observation windows are
bounded and owned descendants/root directories are reclaimed after the checks.
Process-tree probe roots are registered with the launcher's nonce-validated ownership
helper, including the detached parent-only counterexample. Their registry entries remain
until both parent and descendant have exited, so an outer suite deadline can reclaim the
known owned group. Failed registration terminates the group and fails the observation.
Probe parents register themselves again before creating a long-lived descendant. Windows
also independently registers the leaf before its idle loop, since an exited parent PID
alone cannot let taskkill find that surviving leaf. The caller retains both records until
cleanup finishes and arms cancellation only after leaf registration completes. Linux
`/proc` ENOENT/ESRCH races during process exit mean exited, not a
failed liveness proof; malformed or inaccessible process observations still fail.

## Limits

Quick sources are 854×480 and 1.25 seconds; full sources are 1280×720 and 3.25 seconds.
Short clips exercise the CRF encode, not the actual over-20-MB two-pass fallback. No
hardware encoding, VFR corpus, HDR/color management, real footage, download scheduling,
browser credentials, root migration, Electron UI, GPU, sleep or physical devices are
certified. Child process fixtures exercise native termination mechanics and do not run
the complete product downloader. Source/decoder version differences are disclosed in the
summary. No system cache purge or platform setting changes occur.

Run deterministic checks with `node --test bench/extended/video.test.mjs`. The common
runner imports `runBench` and immediately saves every emitted row; missing profiles or
failed control assertions must remain partial evidence.
