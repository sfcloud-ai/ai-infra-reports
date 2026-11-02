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

## Integration still required

This change implements and tests the server protocol and native receipt adapter;
it does not deploy them, migrate a real run, integrate the old local-journal CLI,
or install a cloud wakeup service. The host must opt in while its original
reservation is still eligible and orchestrate journal commands through the existing
native transport. Ambiguous uploads/shares of command files are read-reconciled,
never blindly repeated. A fresh snapshot request is a new read operation, not a
retry of an unknown mutation.

`next_attempt_at` is durable data, not a timer. The existing scheduler still needs
an actual authenticated entry that wakes the original cloud task and preserves
its fixed identity. Without that entry, this protocol does not establish an
operational unattended retry loop. Tests use synthetic bundles and isolated
SQLite files; no production journal, file ID or completion intent is exercised.
