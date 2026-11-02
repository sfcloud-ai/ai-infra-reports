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
