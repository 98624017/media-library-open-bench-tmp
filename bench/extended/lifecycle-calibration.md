# CLI and Electron lifecycle primitives

There are six profiles and three samples (18 rows): cold synthetic readiness; in-process,
spawned Node and spawned native Rust fixture queries; second-instance handling; and
readiness after forced process termination. Each sample uses a new Unicode/space path
and isolated user data. The generic Rust helper is compiled outside timing into a Unicode
executable path using only std. Its actual compiler version and the Electron child runtime
are recorded. Full query rows perform four sequential queries (quick: one).

Cold readiness ends after Electron's ready callback, atomic discovery publication, and
a successful loopback state response. Query timing includes discovery file reading,
process spawn/exit when applicable, the complete bounded HTTP body and JSON parsing.
The Rust and Node helpers provide the same state; they do not implement the product CLI,
installation resolution, authentication, paid submission, persistence or public commands.

The duplicate profile launches the same Electron fixture with the same user-data root.
Its secondary must exit successfully, the original primary PID must remain serving, and
exactly one second-instance event must be observed. After killing that primary, the
restart profile must obtain a fresh PID and ready response under the same user data.
This verifies lock release/readiness primitives, not full task recovery or product startup.

The product's Rust CLI uses platform process launch primitives and an authenticated local
interface. This investigation exercises generic native executable paths, loopback calls
and Electron's real single-instance API without reproducing installation contracts.
Main Node CPU/RSS exclude Electron/Chromium/CLI subprocess work; wall time includes it.
GPU is disabled. Actual install/update, macOS open -a, sleep/wake, frontend windows and
unattended provider work require different evidence and are outside this matrix.
