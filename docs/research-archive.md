# Private research checkpoints on the Publisher host

This optional lane persists research inputs and outputs before report staging.
It does not publish, deliver, assign a researcher, or reset a budget. Date
ownership and research-operation admission remain a separate activation step.
Use the existing authenticated native sender and private control channel.

Install reviewed code and the matching CD controller first. Under the original
exclusive Publisher lock, preserve the original database and configuration,
then add `research_archive` with a new UUID `generation`, exact `activation_ts`,
and `first_report_date`. Call `installResearchArchive(db, config, evidenceRef)`
once. Record the migration privately. Runtime validates this original policy and
never creates a replacement. Original staging and delivery bindings are retained.

A checkpoint is UTF-8 JSON with exactly these fields:

```json
{
  "schema_version": "research_archive_v1",
  "command_id": "11111111-1111-4111-8111-111111111111",
  "request_id": "morning-20261111-r1",
  "report_date": "2026-11-11",
  "previous_sha256": null,
  "files": [
    {"path": "audit/plan.json", "sha256": "EXACT_FILE_SHA256", "content_base64": "EXACT_ORIGINAL_BYTES"}
  ]
}
```

The example's hash and bytes are placeholders. Generate them from original
private files, retaining whitespace and newlines. Include source bytes,
consumption checkpoints, audit/editor
outputs, images and final bundle as they become available. Credentials and signed
upload URLs remain in their existing credential stores and immediate transport.
The original plan lives in T4 authority. Fixed prompts and the history index are
read from their pinned Git commits using [repository inputs](research-authority.md).
They are not checkpoint payloads. Before obtaining an upload ticket, the client
reads the authenticated original host plan and rejects fixed input paths and
byte-identical copies under another name. The host repeats this check on receipt.
Each checkpoint contains up to 128 changed files, each at most 8 MiB, totalling
at most 12 MiB decoded and 16 MiB encoded. Larger collections use successive
checkpoints. New checkpoints name the previous checkpoint's exact SHA256; a
stale predecessor cannot overwrite the selected head. No file is deleted.
Wait for the host's `stored` confirmation before creating its successor. A
temporarily unavailable parent remains pending with `archive_parent_unavailable`;
an already superseded parent produces a terminal predecessor conflict.

Upload through the existing one-shot bridge:

```text
umask 077
stty -echo -echonl -icanon min 1 time 0
node scripts/research-client-cli.mjs /private/client.json /private/original-checkpoint.json --archive
```

Use a persistent PTY with terminal echo disabled before providing native results,
or a private non-echoing stdin pipe. A signed upload URL must never appear in a
terminal transcript, journal, checkpoint, or command argument.

Use the original scope and upload binding described in
[research authority](research-authority.md). The bridge obtains authenticated
host control receipts before each native operation. Pass the original native
tool result to that same session exactly as for report staging. Its completion
comment is `!ai-research save REQUEST_ID HASH`.
The host downloads the authenticated original file, validates every file hash,
and commits the original archive bytes, manifest, chain head and command result
in one SQLite transaction before acknowledging `stored`. Upload completion
alone is not a host persistence receipt. This lane creates no report job.

After an uncertain save, read the existing original file and command; query the
host result using a new read command instead of uploading a replacement:

```text
!ai-research read REQUEST_ID QUERY_UUID receipt ARCHIVE_SHA256 0
!ai-research read REQUEST_ID QUERY_UUID head head 0
!ai-research read REQUEST_ID QUERY_UUID manifest ARCHIVE_SHA256 0
!ai-research read REQUEST_ID QUERY_UUID file FILE_SHA256 0
```

Every query uses a fresh UUID. Verify the Publisher user/bot, original request
thread, `source_ts`, query UUID, request/date and returned hash. The receipt query
reads committed host state even if an earlier Slack acknowledgement is unknown.
Unknown acknowledgements are not resent and cannot block later read queries.
Confirmed malformed data, reused command IDs and predecessor conflicts produce
a durable `rejected` result, without repeated downloads. A predecessor conflict
includes `expected_head`: read and reconcile that head before forming a new
checkpoint with a new command ID. This is a rejected new checkpoint, not an
unknown upload or permission to overwrite the old checkpoint.
Manifest pages contain up to 32 files and stop earlier to keep the complete
receipt within 4,000 UTF-8 bytes. Follow `next_offset`.
`archive_source_ts` identifies the original save, while the outer `source_ts`
always identifies the current query thread. Follow
`previous_sha256` for earlier checkpoints. The first occurrence of a path while
walking backwards is its current version. File queries are scoped to that
request and return up to 2048-byte chunks, original total size, offset, chunk hash and
next offset. Validate each chunk and the complete original SHA256 before use.
Follow the returned offset instead of assuming a fixed page length. The bound
includes base64 expansion and the JSON envelope so Slack does not split a file
receipt into multiple messages. Existing stored archives and uncertain replies
are retained unchanged; use a fresh authenticated query to read committed data.
No host path or command can be requested through this interface.
Missing files/checkpoints return a terminal `not_found` observation; invalid
offsets return `rejected`. A corrected or later observation uses a new query.
Neither result is retried indefinitely or marks unrelated publication unhealthy.

A fresh cloud execution first reads the original host run and plan, then the
archive head and small checkpoint files.
Fetch individual missing files as needed; do not copy an entire audit on every
hourly run. Large final audits and packaging should run on the host holding the
original files. This small-message fallback remains available if old Slack
uploads are removed; original bytes are in the host SQLite database, not just
referenced by a Slack file ID. Archive storage is bounded to 256 checkpoints per
date and 2 GiB total; capacity exhaustion is reported without deleting history.
The command journal accepts up to 100,000 events. At that limit, new research
commands are refused with `research_command_capacity` in intake diagnostics;
the shared scan still commits report commands and advances its watermark.
No refused command is a persistence acknowledgement. Operators must expand the
reviewed capacity before continuing research; existing history is retained.
An authenticated file with permanently invalid metadata receives a durable
`invalid_file_metadata` rejection. Transport failures retain bounded backoff.

In a missing-history migration, preserve the incident evidence and original
authorization separately. Unknown historical consumption stays unknown. A new
checkpoint records new observed facts; it never reconstructs an old installation
identity or proves that a missing prior operation did not occur.

## Explicit recovery of an uncertain archive POST

`authenticated_control_chunks_v1` is a bounded recovery capability of the same
`repository_inputs_v1` authority, not a replacement upload or research entry point.
Use it only after reading the original complete operations and archive receipts.
A missing archive or deleted Slack file does **not** establish that a POST failed.
The original native operation and file remain immutable uncertainty evidence.
This recovery does not send a report, settle source/model work, grant a permit,
change the fixed plan, or reset the budget.

After verifying the deployed capability, use the existing `--control` client,
original request, current owner/epoch/revision and authenticated control channel:

1. `archive_recovery_begin`: args `operation_id`, `archive_sha256`, `file_id`,
   `total_bytes`, `reason: "original_post_unknown"`. The host requires the original
   acknowledged ticket and uncertain POST with these exact bindings, no completion
   operation, and no stored archive. The maximum recovered archive is 65,536 bytes.
   Its original command ID becomes `recovery_id`; never start another recovery.
2. `archive_recovery_chunk`: args `recovery_id`, `offset`, `content_base64`,
   `chunk_sha256`. Use 1,024-byte aligned chunks (last chunk may be shorter).
   Only original archive bytes are permitted. All successful chunks live in the
   existing immutable control command ledger, not cloud state.
3. `archive_recovery_status`: read-only args `recovery_id`, null owner/run.
   Reconcile committed offsets after interruptions; exact same-offset bytes are
   idempotent, changed bytes are rejected. Reconcile unknown commands with the
   existing `receipt` action before continuing.
4. `archive_recovery_commit`: args `recovery_id`. Within the original transaction,
   the host checks every chunk, original aggregate hash, archive schema, input
   exclusion, predecessor and capacity. The authenticated commit message provides
   the storage source timestamp. The original file ID is retained as an incident
   reference, **not** evidence that a Slack file upload succeeded.

The archive receipt's `recovery` field names this transport, original POST and
file, recovery ID, commit source and `original_post_outcome: "unknown"`. Read the
stored manifest/files and authenticate complete hashes as usual. Never label
this result as successful completion of the original upload. A late attempt to
settle the original POST is refused after recovery starts; its historical row
is never overwritten. Receipt loss is resolved through original commands and
readback, not another upload or another recovery. No code capability or test
result is evidence of a real checkpoint being stored.
