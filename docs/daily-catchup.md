# Daily start and hourly catch-up

The daily and hourly runs use the same cloud environment, private installation,
and date guard. A missed 07:20 run can therefore start at 08:20 or a later hourly
run. The guard derives the date from Asia/Shanghai and uses
`morning-YYYYMMDD-r1`. A previous day's completed or unresolved request stays
bound to that previous day.

## Installation and environment

Install this revision on the cloud environment used for research. Explicitly
select that environment for every run before entering its verified workspace;
a scheduler's inherited environment is insufficient. Verify two independent
execution sessions contend on the same `flock`, and verify that ending the
holder lets its successor acquire the lock with the original journal intact.

Initialize one new private root with a recorded UUID and first applicable date:

```text
python3 scripts/producer-day-guard.py init /private/daily-state GENERATION YYYY-MM-DD
```

Save the environment identity, root, generation, and installed revision in the
task configuration. The installation pins the original directory device/inode.
If that identity or directory is unavailable, reconcile the original environment
and journal before taking over. An empty replacement filesystem cannot prove
that an earlier cloud upload was unexecuted. Automatic cross-environment takeover
requires server-side ownership and downstream fencing; this guard implements
single-environment recovery.

## One execution session per date

At or after 07:20, start a persistent interactive execution session with
`tty:true`. Apply the original staging terminal settings before starting Python:

```text
stty -echo -echonl -icanon min 1 time 0
exec python3 scripts/producer-day-guard.py run /private/daily-state GENERATION ACTUAL_TRIGGER_REFERENCE
```

Keep this session open during research and initial staging. `guard_busy` means
the original executor still owns the lock. Follow that executor and its existing
record. `guard_acquired` returns the original date, request, research plan,
checkpoints, and stage intent. Resuming retains the original plan and consumed
budget. Record actual research consumption and evidence in the private audit and
with `{"action":"record","evidence":...}` checkpoints.

The guard also disables TTY echo itself while it is active. Native ticket
results can contain signed upload URLs; pass them directly to the matching
session's stdin and keep them out of commentary, command lines, and checkpoints.
The guard locks the original budget and preserves evidence; the research audit
and caller account for actual attempts and elapsed time.

The installed guard is selected on every run. While researching, the original
executor sends normal checkpoints or `{"action":"heartbeat"}` at intervals
under five minutes. Main input, native-result input, and staging output each have
a five-minute monotonic idle limit. A lost session therefore releases its own
lock after terminating any staging child, retaining the journal and original
budget. An active executor supplies its own heartbeat; a detached heartbeat
process would defeat recovery. Kernel lock release permits acquiring the original
journal, not repeating an uncertain external operation. The lock file's existence
is not a running-process test.

## Discover the date before research

Use the authenticated native Slack sender and original private control channel:

```text
!ai-report day YYYY-MM-DD QUERY_UUID
```

Read the original Publisher's `!ai-report day-receipt` reply in that exact thread.
Verify its identity, `query_id`, `source_ts`, date, and freshness. This query needs
no bundle hash. It reports complete durable intake coverage, all admitted jobs
for the date (including noncanonical IDs), staged bundles, pending stage/submit
commands, unresolved intake, and the scheduler's original claim/status. A
scheduler conflict, incomplete scan, malformed record, or unavailable query fails
explicitly and never becomes an empty receipt. The old hash-bound `inspect`
contract remains unchanged.

Pass the verified JSON receipt to the guard:

```json
{"action":"snapshot","receipt":{}}
```

The empty object above is a placeholder for the full real receipt. `occupied`
and `pending` continue the original bindings. `empty` is a point-in-time snapshot;
the held cloud lock provides exclusion among daily/hourly researchers. Also check
the actual report index, original private research files, and prior native write
results. Missing logs alone do not establish absence. The guard applies to dates
at or after its recorded activation, after reconciling earlier producer entry
points during installation.

Start new research, or resume the identical recorded plan:

```json
{"action":"begin","research":{"prompt_commit_sha":"FULL_SHA","budget":{"max_attempts":3,"seconds":1200},"audit_directory":"/private/actual-audit"}}
```

The budget above is illustrative: supply the actual budget declared under the
pinned research policy before work. Repeated `begin` retains the exact original
budget, version, and audit directory. A restored run uses the remaining allowance
and the existing evidence. The original report's content/audit rules still govern
publication, including verified partial coverage when permitted.

## Initial staging and recovery

Refresh the real day receipt immediately before initial staging (maximum age
60 seconds) and feed it through `snapshot`. Then use the same held guard:

```json
{"action":"stage","bundle":"/private/ai-brief-bundle.json","sha256":"EXACT_HASH","channel":"CPINNED"}
```

The guard preserves exact bundle bytes and fsyncs a stage intent before starting
the existing `slack-stage-cli.mjs`. It forwards that bridge's one-shot native
`write` requests and accepts the matching `native_result` JSON on stdin. Every
native write intent is durable before exposing the request. Upload URLs and
native result bodies are excluded from the journal. The staging child inherits
the lock so a parent-process exit does not release an active child's exclusion.

After a crash or uncertain result, the original intent and bytes remain.
If the live parent observes a local child exit before forwarding any native
write, it records `not_started`; that same original bundle can resume after
fresh inspection. A parent crash or any forwarded native write retains the
uncertain binding until reconciliation.
Inspect the original Slack file/message and Publisher binding; resume the
existing stage/submit/status protocol. Once Publisher confirms the original
staged bytes, its explicit submit admits that original package. Subsequent
publication and delivery continue through the existing durable T4 workflow.
The cloud guard never publishes, submits, or sends a report on its own.

Finish this execution session with `{"action":"release"}`. Each date has its
own lock and journal. Finishing a date closes that run; later dates follow their
own normal daily authorization and stable request ID.
