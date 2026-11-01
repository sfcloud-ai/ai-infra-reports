# Durable readiness and notification handoff

These tools add an opt-in recovery path; they do not deploy it, create keys,
enable automatic merging, change schedules, or send a final Slack/WeCom message.
The existing publication, image hashes, exact merge SHA and repository gates
remain required. An operator must separately approve activation and verify the
actual cloud transport. Run offline coverage with `npm test`.

## Stage a readiness change without resetting history

`ready_for_review` is part of the report database identity. Editing that boolean
and restarting against the old database is deliberately rejected. Reusing an
existing draft with `propose(..., {ready: true})` does not promote it either.

Prepare two private config files owned by the dedicated service user, with 0700
parent directories and 0600 files. The proposed file may differ only in
`ready_for_review` and a **new** absolute `state_dir`. It must retain every sender,
App, key-file path, destination and activation-boundary field. Provision a private
parent directory where the service user can create the new state directory.

Stop and quiesce every publisher writer before this sequence; leave them stopped
until the separately approved cutover. A plan can also be inspected read-only
before stopping, but it is not authorization to activate it.

```sh
node scripts/ready-migration.mjs plan /private/current.json /private/ready.json
node scripts/ready-migration.mjs stage /private/current.json /private/ready.json DATA_SHA256_FROM_PLAN
node scripts/ready-migration.mjs verify /private/current.json /private/ready.json DATA_SHA256_FROM_PLAN
```

The CLI requires Linux ownership checks. `plan` checks integrity, scope and a
deterministic fingerprint of the jobs and outbox data. Any pending report,
unresolved notification or unknown control reply prevents staging. Unknown
tables, views or triggers also stop it. `stage` uses SQLite's consistent backup,
refuses an existing target, checks the original again, and changes only the scope
in the **copy**, adding a migration audit record. Completed reports, bytes,
source timestamps, receipts and notification deduplication survive unchanged.
`verify` compares both databases and the audit record again before cutover.

No command changes the active config, service or source database. A source change
invalidates the staged copy. A failure may leave a partial target: keep it for
inspection, never overwrite it or delete the original to retry. Separately review
the service's writable path and activate the verified config only while all old
writers remain stopped. Rolling back after new jobs arrive requires reconciliation,
not switching to a stale database snapshot. Keep consistent backups private.

## Optional notification outbox

Add both fields only after approving the destination and reconciling historical
deliveries (the values below are fictitious):

```json
{
  "notification_destination": "DEXAMPLE",
  "notification_not_before": "1794000000.000001"
}
```

The fields bind a separate outbox scope in the same private database. They do not
change the report-store identity or the Slack bot's permissions. The timestamp
is a fixed activation boundary for the **original report command**, not a value
to recompute each run. Reports at or before it cannot obtain a grant, preventing
old completed publications from becoming fresh notifications when enabling the
outbox. Changing either field after first use fails closed. The publisher remains
restricted to its existing private control channel; it never gains DM access,
file-upload permissions or the relay's credentials.

The producer uploads one UTF-8 `ai-notice-command.json` (at most 16 KiB) with the
same authenticated sender and native file-sharing checks as report bundles. Its
single top-level initial comment is:

```text
!ai-notice submit COMMAND_ID SHA256_OF_ACTUAL_FILE_BYTES
```

Do not manually append connector attribution. Use `notice-command.mjs` to validate
and encode JSON, calculate the digest of its actual output, then use the existing
authorized native upload tools. Commands must have exactly the fields for their
action; no credential, destination, arbitrary URL or executable field is allowed.
All actions share `schema_version: "1.0"`, `command_id`, `action`,
`report_request_id` and `bundle_sha256`. IDs use the report request-ID syntax.
Commands retain their original hash and source timestamp; changing bytes or
reposting an existing ID is rejected. Existing intake-window and capacity limits
still apply (10,000 durable notice commands, explicit retention required).

| Action | Additional fields | Result |
| --- | --- | --- |
| `claim` | `attempt_id`, `file_id` | Reserve the edition once and reply to this control thread with one grant. |
| `status` | none | Read the durable reservation; never authorizes a send. |
| `unknown` | `attempt_id`, `file_id` | Preserve an uncertain final send; never release the reservation. |
| `record` | `attempt_id`, `file_id`, `message_ts`, `text_sha256`, `transport_sha256`, `transport_bytes` | Store the original sender's report of an observed message, distinct from verified delivery. |

Example claim data:

```json
{
  "schema_version": "1.0",
  "command_id": "notice-claim-example-01",
  "action": "claim",
  "report_request_id": "report-example-01",
  "bundle_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "attempt_id": "scheduled-execution-example-01",
  "file_id": "FEXAMPLE"
}
```

## Cloud sender sequence and recovery

1. Finish the existing report workflow and receive its authenticated publication
   receipt. Obtain an upload ticket for the original poster and upload its bytes,
   retaining the file ID, but **do not complete/share it to the final DM yet**.
2. Submit a claim binding that file ID and a unique execution attempt. The
   publisher requires `receipt_sent`, rechecks the exact publication and every
   image, and binds the destination, edition, merge commit, bundle, poster and
   expected title/URL hash. The SQLite transaction permits only one reservation
   across processes. A competing command gets `send_authorized: false`.
3. Read the original control thread with the authorized cloud connector.
   `verifyNoticeGrant` checks authenticated read context, publisher user/bot,
   thread, command digest, attempt, file, destination and reservation. Only the
   original uninterrupted execution may consume its **new** grant once. The
   verifier always returns `resume_send_allowed: false`. A copied/quoted reply,
   status reply or another attempt is not permission.
4. Recheck publication and the final-format contract before completing the
   original native upload once to the pinned DM. Use only that granted file ID,
   the report subtitle plus full edition URL, and the original poster. Slack
   [documents upload completion as a one-time operation](https://docs.slack.dev/reference/methods/files.completeUploadExternal/).
   The outbox supplies a durable intent and deduplication boundary, not a promise
   of a distributed exactly-once transaction. It does not verify an unshared file
   merely from its ID; the sender must verify the actual image and message.
5. Read the actual final message and run the brief project's
   `check_received_notice` with its authenticated read context. Bind the returned
   timestamp and **actual new** file ID. Preserve the original poster hash and
   actual transport hash separately. If Slack changes PNG metadata, verify full
   decoded dimensions and sRGB RGBA pixel equality; never loosen report/archive
   byte hashes. Submit `record` only after this check.
6. A record is explicitly `slack_status: sender_reported`,
   `wecom_status: not_checked`. The control bot cannot read the final DM or verify
   a sender's submitted evidence; it must never promote that assertion into a
   delivery receipt. The existing relay's text/image acknowledgments remain
   separately required before claiming WeCom success.

An execution that resumes after a crash must use `status` and read the DM using
the bound file ID. It must **not** consume an old grant, complete an upload again,
replace the file, create another attempt or reuse an edition with a new command
ID to resend. If an exact message is found, verify and record it. Otherwise submit
`unknown` or leave the reservation unresolved and require operator reconciliation.
There is no expiry, automatic release, reset or force-retry operation. This trades
automatic retry availability for avoiding uncertain duplicate sends.

Control replies also have durable `response_ready`, `response_sending`,
`response_unknown` and `response_sent` phases. Before a write the worker commits
`response_sending`. After interruption it uses only
[`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)
on the exact original control thread, requiring one matching, unedited publisher
reply and a complete bounded page. A missing, ambiguous, inaccessible or truncated
thread stops recovery without another write. A confirmed reply moves the existing
command forward without reposting. No added scopes or permission fallback exists.

Each tick advances at most one eligible notice and one report. The earliest
eligible notice runs before polling an unrelated PR; claims awaiting their own
publication yield to later eligible notices and report progress. Uncertain
control writes take precedence over all fresh replies, including a waiting claim
that has since become eligible. Unresolved external writes still stop the worker
for reconciliation instead of being retried or skipped.

The cloud schedule still needs a separately reviewed protocol update and an
actual scheduled-runtime trial. Unknown final sends may still require an operator.
The zero-news contract and reliable 08:00 preparation schedule are separate work;
this feature does not fabricate a report or change their current behavior.

## BLOCKED is not a bypass instruction

Keep `gateFacts`'s `clean` requirement. GitHub's aggregate `BLOCKED` state does not
identify which rule blocks a particular actor. In the observed report trial, a
human-authorized merge succeeded after exact CI/tree/rule checks despite that
aggregate status; this does not establish what an authenticated Merger App will
observe or may bypass. Offline mocks cannot prove live permissions.

GitHub documents [update restrictions, required reviews and status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)
as distinct controls. The [merge API](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)
checks a supplied head SHA and can refuse a merge. Before activation, inspect the
actual Merger view of a ready, exact-head, green report PR and complete the approved
negative permission probes. If it still reports blocked, investigate the concrete
rules and reviews; do not guess the cause, allow every blocked state, grant wider
bypass, or replace the identity. No merge gate is changed by this feature.
