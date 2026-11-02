# Publisher-owned native journal protocol

The existing private `!ai-notice submit` lane now accepts a bounded remote journal
protocol. The Publisher authenticates the same channel, user/app attribution and
command file as ordinary notice commands. No new credential, listener or public
endpoint is introduced. The journal is stored in the Publisher's existing private
SQLite database, alongside the original report bundle. Bundle bytes are reused,
not uploaded again or reconstructed from a receipt.

This is an opt-in **post-reservation protocol**. `journal_open` requires an already
published `native_bundle_v1` reservation still in `reserved`. It binds the original
report, bundle hash, publication commit, edition, scope, attempt, file, destination,
text and poster hashes. It refuses an existing completion intent or explicit
recovery authorization. It cannot import an old cloud SQLite journal or recover a
lost upload ticket. Existing scheduled hosts do not switch to it automatically.

## Commands and atomicity

All commands carry the ordinary notice envelope plus `attempt_id` and `file_id`.
Unknown fields/actions fail closed. `journal_read` takes no revision; mutations
carry `expected_revision`. The server processes commands inside the existing
`BEGIN IMMEDIATE`, persisting the ledger transition and its control response in
the same transaction. Stale revisions return a conflict with the current snapshot.

| Command | Additional fields | Effect |
| --- | --- | --- |
| `journal_open` | `expected_revision: 0` | Bind a new eligible reservation, or read the existing binding. |
| `journal_read` | None | Read the original snapshot. |
| `journal_intent` | `expected_revision`, `executor_id`, `operation`, `input_sha256` | Allocate one immutable intent for `begin`, `final_complete` or `record`, in that order. |
| `journal_settle` | `expected_revision`, `executor_id`, `operation`, `outcome`, `evidence_command_id` | Record uncertainty, or reconcile from existing Publisher evidence. |
| `journal_defer` | `expected_revision`, `next_attempt_at`, `reason` | Persist backoff and increment the deferral counter without an age/count expiry. |

`outcome` is `unknown` from the original executor with null evidence, or `acknowledged` with a real existing
control command ID. Begin/record acknowledgements must match the exact original
command bytes. Final completion requires a successful existing `check` receipt
for the original file and bundle. A client-provided success assertion is never
evidence. The ledger stores only bounded identifiers and evidence hashes, not
credentials, upload URLs or arbitrary client result blobs.

Unresolved operations block later intents. Unknown writes only reconcile; their
control operation cannot be submitted again to obtain a new grant. A final
completion intent also requires the executor that allocated begin. A restarted
executor cannot inherit the old completion window. Final input bytes are bound
to the original file, destination and manifest comment. Ordinary publication,
due-time and fresh completion-grant checks remain required by the native sender.

Every journal response has `send_authorized: false`. `new_intent` acknowledges a
ledger allocation only. `NativeRemoteJournal` validates the actual filtered native
Slack receipt and permits one callback only for its own live, unconsumed intent
command. Replayed receipts and new client instances cannot invoke that callback.
It does not replace `nativeCompletionArguments` or authorize a final DM itself.

## Lost replies and restarts

An uncertain control response is never resent. The Publisher reads its original
thread to reconcile it. For opted-in journal runs, an unavailable read leaves the
response pending instead of stopping the service. Fresh authenticated snapshot
and reconciliation commands can progress while old responses remain unresolved.
Their snapshots cannot recreate a fresh send permission.

On a new execution slice, issue a new read request for the fixed report/bundle and
original reservation identity. Resume from the authoritative snapshot. Existing
intents are reconciliation-only even when no success receipt was observed.
Before begin, a new executor can allocate the first intent after backoff expires;
after begin, the completion owner cannot be replaced. Deferral advances an expired
wakeup to at least 15 seconds in the future and cannot shorten existing backoff.
No retry count or total lifetime cutoff is applied.
Journal commands retain their audit rows without consuming the ordinary notice
command quota. Persistent storage must accommodate that growing audit; no reset
or implicit pruning of operation evidence is performed.

State inspection/migration recognizes the exact schema and immutable triggers.
Unresolved journal state prevents deployment cutover or readiness migration;
completed audit rows are preserved. This does not relax existing notice, recovery
or unknown control-write migration gates.

## Cloud runtime and scheduler activation

`remote-native-cli.mjs` and `remote-native-dispatch.mjs` implement an ephemeral
cloud execution slice. The dispatcher calls only the existing native upload,
completion and search tools, plus read-thread and read-file for the original
report bundle. It forwards actual tool results, including structured file data;
it never invents an acknowledgement or retries an ambiguous mutation. Read
timeouts remain read failures. Every slice is bounded to 2–30 minutes.

For a new daily report, `--start OPERATOR.json` uses the existing operator format
and original local bootstrap journal through upload/prepare only. It then opens
the remote journal before any begin. It rejects an existing begin, final write,
recovery fence or other legacy terminal phase. It does not import today's old
completion intent. A bootstrap stopped before remote open still requires its
original local journal; hourly resumes never allocate a replacement upload.
Pass `bootstrapNotBefore` to `driveRemoteNativeHost` as the report date's 07:50
Asia/Shanghai instant. The dispatcher waits in at most 30-second intervals before
launching the CLI and starting its execution budget. Research/publication at
07:20 must not consume that later send budget. A cloud task ending during this
pre-upload wait has not established a remote journal; retain its original run
record and never invent a replacement bootstrap on an hourly retry.

For later slices, `--resume CONFIG.json` requires only `allow_final`, `scope` and
`workspace_host`, with the same fixed native identities. It discovers up to four
open journals ordered by oldest due time, picks the first due entry, reads the
original report thread and file, and hashes the exact UTF-8 bundle bytes. There
is no local journal, cached completion grant, credential or upload URL to carry
across runs. The original Publisher bundle/source/reservation is authoritative.
The authenticated `journal_catalog` command uses the fixed envelope exported as
`JOURNAL_CATALOG` and no report-specific file/attempt fields. It does not create
tables or adopt legacy reservations. Completed runs are excluded.

Before begin, a due fresh executor verifies publication and may allocate the first
intent. After begin, an existing executor alone can allocate final completion;
the ordinary native begin receipt and fresh publication checks are also required.
A restarted executor only reconciles existing intents. Stored matching begin and
record evidence is exposed in journal snapshots; final evidence always comes
from the independent original-file checker. Check/status reads for opted-in
journals are exempt from the ordinary command quota, so read reconciliation has
no hidden count cutoff. Audit rows remain retained.

The runtime emits `complete`, `deferred`, `idle`, `observed` or `stopped`. Only `complete`
reports verified Slack delivery; WeCom remains independently unverified.
`deferred` reports the persisted Publisher next-attempt instant. An unresolved
control response emits `stopped`, not an invented successful deferral. New slices
discover the existing ledger and never replay the old command.
`observed` means another executor won the operation CAS; it leaves that owner's
revision/backoff unchanged. Settlement conflicts reread the returned snapshot
and submit a new conditional acknowledgement, without replaying the operation.
After begin, transient publication checks retain the live executor and retry
within its remaining slice. If that slice cannot retain the owner, subsequent
runs remain reconciliation-only; they cannot promise a new send for a known or
unknown original completion intent.

Deployment and scheduler changes are separate operational steps. First stage and
validate the exact merged version without production credentials. Existing
unresolved-operation deployment and migration gates still apply. Never copy,
reset or migrate a live journal to make those gates pass. Then verify the active
Publisher supports the catalog and runtime protocol before changing the existing
cloud task. Do not enable a scheduler against unsupported deployed code.

An existing hourly-capable cloud schedule can poll this runtime at or after
`next_attempt_at`; this is coarse polling, not an exact T4 callback. Retain the
daily report creation at 07:20 Asia/Shanghai and permit new report construction
only in that daily slot. Other hourly slots run `--resume` only. Do not regenerate
the current report or invoke `--start` on a retry. A completed, future-due or empty
catalog produces no formal message. At 07:20, process the new daily workflow and
then resume older pending runs within available execution time. A schedule change
alone is not proof that a cloud execution or delivery succeeded; read back its
actual run result and independent receipts.

Tests use synthetic bundles, fake native tools and isolated SQLite files. They
verify disconnects, rate-limit persistence, concurrent executors and lost replies;
they neither deploy a service nor exercise a production destination.
