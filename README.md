# media-library-open-bench

Temporary, synthetic benchmark. It measures how long it takes to open a listing of a
date-organised media library on different operating systems, and compares a validation-heavy
baseline traversal with a leaner candidate.

Everything here is generated test data: placeholder files, random records, no real content.
Results are uploaded as workflow artifacts and printed in each job summary.

```
npm install
node bench/run.mjs --quick
```
