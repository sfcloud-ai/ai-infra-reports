# Persistent staging through the existing Slack channel

This optional input is for a cloud researcher that can use native Slack tools
and the existing managed HTTPS proxy, but cannot execute commands on the
Publisher host. It reuses the existing bundle, native sender, private channel,
file metadata checks, publication worker and scheduled delivery. No new token,
scope, listener or cloud-to-host shell is needed.

## Activation

Install the code and CD schema support before enabling this input. Pause the old
Producer; drain the Publisher and hold its original exclusive lock. Preserve all
original journals, unknown operations and quarantined dates. Do not initialize a
replacement Producer journal or convert old requests to this protocol.

Add an explicit `slack_submission` configuration with exactly `generation`
(UUIDv4), `activation_ts` (six-digit Slack timestamp) and `first_report_date`.
The existing `producer_fence`, `durable_intake`, native sender identity and
`scheduled_delivery` are required. With the original Publisher database open
under that lock, call `installSubmission(db, config, evidenceReference)` once.
It refuses existing tables and any original Producer grant. Record the backup,
original ledger fingerprint, exact config and installation evidence privately.
Runtime never installs this policy. Removing or changing it blocks startup.
The policy disables new local Producer completion registrations, while retaining
the original fence and every old record. It is not an alternative way to replay
an old unknown upload. CD must defer while staging or publication is unfinished.

## Daily input

1. Keep the existing research audit, content checks and immutable original
   `ai-brief-bundle.json`. Use `morning-YYYYMMDD-r1`. Before uploading, read the
   original date's control messages and authenticated Publisher status. If T4
   already has `publisher_submission.bundle`, retain its request, hash, original
   file and source; do not regenerate or replace it. An admitted job follows the
   existing status/recovery path.
2. To stage a new bundle, run Node 24 with the reviewed release and its locked
   dependencies in the existing cloud environment:

   ```sh
   node scripts/slack-stage-cli.mjs /absolute/original/ai-brief-bundle.json PINNED_CHANNEL --managed-proxy
   ```

   Use a persistent PTY, disable terminal echo, and pass actual native tool
   results directly from the trusted tool orchestrator to the original session.
   Each `type: write` contains the exact native `tool`, `arguments` and UUID
   `operation_id`. Execute it once, then provide one JSON line:
   `{"type":"native_result","operation_id":"...","result":ACTUAL_RESULT}`.
   Never print, persist or manually transcribe the signed upload URL or full
   native result. The CLI performs one raw POST using the existing managed proxy,
   TLS verification, fixed Slack host, no redirects and no retry. Only confirmed
   original-byte upload permits native completion with the exact comment:
   `!ai-report stage REQUEST_ID BUNDLE_SHA256`.
3. Read the original file/share and issue the existing `!ai-report status
   REQUEST_ID`. Verify the real Publisher identity and source-bound receipt.
   `publisher_submission.bundle` must contain the original request/date/hash,
   `source_ts`, `file_id`, and `phase: staged`. This means the original bytes are
   durably on the host. Upload completion alone does not establish this.
4. Only after that exact staging receipt, send a native top-level plain command:
   `!ai-report submit REQUEST_ID BUNDLE_SHA256 ORIGINAL_STAGE_TS`.
   No attachment and no hand-written connector attribution. This authorizes the
   existing publication and scheduled-delivery path. Reconcile an uncertain
   submit from its original message and status; do not repeatedly resend it.
5. Continue existing Pages and scheduler checks. `staged`, `received` or a Slack
   receipt is not delivery success. Require matching original commit/hash/date
   and actual text/image completion from the original scheduler ledger.

Staging alone never creates a publication job or sends a report. The host
persists discovered messages with its history checkpoint, then downloads and
validates exact original bytes. A staged date is reserved. A duplicate staging
with identical bytes may have another file ID, but cannot replace the selected
original source or file. Conflicting hashes remain blocked evidence. Explicit
submission checks the original Publisher and Scheduler claims, then commits the
local staged-to-admitted transition and job in one SQLite transaction under the
original Publisher lock. This is not a cross-database atomic reservation; a later
Scheduler conflict still blocks through the existing protocol.

If a staging attempt fails or its result is unknown, retain its original file
ID, bytes, source and safe diagnostics; locate the original Slack file and T4
status. The one-shot CLI does not retry or refresh unknown operations. Losing a
cloud session no longer loses a bundle already staged on the host. Losing bytes
before confirmed staging is still an unresolved transfer, not permission to
invent replacement bytes or report success.

## Transport probe

The optional `--probe-managed-proxy` flag accepts only a JSON object containing
`schema_version: "slack_staging_probe_v1"`, a UUIDv4 `nonce`, and the exact
`payload: "transport validation; no report publication"`. It uploads
`ai-brief-transport-probe.json` with an inert `!ai-transport-probe` comment.
Publisher ignores this command; it cannot create a report job or delivery.
Use it only with authorization to post the probe in the pinned private channel.
Read back the actual file through the existing host bot and compare original
byte length and SHA-256. This proves the data route, not a real daily publication
or WeCom delivery. Synthetic tests prove neither production network access nor
the actual cloud runtime's managed-proxy configuration.
