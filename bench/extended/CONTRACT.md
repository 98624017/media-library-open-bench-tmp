# One-shot batches 2 and 3

This directory contains independent synthetic investigations, not product code or routine CI.
The product checkout is read-only input. Do not publish source, customer data, private paths,
credentials, signed URLs, or paid API calls. Only generated fixtures and loopback traffic.

Node suites export `PROFILES` and `runBench({base, quick, sampleCount, emit})`.
`PROFILES` is a static array of `{scenario, variant, samples?: 1}`; an omitted samples value
means sampleCount. Return a small summary with calibration, limitations, and checks.
Each emitted row is `{suite, scenario, variant, sample, workload, metrics, checks, ...details}`.
Use `../platform/metrics.mjs` for timed rows. Correctness-only rows use metrics:null.
Checks contain booleans or bounded diagnostic observations; controls must assert correctness.
Call emit immediately after every complete row. Setup, output validation and cleanup remain
outside timing unless the profile explicitly names them as included. Rotate experimental
variant order between samples. Samples use the same workload and validate equivalent output.

Suite names: video, image-chain, journal-growth, ipc, network, lifecycle.
Workers own only their assigned module(s), test(s), and calibration notes. Parent owns
dependencies, common orchestration, workflow, report validation, README, and publication.
Do not edit ../platform, package.json/lockfile, workflows, or another worker's files.
Every external child command must have a timeout no longer than 295 seconds. Keep full suite
runtime comfortably below 295 seconds. Small quick fixtures are for local smoke, full
fixtures for runners. All roots must be unique mkdtemp directories; reclaim only owned roots.
No OS cache purge, system proxy change, security setting change, or dependency installation
by workers. Coordinate costly local benchmarks with the parent to avoid CPU contention.

Runner matrix: Windows Server 2022/2025 x64, macOS 15 ARM/Intel, Ubuntu 24.04 control.
Each suite runs in a fresh process and isolated Electron user-data where applicable.
Missing output, missing profiles, source drift, duplicate samples, or failed controls remain
partial evidence. Unsupported native facilities must be reported, not passed or certified.
The investigation does not certify physical devices, product UI, hardware encoding, sleep,
power loss, real NAS, system Keychain interactions, or complete product startup/install.
