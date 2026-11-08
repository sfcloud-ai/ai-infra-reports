# Producer upload recovery

This opt-in implementation uploads an immutable bundle to the existing
Publisher intake. It does not use the old native notice/begin/final-DM flow,
publish to GitHub, admit scheduler requests, install services or enable an
automation. Nothing enables it by default.

## Configuration and execution

Use Node 24, the repository's pinned dependencies, trusted curl and one
owner-only durable journal directory and a serialized runner across restarts.
The SQLite dispatch fence coordinates processes using that same original journal,
not independent workspaces or copied journals. Never clone or replace a journal to get past an unknown operation. The CLI rejects Publisher, scheduler
and legacy native databases as its own journal.

The cloud-native configuration has exactly four fields:

- `state_file`: dedicated Producer journal, absolute path.
- `bundle_file`: original `ai-brief-bundle.json`, absolute path.
- `scope`: `team_id`, `channel_id`, `sender_user_id`, `sender_user_app_id`,
  `sender_attribution_text`, `publisher_scope_sha256`, `scheduler_scope_sha256`,
  `scheduler_team_id`, `scheduler_channel_id`.
- `native_inspect`: `publisher_user_id`, `publisher_bot_id`, `workspace_host`.

Use identities and scope hashes from the trusted existing installation, never
report content. Scope hashes match Publisher `scope.value` and scheduler
`meta.scheduled_delivery_scope_v1`. The scheduler day-claim channel can differ
from the Producer intake. No credential belongs in this configuration.

```
node scripts/producer-upload-cli.mjs OPERATOR_CONFIG.json --initialize
```

`--initialize` is an explicit, offline first-setup step and refuses an existing
journal or leftover sidecars. It only creates empty Producer and, in native mode,
inspect schemas and binds their scopes. It does not read the bundle, reserve a
date/request, call a native tool or perform a POST. `bundle_file` may point to the
future first report, which does not need to exist during setup.

Normal `--serve` requires the original initialized journal. Before any mutable
SQLite constructor, it validates the exact schemas, integrity and scope bindings
in a private read-only snapshot of the original database and WAL. This avoids
SQLite's read-only WAL opener creating sidecars in the original directory. The
snapshot is discarded and can never dispatch work. Original inode, size and
modification metadata are checked before and after copying and again before use.
Only `--serve` then reads and prepares the real bundle. Empty files, empty SQLite,
missing tables/bindings, altered scope or schema, symlinks and hardlinks are
rejected without repairing the original. The journal and any sidecars must be
owner-only, owned by this user and have exactly one hard link.

A lost journal or a new ephemeral workspace blocks; it is never silently recreated from a
remote empty snapshot. Do not reinitialize to recover an old request. Activation
must verify fixed-path persistence and runner serialization in the actual daily
automation, not merely that a new workspace can execute this script.

The optional original local mode uses `state_file`, `bundle_file`, `scope`,
`publisher_database` and `scheduler_database` instead. Its original-ledger
adapter can reconcile **existing** bindings only. A jobs-only absence cannot
exclude unscanned Slack messages or pending intake, so local mode cannot grant
new admission. It opens original databases with SQLite `readOnly` plus
`query_only`, without constructing Relay `Store` or `ScheduledDelivery`, whose
constructors can mutate recovery state. Missing scope/schema, legacy date
mapping gaps and conflicting bindings block, rather than imply absence.

## First admission and cross-host inspection

The daily Producer runs in the dot cloud, while the original ledgers are on T4.
The native mode does not need local T4 database paths, new credentials or a new
listener. It uses the existing private control channel and the separately
implemented Publisher/scheduler inspect protocol:

```
!ai-report inspect REQUEST_ID YYYY-MM-DD BUNDLE_SHA256 QUERY_ID
```

**First upload now requires durable Publisher intake discovery to have scanned
through the authenticated query's source timestamp.** Publisher must have an
activation boundary no later than that report date's midnight in UTC+8. Pending
intake for the date, or an unresolved envelope whose date cannot be established,
prevents an empty snapshot. The original scheduler must also prove no original
request, daily claim or unmapped legacy claim. A request-only `not_found` receipt
plus a private delivery-plan record is not a substitute for these authorities.

Publisher replies in the original query thread with `!ai-report inspect-receipt`
and a strict snapshot containing the exact `query_id`, request/date/hash/source
binding, both scope hashes, `observed_at`, `complete`, `publisher_day`, `publisher`,
`scheduler_day_claim` and `scheduler`. The client accepts `complete: true` only
inside an authenticated native read result, not as a caller-created assertion.

`producer-native-inspect.mjs` parses the actual native search/thread format.
It checks exact tool invocation/channel/thread, complete pagination, the exact
parent command and connector footer, the real sender ID, exactly one Publisher
reply, real Publisher user ID, bot-address team/bot identity, timestamps and the
JSON binding. For the pinned footer mention, it accepts the raw `<@ID>` and
the observed `<@ID|ChatGPT>` rendering with the same ID. Other IDs or arbitrary
labels are rejected in both source search and thread reads. Display names and
body text never establish an author. Observed native source search can omit the
footer entirely; a command-only result is only a locator and grants no write.
The original footer is still mandatory in the authenticated thread read. The parser
does not fabricate absent raw `app_id`; Publisher independently validates the
original query's authenticated App identity. Missing metadata, ambiguous
results, a forged header inside body text or changed tool rendering blocks.
Search `after` is only a locator hint: actual six-digit timestamps are filtered
locally because a provider can round the query boundary to seconds.

Each inspect send gets a durable intent. `QUERY_ID` is that operation's UUIDv4,
bound exactly in the command, search keywords, parent thread and receipt. Before
five minutes, unknown sends only locate/read that original query. After at least
five minutes, a still-unresolved query may be followed by one independent,
nonce-bound read query. Its intent is committed first; the old unknown/located
row is retained unchanged and its operation is never resent. Repeated ticks
cannot create another unresolved query within the next five minutes.

An authenticated resolved receipt can be refreshed when needed. A stale receipt
resolves only its read query and grants no upload. Superseded queries and late
old replies cannot resolve the new query or replenish consumed write permission.
This refresh exception applies only to read-only inspect requests, never to
ticket, POST or complete operations. Those retain their original unknown fences.
The separately installed abandoned-ticket policy below can allocate a distinct
successor only when no previous content upload could have executed. It never
replays or changes the outcome of the unknown original operation.

The nonce protocol is a coordinated, not-yet-deployed client/server upgrade; the
old four-argument command is not accepted. Pre-nonce journal schemas/rows are
rejected as `producer_journal_schema_incompatible`, with no automatic migration
or invented nonce. Keep any such original journal for explicit reconciliation;
never delete it and initialize a replacement to replay an existing report.

Every ticket, raw POST and completion dispatch consumes its current read proof.
A **new** authoritative read is required before the next actual upload write;
60 seconds is only the freshness limit. A snapshot is not a reservation across
independent Producers. Existing Publisher/scheduler daily deduplication remains
authoritative, and one designated Producer journal remains required.

## Persistent PTY launcher

The cloud `exec_command` plain-pipe invocation closes stdin and cannot drive the
interactive bridge with later `write_stdin` calls. Use `tty: true`, retain its
returned `session_id`, and send JSON lines through `write_stdin`. A trusted
orchestrator must keep that session alive through `close`. The following POSIX
launcher was exercised using the actual cloud tools with synthetic data only:

```sh
# Set these to the one existing, verified private installation. Do not choose
# a new directory or journal after lock contention or a missing-state error.
PRIVATE_DIR=/absolute/persistent/private-producer-directory
REPO=/absolute/ai-infra-reports
umask 077
exec flock -n -E 73 "$PRIVATE_DIR/runner.lock" \
  bash -c 'test -t 0 &&
    stty -echo -echonl -icanon min 1 time 0 &&
    exec node "$1" "$2" --serve' \
  producer-runner "$REPO/scripts/producer-upload-cli.mjs" "$PRIVATE_DIR/config.json"
```

The directory must already be owner-only (0700), with one fixed, private regular
`runner.lock` file (0600, not a symlink) used by every runner, including setup.
Provision that lock once; never replace it while a runner could hold it. Hold
this same outer lock for the one-time offline `--initialize` command too.
Exit 73 means another runner owns the lock: do not switch paths to bypass it.
The `test -t`/`stty` chain fails closed before starting the bridge if there is no
usable PTY. `-echo -echonl` prevents input echo; `-icanon min 1 time 0` avoids the
terminal's canonical line-size truncation for large native result JSON. A real
16 KiB input line, lock contention and clean close were verified through the
cloud tool transport. This does not certify Windows pipes or persistent storage
across replacement cloud workspaces.

Never enable shell tracing, terminal recording, `tee` or logging of inbound
native results. They can contain an original signed upload URL or file bytes.
Forward real tool results unchanged over the private session, without printing
or persisting their raw content. The durable journal stores the pinned bundle,
safe bindings and metrics, not the ticket URL. This launcher and the journal checks do not
protect against a hostile process running as the same OS user.

## JSON-lines native bridge

After `ready`, send `{"type":"tick"}` for one bounded step. Native ticket,
completion and inspect sends emit one `type: write` action with `operation_id`,
exact `tool` and `arguments`. The trusted caller invokes that tool once and
returns its unchanged real native result:

```
{"type":"native_result","operation_id":"...","result":{}}
```

Read actions identify the exact native search/thread tool and arguments.
Return the unchanged actual invocation (`tool`, `arguments`, `result`) in
`{"type":"inspect_source_result","invocation":{}}` or
`{"type":"inspect_thread_result","invocation":{}}`, respectively. These are
native tool bridge messages, not shell commands for an invented native API.
The bridge must be driven by the authenticated orchestrator, never report
content or arbitrary user-supplied evidence JSON. No `downstream_result` command
accepts a fabricated verified snapshot.

The POST step runs the concrete curl adapter directly. Original signed URL
bytes go through curl stdin, not argv/logs, with no redirects, proxy, retries,
URL normalization or shell interpolation. Bundle bytes come from the journal.
The URL lives only in memory. After restart, `restore_ticket` accepts only the
original native ticket result with the same file ID and URL hash. Without the separately installed restart policy below, an unavailable
or rejected original ticket blocks, never creates a replacement file.

A real Publisher inspect receipt can supply `publisher.file_id` only when the
original admission durably retained `jobs.detail.intake_file_id` after strict
file/message/byte validation. Its original request/date/hash/source/file binding
must match; this is authoritative original intake evidence, not completion
success text. A legacy row with `file_id: null` identifies an existing request
but cannot invent that proof or authorize another upload.

The original file-read path is also retained: `source_result` contains canonical
`bytes_base64` from the actual downloaded file plus `evidence` in the existing
`verifyControlUpload` format (`complete`, `read_context`, `message`, `file`).
Search snippets, regenerated equivalent JSON and a separate share message are
insufficient. `close` exits the bridge.

## Upload outcomes

The journal pins exact bytes/hash, date, request, ticket file ID and source
timestamp. A date cannot be replaced by another request or revision. Every
external write intent commits before dispatch. Death, timeout, invalid results
and uncertain responses keep the original operation unknown. Reads may resolve
its effect, but an empty inspection never reauthorizes that unknown write.

Completion requires HTTP 200, successful curl exit and exact uploaded byte
count for the original POST. Completion acknowledgement alone is not intake
proof. Delivery additionally needs original Publisher/scheduler binding,
complete phase, every actual part sent and the original poster receipt.

HTTP 000 is not proof that a POST did not execute. Numeric diagnostics retain
curl exit, HTTP status, connection count, TLS/connect/start-transfer timing,
upload/download/header byte counts, verification result and response hash.
They exclude URLs, tokens, arbitrary stderr, headers and response bodies. Only
fixed direct-curl DNS/connect errors 6/7 with zero connections, relevant timings,
upload/download/header bytes, HTTP status and redirects permit the same POST
again. Timeouts, TLS errors, resets and zero upload alone remain unknown.

Proven non-execution uses durable exponential backoff from 30 seconds to 15
minutes, with at most one upload write per tick and no lifetime attempt/age
cutoff. A retry preserves the same ticket and bytes. No ticket or complete retry
is inferred from a generic native-tool error.

## Validation and activation boundary

Tests use synthetic local ledgers, native results modeled on the observed
production formatter, and stub curl processes. They do not upload/send to live
Slack/WeCom or change today's completed report. The native inspect command and
scheduled socket inspection must be installed separately before activation.
No current automation was changed, and end-to-end live operation or the user's
local publication-review requirements have not been verified by these tests.

## Explicit recovery before any upload could execute

The exceptional `authorize_ticket_recovery` bridge command is **not** a normal
retry, an automatic ticket refresh or permission to replay unknown operations.
It requires a separate explicit operator authorization. Its input is exactly
`type` plus `authorization`, with `authorization_reference`, original `file_id`,
original `url_sha256` and original `bundle_sha256`. The reference is a non-secret
identifier for the operator's approval, not an assertion that downstream is empty.

Use the same original config, bundle, journal and `runner.lock`. The bridge
requires an inherited Linux FLOCK WRITE on that actual lock inode, verified via
`/proc/self/fdinfo`; a different lock or a caller boolean is insufficient. Stop
and verify the original executor before launching this bridge under that lock.
The new runtime must be reviewed and verified before changing the installed
runtime; never edit the fixed old release or reset the journal.

Before authorization, obtain a fresh authenticated native inspection in this
bridge. Recovery accepts exactly one confirmed original ticket, at least one
original POST, and **every** original POST must independently reproduce the
fixed direct-curl non-execution classification. Any complete intent, unknown or
successful POST, unknown ticket, previously observed intake, downstream date
claim, changed bundle or stale/consumed inspection blocks. `file_deleted` or an
empty Slack search alone never authorizes recovery.

The transaction appends an immutable audit retaining the original detail and
all original operation records, keeps exact request/date/edition/bundle bytes,
and consumes the current inspection. It atomically selects one successor upload
namespace. Original operation rows and inspect rows are retained. SQL triggers
fence original dispatch/receipt writes and immutable bindings; the old CLI also
rejects the additional schema at startup. No external write occurs in this
transaction. A **new** native inspection is required before each successor
write, exactly as in the regular flow. A late old inspect cannot replenish it.

Only one explicit recovery is supported per original request. The successor
uses `recovery_ticket`, `recovery_post`, `recovery_complete` journal operations.
A crash or unknown ticket/POST/completion is reconciled, not replaced again.
`summary` includes both historical `operations` and `active_operations` plus
`recovery_id`, so preserved failures are not mistaken for current progress.
The original request ID and exact bundle remain unchanged through Publisher and
T4; publication and actual text/image delivery still need independent proofs.

The recovery POST uses the already configured managed HTTPS proxy, passing only
the adapter's proxy/CA environment allowlist. There is no direct fallback, TLS
bypass, redirect or curl retry. Its safe journal marker is
`producer_curl_managed_proxy_v1`. Any non-success through this proxy is unknown,
including DNS/connect errors and zero bytes; direct-curl non-execution evidence
cannot be inferred for proxy attempts. The signed URL remains memory-only. This
repair does not claim recovery from arbitrary process loss without the actual
original ticket result, nor does it grant permission to persist secret tickets.

For subsequent normally admitted reports in an environment that requires its
managed proxy, launch the reviewed CLI with `--serve-managed-proxy` in place of
`--serve`. No config/journal replacement is needed. Default `--serve` retains the
original direct mode for compatible environments. Both modes share all original
identity, admission and receipt checks. This flag does not authorize recovery
or relax unknown-operation fences.


## Opt-in abandoned-ticket recovery after process loss

A restart cannot recover a signed URL that existed only in the dead process,
including a native result lost before it reached the bridge. This optional
policy avoids storing that capability at all. It can retire an unused upload
slot and allocate a distinct successor, preserving the original unknown ticket
operation unchanged. It is not replay, inferred ticket failure, proof that the
original allocation did not execute, or a general retry of unknown writes.
The signed URL and raw native ticket result still remain memory-only.

Install only after reviewing this runtime and approving the narrow policy. Stop
the old runner first and hold the same existing original lock. Do not initialize,
copy, reset or replace the journal, lock or bundle:

```sh
flock -n -E 73 "$PRIVATE_DIR/runner.lock" \
  node "$REPO/scripts/producer-upload-cli.mjs" "$PRIVATE_DIR/config.json" \
  --enable-restart-recovery YOUR_NON_SECRET_AUTHORIZATION_REFERENCE
```

This explicit offline command does not read the bundle, create a ticket, upload,
or send a native message. It adds immutable `producer_restart_policy` and
`producer_restart_audit` schemas and their SQL fences to the existing initialized
native-mode journal. The policy binds its authorization reference, scope hash,
original journal device/inode and original lock device/inode. Repeated installation
is rejected rather than resetting the policy. Normal serve never migrates a
journal. The earlier runtime rejects this added schema before opening a mutable
SQLite connection; do not use an old runtime to roll back an installed policy.

Continue the same private PTY/flock launcher with `--serve-managed-proxy`.
No operator-config fields, credentials, security settings, listeners, remote
services or file sharing are added. Plain `--serve`, missing flock, changed lock,
or a copied/replaced journal fail closed before mutable startup. Journal/lock
identity is checked again before every retirement attempt. This is deliberate:
a copied backup or replacement cloud workspace is not the original live journal.

At startup the adapter captures only the active ticket already in the journal.
A new ticket issued by this same process cannot be automatically retired after a
tool error. It must remain unknown until genuine process restart and inspection.
A restored original ticket is still preferred and avoids retirement. For an
unavailable startup ticket, retirement requires all of the following:

- A minimum five-minute cooldown from the original ticket intent, also honoring
  every recorded POST's existing backoff. This is durable across repeated restarts,
  bounds repeated slot allocations, and has no arbitrary lifetime retry cutoff.
- No complete intent anywhere in that request's history, even acknowledged ones.
- No POST intent, or every historical POST independently marked `not_executed`
  with its original matching ticket/hash and the strict direct-curl DNS/connect
  evidence. Unknown/successful POSTs, missing/malformed receipts and every managed
  proxy non-success block recovery, including a proxy DNS error with zero bytes.
- A complete, fresh, authenticated empty Publisher/scheduler receipt from a new
  native query created after this process started. A prior process's query cannot
  qualify even when its timestamp is equal or its receipt is still fresh.

Retirement atomically consumes that one-use read, appends an immutable audit of
all original operations and request/date/hash/scope, and records per-stage
attempt high-water marks. It does not modify any old operation or fabricate its
receipt. A **separate new authenticated inspection** is required before allocating
the successor. The successor retains the exact journaled bundle bytes, original
request/date and downstream identity. Its ticket/POST/complete operations use new
operation IDs and monotonically increasing attempt numbers. Late native results
for abandoned operations cannot update the successor. `operation_history` exposes
the retained attempts. The existing `operations` and `active_operations` fields
continue reporting only the latest attempt of each stage, so earlier retry
failures cannot hide its current success. Existing #76 explicit
recovery audits and their original operation rows remain unchanged.

A crash after retirement but before successor allocation resumes that unissued
generation, rather than retiring it again. A later crash after another unused
ticket may create another audited generation under the same conditions. No secret
sidecar, key, raw tool result, URL, new journal or alternate Publisher path exists.
Abandoned remote upload slots are not deleted automatically; their cleanup/expiry
is controlled by Slack, and an expired/rejected POST is not assumed unexecuted.

There is still no safe automatic replay after an unknown POST or complete,
including a crash after the external effect but before its result was committed.
The runner only reconciles the original file/intake/delivery through authenticated
reads. A confirmed POST can continue to its original completion without a signed
URL; a lost completion acknowledgement is not permission to complete again.
Tests cover these hard-crash boundaries with synthetic journals, native formatted
receipts and stub curl only; they do not certify any production send or deployment.
