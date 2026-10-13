# media-library-open-bench

Temporary, synthetic benchmark for opening a date-organised media library on different
operating systems. It compares the previous validation-heavy traversal (`baseline`),
the implemented traversal with its in-memory history lookup (`tight`), and the same
lookup reused without a write (`tight-warm`). `candidate`/`lean` use a hypothetical
SQLite path table and lighter validation; they are experiments, not the implemented fix.

Everything is generated test data: placeholder files, synthetic records and images,
no product source, product names, customer data or secrets. JSON and Markdown results
are uploaded as workflow artifacts and printed in each job summary.

Use Node 22 and the locked dependencies:

```bash
npm ci --no-audit --no-fund
node bench/run.mjs --quick --label=local-smoke
node bench/run.mjs --only=paths --label=local-paths
node bench/run.mjs --label=local-full
```

`--only=micro,listing,profiles,records,thumbs,paths` selects measurements.
`BENCH_ROOTS='local=/path/one;apfs-sensitive=/path/two;hfs=/path/three'` selects storage
roots. Only `local` receives the full large-library grid; other roots use the smaller
secondary grid. Each fixture is created in an owned temporary directory and removed.

The macOS workflow runs on standard public runners `macos-14`, `macos-15`, `macos-26`
(arm64), `macos-15-intel` (x64) and `ubuntu-24.04` (x64 control). It verifies actual
architecture and records OS/kernel, Node, SQLite and Sharp versions. On macOS it also
mounts a 3 GiB sparse **case-sensitive APFS** image (`apfs-sensitive`) and an **HFS+**
image (`hfs`), in addition to runner storage (`local`). Disk metadata and `sw_vers`
are separate artifacts. Image creation failure fails the job rather than removing
a filesystem from the comparison. Images are detached and removed on job completion.

Push branch `mac-open-bench` to trigger the workflow. Once GitHub has registered the
workflow for manual dispatch, these commands can start or fetch a run:

```bash
gh workflow run mac-bench.yml --ref mac-open-bench
gh run list --workflow mac-bench.yml --branch mac-open-bench
gh run download RUN_ID --dir /path/to/new-empty-evidence-directory
```

Artifacts have a 30-day retention period. Each step has a five-minute limit; the
benchmark subprocess has a 295-second limit and uploads partial saved data on failure.

Push `mac-open-followup` to run the targeted `mac-followup.yml` workflow. It fills
the missing sections from the initial aggregate timeout without repeating completed
scans: macOS 26 arm64 runs local history lookup and thumbnails; macOS 15 Intel runs
APFS profiles, HFS discovery/profiles, then local history lookup and thumbnails.
macOS 15 arm64 repeats thumbnails twice on a fresh runner, giving eight fresh-process
Sharp loads. Each independent section has its own 295-second limit and unique output
label; later sections still run if an unrelated measurement fails. The workflow
checks `completed: true` and the requested rows before accepting each output. The
underlying benchmark scripts are unchanged from the first sweep.

Archived measurements are in [evidence/2026-10-13-macos.json](evidence/2026-10-13-macos.json)
on branch `mac-evidence`. They retain runtime/storage metadata, sample counts, measured
baseline/implemented/reused-index timings and path-association observations. The archive
combines completed sections of run `38332093362` with the passing follow-up `38333013967`;
the initial run itself failed when two aggregate commands reached the time limit. All
requested sections are complete in the combined archive. Full synthetic paths and the
hypothetical lighter-validation/schema-index variants remain in the original artifacts.

Path observations compare stored raw paths with paths actually returned by `listTight`,
then use all three lookup variants and check whether the resulting cards receive
their record IDs. They cover a configured-root symlink, mixed-case directory spelling,
NFC/NFD Unicode names and macOS `/var`/`/private/var` and `/tmp`/`/private/tmp` aliases.
System aliases use separate system-temp fixtures, even when probing a disk-image root.
ASCII association and rejection of child file/directory symlinks are asserted controls.
Other observations deliberately record mismatches; they do not declare compatibility
or normalize historical data.

This harness mirrors traversal and association call patterns rather than executing
the application. It uses Node's `node:sqlite`, as do the currently inspected application services.
The synthetic schema, placeholder media, runner resources, Sharp runtime and database
wrapper can affect absolute timings. Every large profile includes its actual file
count (PSD exports also count); exactly-two-file controls use no PSD projects.
`tight-warm` isolates in-memory index reuse, not navigation or thumbnail UI cache.

Image-library "cold" means a fresh Node process, not a cleared OS file cache. First
samples and later medians are both recorded; fixture creation already warms storage.
Mounted images share the runner's physical disk and do not reproduce an external
device. This run does not enable SMB/system Sharing and does not cover a real NAS,
iCloud eviction/sync, sandbox permissions, Electron packaging or macOS UI rendering.

## One-shot platform investigation

Branch `platform-deep-bench` runs a separate, disposable investigation on Windows Server
2022/2025 x64, macOS 15 ARM64/Intel, and Ubuntu 24.04. It is not part of an application
development, test, packaging or release workflow. Every benchmark command is capped at
295 seconds and checkpoints each completed row.

```bash
npm ci --no-audit --no-fund
npm run test:platform
node bench/platform/launch.mjs --suite=file-io --quick --label=smoke
node bench/platform/launch.mjs --suite=persistence --quick --label=smoke
node bench/platform/launch.mjs --suite=images --quick --cache=disabled --label=smoke
node bench/platform/launch.mjs --suite=images --quick --cache=default --label=smoke
node bench/platform/launch.mjs --suite=images --quick --cache=fileless --label=smoke
node bench/platform/summarize.mjs results
```

File I/O compares synchronous saves/import copies and migration copy/size checks with
hypothetical asynchronous equivalents. It does not include image decode, database
insertion, path rewriting or the root-switch transaction. Persistence covers the native
SQLite defaults, atomic synced snapshots, synced journals, policy-gated compaction,
open-file replacement and deterministic process-kill checkpoints. Grouped journal
writes already exist in the application; the synthetic comparison measures batching
cost, not a missing feature. Killing a process does not certify sudden power loss.

Images use Sharp 0.34.5 in fresh Node processes, generated JPEG/PNG/WebP/AVIF/TIFF files,
the 120-pixel asset thumbnail and 400-pixel preview policies, and concurrency two.
These are RGB fixtures; this sweep does not certify EXIF rotation, transparency or
the complete compositing chain. Actual encoded input dimensions are recorded per format.
Cache policies are `disabled`, `default` and `fileless` (50 MiB, zero file slots,
100 operation items). Validation is outside timing; cache is reset between samples,
so repeated-path hits happen within each measured operation. Separate files can have
identical generated bytes. Fixture creation warms storage. Linux's special development
Sharp version is unchanged and is not substituted by this Node control.

On Windows/macOS, a standalone Electron 39.8.3 harness additionally tests native rename,
unlink, trash, overwrite and replacement after warming Sharp's operation cache. It
checks new bytes after in-place writes and replacements. A failing candidate policy is
an observation; the cache-disabled control must pass. This is not the product UI or a
packaged application. The workflow adds small Windows loopback SMB I/O probes and Mac
HFS+ mounted-image probes, with disk/protection metadata. These do not model a real NAS
or external drive. Protection settings are observed, not changed.

Wall time, process CPU, event-loop stalls and sampled RSS are recorded. The heartbeat
checks that an immediate synchronous stall is visible; it does not include arbitrary
idle time. Sampled RSS can miss brief peaks; process lifetime high-water is cumulative.
All files, databases and crash targets are generated under owned temporary roots.

The complete one-shot measurements are archived in
[evidence/2026-10-13-platform.json](evidence/2026-10-13-platform.json) on branch
`platform-deep-evidence`, from [run 38340081834](https://github.com/98624017/media-library-open-bench-tmp/actions/runs/38340081834)
at benchmark candidate `8aa54bff521a9cd6764e3ea8ba2909dadcd20dde`. All five jobs
passed evidence validation: 43 reports, 1,146 timing samples and 51 additional
correctness observations. The archive branch does not trigger this workflow.

Default and fileless caching failed native trash and in-place overwrite on both
Windows runners, with little timing benefit; disabled controls passed. All native
cache actions passed on both Mac targets. Asynchronous file I/O substantially
reduced long event-loop gaps, without consistently reducing total time. Native
directory sync was unsupported on Windows, so the mirrored safety policy retained
the journal. Windows real-time antivirus protection was disabled in the runner's
observed default state; the investigation did not modify it.
Workflow summaries require all 5 Linux, 9 Windows or 10 Mac reports, including the
extra-volume probes. Missing reports and failed disabled-cache controls remain partial;
observed failures of candidate cache policies do not invalidate the control measurements.
