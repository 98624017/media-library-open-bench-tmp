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

Path observations compare stored raw paths with paths actually returned by `listTight`,
then use all three lookup variants and check whether the resulting cards receive
their record IDs. They cover a configured-root symlink, mixed-case directory spelling,
NFC/NFD Unicode names and macOS `/var`/`/private/var` and `/tmp`/`/private/tmp` aliases.
System aliases use separate system-temp fixtures, even when probing a disk-image root.
ASCII association and rejection of child file/directory symlinks are asserted controls.
Other observations deliberately record mismatches; they do not declare compatibility
or normalize historical data.

This harness mirrors traversal and association call patterns rather than executing
the application. It uses Node's `node:sqlite`; the application uses `better-sqlite3`.
The synthetic schema, placeholder media, runner resources, Sharp runtime and database
wrapper can affect absolute timings. Every large profile includes its actual file
count (PSD exports also count); exactly-two-file controls use no PSD projects.
`tight-warm` isolates in-memory index reuse, not navigation or thumbnail UI cache.

Image-library "cold" means a fresh Node process, not a cleared OS file cache. First
samples and later medians are both recorded; fixture creation already warms storage.
Mounted images share the runner's physical disk and do not reproduce an external
device. This run does not enable SMB/system Sharing and does not cover a real NAS,
iCloud eviction/sync, sandbox permissions, Electron packaging or macOS UI rendering.
