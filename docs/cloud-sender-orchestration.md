# Offline report sender

This module coordinates a prepared report with the existing Publisher and notice
outbox protocols. It is a library exercised by offline tests, **not a connected
scheduled sender**. It adds no service, CLI, credentials, task or deployment.

## Actual execution boundary

The Publisher owns report publication and the durable edition/file reservation.
`NoticeOutbox` already uses the Publisher's `HandoffState` database. The sender
reuses its claim/status/record commands and the existing grant verifier; it does
not implement another reservation authority or grant itself permission to send.

A read-only deployment check on 2026-11-01 found the Publisher healthy at commit
`eea66a0a8cd33e1fcabdba59ed4dae3b0da25198`, with notifications unconfigured and
`ready_for_review: false`. The newer outbox code in main is not evidence that
notifications or automatic merging are enabled in the deployed service.

The cloud session exposes Slack upload-ticket and upload-completion tools. They
require a separate raw-byte POST between those calls. Channel/thread reads are
also available, but the inspected detailed probe response was rendered text with
sender/file IDs, not the raw `bot_id`, `app_id`, native blocks and complete file
metadata required by the verifier. Binary file reads return a file reference;
that alone does not establish access to the exact downloaded bytes in Node.
These tools are not callable Node methods supplied by this repository. The
scheduled host's byte transfer, raw authenticated read bridge, persistent storage
and final Python checker integration remain unimplemented and unverified. No
probe was sent during this review. Do not replace missing evidence with a
synthetic envelope or a `verified: true` assertion.

The current Publisher bot is a different identity from the cloud connector.
Moving final delivery to that bot would require a separately validated destination
and relay identity contract; it is not an implicit transport fallback.

## Inputs and time

Resolve prompt main once per research run with `pinPrompts`, then read research.md
and editor.md as fresh UTF-8 bytes at that SHA. Keep the snapshots and hashes.
`prepareCloudRun` binds the immutable bundle, base SHA, prompt snapshots, original
poster hash, edition and explicit-timezone `not_before`, normalized to UTC.
A changed ID, edition input, prompt, bundle or deadline cannot replace a run.

Publication, unshared poster upload and claim/grant verification can finish before
`not_before`. Only final upload completion is gated by the delivery time. The
sender must not complete the upload early, even without a destination: that would
consume the one-time completion rather than prepare the later DM.

For an 08:00 delivery, the future driver can start notification preparation around
07:45 once publication is verified, absorb the Publisher's polling delay, and call
`step` on `final_ready` near 07:59:30 to finish remote reads before the target.
At 08:00 another call can use those recent checks and invoke only the final
completion adapter, after the local time check and atomic write-intent fence.
These times are an initial operating budget, not a response-time guarantee or an
installed schedule. Earlier report generation/merge/Pages work needs its own lead.

Preflight reads of the original claim/grant, publication and transport are cached
for less than 60 seconds from the start of the reads. An early call performs
those reads, then returns `ReadPending` without recording completion intent. This
is a refreshable read cache, not a send capability or grant expiry. Restart,
binding changes, a clock reading before the cached start, or elapsed cache age cause fresh reads of
the same attempt. Failed/slow refreshes cannot use stale evidence or revoke the
reservation. Cache age and due time are checked again inside the completion
transaction; a cache expiring while waiting for the database lock leaves the
attempt unstarted and refreshable. The driver must call within the final minute
and again at the due time; a coarse 120-second sender timer would miss that path.

Use the host's ordinary maintained system clock and an explicit schedule timezone.
There is no separate time service, one-second uncertainty budget, ppm proof or
unrecoverable in-memory authorization. Cached checks have the normal bounded
time-of-check/use limitation; they do not prove nothing changed while waiting.
The code cannot prove independent UTC accuracy or exact arrival at 08:00.

Late work continues with the same unstarted attempt after fresh checks; no hard
late-send cutoff is imposed here. A grant read can take longer than a tick, and
the Publisher's 120-second minimum tick interval is not a response deadline.
The actual driver must report lateness and final delivery receipts. The existing
`notification_not_before` setting is an activation boundary for source messages,
not the daily delivery schedule. This PR changes neither setting nor schedule.

## Durable first attempt and recovery

```
prepared -> publication_wait -> published -> claim_wait -> final_ready
                                                              |
                                                         final_pending
                                                              |
                                                          record_wait
                                                              |
                                                        sender_reported
```

`CloudRunState` is a client write-intent journal, not a second notification
outbox. A remote Publisher cannot know whether the client has already requested
an upload ticket or completed a file. The journal records those uncertain client
operations before calling transport, while the existing outbox remains the
reservation authority. The deployment must select the real sender host and use
its durable storage; this library does not provision another database service.
Every consumer for a given edition must use the same journal, established before
any write. An ephemeral scheduled workspace is not sufficient.

The journal is scoped to destination, sender/Publisher identities and the
qualified transport profile. It uses SQLite WAL/FULL, unique run/edition and
operation keys. Only the owning service may access its directory; ownership and
symlink checks belong in the eventual installer. Never clone, reset or recreate
it to retry a reservation. Capacity is 1,000 runs, with no automatic purge.
Schema scope version 2 rejects the previous draft's journals. There is no automatic
migration of old reservations into unstarted attempts.

Each external mutation first records a durable intent. A missing acknowledgment
or crash after that intent means **unknown**, even if no message is found. The
sender may reconcile the original operation; it cannot repeat that write,
allocate a replacement poster, create another attempt or reuse the edition.

A restart *before* the final-completion intent is different: the durable journal
can still prove the first completion was never started. `final_ready` alone is
not permission. The sender rebuilds its read cache from the exact original claim
and grant, validates identity/content/destination bindings, and rechecks public
content and the qualified transport. At or after the delivery time it atomically
commits the unique completion intent and `final_pending`. Competing consumers,
including consumers with independently rebuilt caches, cannot win twice. The
existing grant remains first-attempt-only: `resume_send_allowed: false` is never
treated as permission to retry an attempted or uncertain completion.

A transaction failure rolls both changes back; the still-unstarted attempt may
revalidate and proceed. A crash after commit only permits reconciliation. There
is no volatile owner or ready capability that makes a known unstarted attempt
unrecoverable. The original upload may nevertheless expire or become unavailable;
that outcome must remain unresolved, without allocating a replacement file.

After completion, read the original final DM/file and invoke ai-infra-brief's
`check_received_notice` using raw authenticated evidence and the actual downloaded
poster bytes. Only then submit and verify the existing outbox `record` command.
`sender_reported` means Slack verification plus the Publisher's sender record;
`wecom_status` remains `not_checked` until separate relay text/image receipts are
verified. An API acknowledgment alone is not delivery verification.

## Remaining integration work

The tests use the real outbox/grant/record implementation, with simulated Slack,
Pages and final-checker adapters. They establish neither live tool support nor
production delivery. No new placeholder adapter is added by this revision.
Before activation the actual host needs:

- A reviewed bridge for the existing Slack tools, exact byte transfer and complete
  authenticated metadata reads, with hidden mutation retries disabled. Verify
  original-byte retention across the actual pre-upload wait before relying on
  this timing plan. [Slack's completion documentation](https://docs.slack.dev/reference/methods/files.completeUploadExternal/)
  supplies no retention-period guarantee; an upload URL's lifetime is not proof
  of unfinished-file retention.
- The real `check_received_notice` adapter and separately observed relay receipts.
- One durable client journal and the existing Publisher outbox configured through
  the normal deployment process, preserving all existing state.
- An authenticated zero-selection notification contract. `prepareNoSelection`
  currently records the precise research/source failure reason as
  `zero_selection_blocked`, `delivery_status: not_sent`, and performs no I/O.
- End-to-end validation before connecting the daily schedule.

Run `npm run check` and `npm run build:preview`. Sender regressions include
explicit-timezone persistence, raw identity/content rejection, early upload/claim,
delayed grants, due-time completion without remote preflight calls, restart before
and after write intent, stale/failed cache refresh, transactional rollback,
competing database consumers and unknown-outcome reconciliation without resend.
Do not use passing simulations
as evidence that the deployment or schedule is ready.
