# Native scheduled-host wiring

This is the local implementation of the native-tool sender for an **already
published, immutable report bundle**. It does not research, publish a report,
install a service, change an automation or send a zero-selection notification.
It reuses `CloudRunState` for client write intents and the Publisher's existing
outbox for reservation/permission. No new database authority, token or sender
identity is introduced.

## Runtime pieces

- `native-scheduled-host.mjs` calls the existing native Slack ticket, completion
  and filtered-search tools. Its byte POST uses the returned URL unchanged,
  disallows redirects and has no automatic retries. Signed URLs are not persisted.
- `native-host-cli.mjs` is a long-lived Node 24 process. Start it with one local
  operator JSON file. It emits bounded JSON-line `tool` requests; the scheduled
  host invokes that exact native tool and returns `{type:"tool_result",id,result}`
  with the actual unmodified result. `{type:"tick"}` advances one step.
- `native-host-dispatch.mjs` supplies that tool-capable host loop, with a three-tool
  allowlist, a bounded lifetime, read polling and no mutation retry. It uses the
  host's `tools.exec_command` / `tools.write_stdin` to keep the Node process alive.
  Its function is plain JavaScript suitable for the functions host; no Node
  imports or dynamic evaluation are needed in that dispatcher.

The operator file has exactly `state_file`, `bundle_file`, `report_commit`,
`scope`, `workspace_host`, and `allow_final`. Paths must be absolute. `scope` is
the existing verified `CloudRunState` identity/transport scope, not newly guessed
IDs. Use one durable private journal for all consumers of an edition; do not
reset it, duplicate it or switch scope to retry a run. Directory ownership and
symlink restrictions still belong to the approved host installer. Start with
`allow_final:false`: the host can reserve, but stops **before `begin`**, so it does
not consume the Publisher's unique completion intent.

Example launch shape (operator paths, not repository-controlled shell input):

```text
node /approved/checkout/scripts/native-host-cli.mjs /private/operator.json
```

The caller passes that fixed launch command to `driveNativeHost({tools,start})`.
Do not dispatch arbitrary tool names or interpret tool output as executable code.
The loop returns Slack verification separately from `wecom_status:not_checked`.
An exception or expired budget requires reconciliation, not restarting to resend.

## Delivery and recovery

Publication verification binds the supplied bundle to the source commit and
current Pages content, including original poster bytes. Pre-upload begins no
earlier than ten minutes before the report date's 08:00 Asia/Shanghai deadline.
The existing roughly fifteen-minute retention observation is not a Slack SLA;
an expired or unknown upload is never replaced automatically.

New runs use `native_bundle_v1`: pre-upload the exact JSON report bundle as
`ai-brief-bundle.json` → `prepare_bundle` → due time and fresh publication check → `begin` →
due-time completion → final-message locator → independent T4 `check` → `record_bundle`.
The final message text is still only article titles and their URLs. The receiver
extracts the original poster bytes from the bundle before its WeCom text/image
writes. It never strips provenance chunks or substitutes a transformed image.
Existing durable `native_v1` runs keep their PNG transport and original
`prepare`/`record` actions; a run cannot change transport after admission.
The completion transaction repeats the time/freshness gate after acquiring the
existing journal lock. A restart before `begin` keeps the original reservation.
A restart after a begin command was allocated can only reconcile; it cannot reuse
the grant. This deliberately favors no duplicate delivery over automatic recovery
of a potentially lost first send.

Control source lookup matches the observed native result format, pinned user,
workspace, channel and exact command text. The existing native receipt verifier
then checks the Publisher, command hash and original thread. Rendered locators
are not fabricated raw bot/App metadata. The final message locator is only an
input to the real T4 checker; neither a search hit nor upload acknowledgment
establishes image-byte identity. T4 must verify the complete raw bundle hash and
length against the immutable Publisher job, plus the extracted poster hash and
length against the published report. `transport_sha256`/`transport_bytes` always
describe the actual Slack file; bundle receipts add `poster_sha256`/`poster_bytes`.
The receiver also verifies every declared bundle file, the exact report metadata
hash and the independently read publication manifest before any WeCom write.

Read polling reuses a command whose outcome is unknown. A completed negative
checker result permits a fresh read-only check of the **same** original message
and file, up to a bounded refresh budget. It never grants another completion.
Zero-selection bundles remain rejected by the existing contract.

## What has and has not been exercised

Local tests use actual bundle/publication validators, native receipt parsing,
the persistent client journal and the real Publisher outbox, with simulated
native Slack calls and HTTP. They cover early preparation, exact-time gating,
forged responses, unknown writes, restart, original-file binding and refreshed
negative checks. No test invokes a real next-day `begin`, formal DM or WeCom.

Before enabling the existing daily automation:

1. Review/merge this delta and deploy it through the existing approved paths.
   Keep the fixed root entry; this change needs no root control-layer update.
2. Confirm the **actual scheduled environment** exposes the three native tools,
   can run Node 24 and maintain the process/journal independently of an offline
   laptop, and can access the exact local bundle bytes. Current local tool
   availability does not prove the cloud automation has those capabilities.
3. Check the real ticket/result envelope against the strict adapter and qualify
   the final JSON bundle transport. A control-channel JSON read preserving original
   PNG bytes does not prove final-DM rendering or a guaranteed pre-upload retention
   period. Deploy the compatible receiver and independent checker before using
   the new mode; an old checker rejects its request rather than weakening checks.
4. Perform an isolated rehearsal with test report/attempt IDs and a separate
   state directory. At the relay's final HTTP boundary capture the exact text and
   image payload; do not complete a formal DM or consume a real report's intent.
5. Only after acceptance, set the approved launcher to `allow_final:true` and
   update the existing task's lead time/instructions without duplicate schedules.
   Preserve title + article URL text and one landscape poster; no text summaries.
   Keep the existing delivery fallback until this cutover is verified.

This commit does not execute those rollout actions. The report-generation handoff,
zero-selection delivery contract and actual WeCom receipt monitoring remain
separate from a successful local sender simulation.

Temporary publication-read failures (explicit rate-limit responses, HTTP 429/5xx,
network timeouts and connection errors) keep the same live host pending, respecting
Retry-After / rate-limit reset with a minimum 15-second backoff. Ordinary 401/403,
identity mismatches and invalid content remain fatal. No intent is allocated before
the report due time and a successful full preflight. After begin, expired evidence
is refreshed in the same process; it never authorizes a second begin or completion.
These retries do not make a stopped process resumable after begin: retain the
original journal and use read-only reconciliation as above.

### Durable read retry across execution slices

Temporary publication failures are stored in `cloud_read_retries` in the **same
SQLite journal**: operation, failure count, first/last failure time, next retry
instant and a bounded diagnostic category. There is no overall retry-age or
attempt-count expiry. A successful read clears that operation's retry. A process
restart does not clear rate-limit backoff or make cached public proof fresh.

The dispatcher still has a bounded per-invocation budget. At a quiescent boundary
it sends `{"type":"defer"}` instead of abandoning the run. The CLI persists the
wait and returns `type: deferred`, original `run_id`, `input_hash`, absolute
`state_file`, `next_attempt_at` and `resume_mode`, then closes the journal. This is
**not delivery success**. Near the slice deadline, no new begin is allocated.
A timeout with an outstanding tool write is not converted into a safe retry.

The existing scheduler/launcher must persist that deferred result and wake the
same task at or after `next_attempt_at`. Resume with the same operator and bytes:

```sh
node scripts/native-host-cli.mjs /absolute/operator.json --resume ORIGINAL_RUN_ID
```

`--resume` refuses a missing journal or different run before admitting any new
reservation. It checks journal metadata rather than reading the database into
memory. Scheduled deferral rejects runs owned by an explicit recovery fence,
preserving their phase and immutable evidence. The scheduler must provide
access to the original private journal, including its SQLite WAL, plus the pinned
operator, exact bundle and fixed scripts. Do not copy, reset or reconstruct a
journal from the resume result. `/workspace/shared` is not by itself proof of
cross-run persistence. This code does not create a scheduled task, transfer state,
change credentials or provide a wakeup service. An existing daily-only schedule
will resume only on its next wakeup unless that existing scheduler is configured
otherwise; `next_attempt_at` alone does not run code.

Before begin has been allocated, `continue_before_begin` resumes the original
upload/reservation, and repeats the complete publication preflight before any
send permission is consumed. After begin allocation or any final write intent,
`reconcile_only` preserves the original file and only reconciles; it never
reuses a grant or repeats completion. Reconciliation can keep waiting across
slices without a total time limit. The separate explicit-recovery approval flow
is **not** invoked by retries. Ordinary auth/content/identity failures remain
fatal. Successful Slack and WeCom delivery continue to require their independent
receipts.

Execution slices must be 2–30 minutes (default 20); this is not a total lifetime
limit. The final minute is reserved for completing a begin already authorized in
the current process; a new begin is deferred before that window. Native
post-begin pending reads retain that current-process phase while waiting. A
resumed host's ready message does not establish a new completion grant. Native
search reads have a bounded timeout (default 15 seconds); an unsettled read can
be abandoned safely and polled later, but a mutation is never timeout-retried.
Repeated deferrals always advance an expired wakeup to at least 15 seconds in
the future, so a stale resume record cannot cause immediate wakeup loops.

For the separate post-reservation Publisher-owned journal protocol, see
[remote-native-journal.md](remote-native-journal.md). That protocol does not
automatically migrate this CLI's local journal or supply a scheduler wakeup.

The scheduled CLI advertises `protocol: native_durable_retry_v1` in its ready
message. The dispatcher sends deadlines, read-error replies and defer only to a
host with this capability. Legacy entrypoints, including explicit recovery,
receive plain ticks and stop for reconciliation when a read or budget expires.
The scheduled CLI closes its input interface when a slice ends, even if the
bridge keeps stdin open, so each deferred slice releases its process and journal.
If a search succeeds or temporarily fails in the final five seconds, the dispatcher allows up to
ten seconds to receive pending and acknowledge defer, including empty pipe
chunks. This cleanup window cannot dispatch another tool or tick; an unresponsive
host still stops for reconciliation when the bounded cleanup expires.
Every defer also starts a ten-second acknowledgement window, even when a
successful read delivered pending at the deadline. During acknowledgement only
the deferred result or a stop is accepted; no tools or ticks can be dispatched.
State and pending messages report `completion_window` from the current owner's
persisted begin, including while its receipt is still pending. The new-begin
margin never blocks that same owner's receipt polling, and restarting does not
inherit this ownership or permission.
Chained searches requested during read cleanup receive a temporary-read reply
without invoking another tool, allowing the host to reach pending and defer.
The original cleanup deadline and request-ID checks remain in force.
