# Long-lived framed journal recovery

This is a one-shot synthetic investigation. All records and bindings are generated; it does not
contain an application schema, source implementation, secrets, or customer data.

The full growth workloads have 1,000, 4,000, and 12,000 mutation frames. Quick workloads have
128, 512, and 1,536. Each cycles through 32 slots with updates, exact-binding deletion, and new
bindings. Both active state and the deletion map stay bounded by the slot count. The snapshot
cuts at 87.5% of the journal. Fixtures use UTF-8 payloads and byte-length/SHA-256 frames from the
existing synthetic persistence helper.

| Profile                   | Included work                                                                                                                | Output check                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| full-text-prefix-count    | Snapshot read, complete log read and parse, repeated UTF-8 prefix offset counting, checkpoint prefix validation, tail replay | Full final state digest and counts                                                               |
| full-text-linear-count    | Same work, with cumulative frame byte offsets                                                                                | Same complete state and checkpoint                                                               |
| stream-yield              | Snapshot read, streamed frame validation and replay, incremental checkpoint hashing, yields every 128 frames                 | Same complete state and checkpoint                                                               |
| existing-sync-before-ack  | Real groups of four mutations, append/file sync, and first-create directory sync                                             | Acknowledgements only after the shared append helper returns; complete frames and expected state |
| native-observation        | Actual directory sync and shared policy checkpoint                                                                           | Unsupported sync retains the byte-identical journal                                              |
| checkpoint-old-log-delete | Duplicate/conflicting IDs, torn tail, checkpoint plus old log, and forced termination after a new deletion ACK               | Valid state survives; damaged evidence remains incomplete                                        |

The prefix control models an observed whole-text offset-counting cost, without reproducing the
application parser. Its cumulative `offsetCountBytes` counts the bytes revisited for offsets;
linear and streaming candidates count each validated frame byte once. Each timed recovery runs
in a fresh Node child, so its memory observations do not inherit fixture-generation allocations.
Child startup, fixture generation, checks, and cleanup are outside timing.

Generated long logs are not written with per-frame fsync. They answer the recovery-cost question
when compaction is unavailable, rather than measuring real accumulated write throughput. Only
the separate small append profile performs the shared sync-before-ack operation. Native
directory sync remains an observation; no benchmark changes the compaction or durability policy.

The stream/yield candidate still validates all historical evidence and the exact checkpoint
prefix. Raw byte chunks retain RS boundaries and exact LF delimiters, including EOF fragments;
missing final LF, CRLF substitutions and split UTF-8 characters have regression checks. The
candidate offers no new compaction design and is not permission to truncate a journal, skip
fsync, bypass damaged evidence, or claim power-loss durability. Generic CAS and deletion omit
application ownership/admission, remote uniqueness, pruning, schema capacity, session suffixes,
late ACK recovery, and complete checkpoint-replacement semantics. Reopen after forced termination
only demonstrates process recovery. This is not a product UI or physical-device certification.
