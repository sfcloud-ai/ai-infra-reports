# Independent Publisher and delivery watchdog

The Publisher now keeps a bounded, redacted diagnostic history in each original
job's `detail.recovery`. It records a trusted stage, error code, HTTP status and
provider request ID when available, plus attempt time and retry deadline. Raw
exception messages, request bodies and credentials are not retained. Temporary
read/pre-write failures back off from two seconds to five minutes without a
total-age cutoff. GitHub rate limits retain the later of the provider's retry
or reset deadline and exponential backoff, including across restarts and public
PR, merge-event, commit and publication-source reads. Headerless secondary limits are recognized
from a bounded error discriminator without retaining the response body and
wait at least one minute. A retry that becomes due during other work wakes
promptly. Explicit pre-proposal permission/validation failures remain blocked.
When transient pre-write failure coincides with unconfirmed token revocation,
the original job waits for the validated token expiry plus clock-skew allowance
before another proposal attempt. No credential is persisted or blindly revoked
again; cleanup waiting is separate from provider quota deadlines. Public
reconciliation and progression of an existing PR continue during that wait;
confirmed absence still cannot permit a new proposal before token expiry.
The one-shot CLI returns a nonzero exit code for an unhealthy tick, including
durable failures in backoff, while preserving structured diagnostics.
Slack reconciliation also retains its absolute retry deadline across restarts.
Report recovery consults method cooldowns across all original job diagnostics.
Later and newly admitted reports cannot bypass the same app/workspace quota;
unrelated methods continue, and a blocked post is deferred before write intent.
GitHub public reads, Producer-token requests and App authentication use separate
shared cooldown scopes, so exhaustion of one quota does not stop another.
Provider deadlines also live in the owner-only, identity-bound SQLite database
`<publisher state_dir>/provider-cooldowns/cooldowns.sqlite`. Publisher and watchdog
read the same Slack method deadlines before requests, including preflight,
intake and receipts. Short transactions retain the longest deadline across
processes and restarts, without holding the Publisher tick lock. Notification
verification uses the same GitHub cooldown guard as report verification and
persists throttling even when no report job is currently advancing. Separate
alert and report intent ledgers preserve their original recovery semantics.
Notice and status replies check local post cooldowns before recording send
intent, retaining their original prepared response instead of falsely marking
an unattempted post as unknown.
Authenticated status queries are queued durably before querying the scheduler;
their unsent responses survive long cooldowns and the 15-minute intake window.

A lost proposal response is reconciled with public repository reads against
the original deterministic branch, exact tree, base and unique PR. A matching
PR resumes the same job; verified absence or an exact existing branch permits
the original proposal to continue. An unavailable read, conflicting tree,
ambiguous PR or changed base does not authorize another write. Public
reconciliation does not mint another installation token. A lost Slack
publication receipt is read back by exact original thread/text and never
reposted automatically.
The current [Slack method reference](https://docs.slack.dev/reference/methods/conversations.replies/)
lists bot-token `groups:history` support; the dedicated bot already has that
scope. Permission errors still fail closed and do not authorize a resend.

Linux `flock` serializes complete production ticks, including separate CLI
invocations, so a live mutation cannot be mistaken for an abandoned one.
The two local recovery authorization commands use the same exclusive lock
through ledger closure, including close-time WAL checkpoints. Watchdog scope
identity ignores JSON object key order, including nested configuration, while
preserving array order and actual identity changes.
Completed publication phases advance within one bounded tick.
Scheduling and health scans read metadata only; report bytes are loaded only
for the bounded set of selected jobs, so backlog size cannot multiply payload
memory during recovery. Ref-creation conflict reconciliation treats transient
Git snapshot failures as retryable reads of the original deterministic branch.
Job failures, intake failures and the legacy notice lane no longer stop unrelated admitted
reports or scheduler status work. Failed ticks write an unhealthy heartbeat
and remain under the serial supervisor; graceful termination still drains the
current tick. Fatal process/storage failures remain visible to the independent
watchdog rather than being blindly restarted across an unknown mutation.

The plain status receipt includes `publisher_phase`, the original local bundle
hash/source timestamp, safe diagnostics and any retry deadline. Scheduler
`not_found` does not mean Publisher admission was absent. Image receipts are
included when available, and completion now requires the original scheduled
poster's successful receipt as well as all part counts.

`scripts/publisher-watchdog.mjs` is an optional, independently scheduled check.
It does not create a report, advance a publication, admit a scheduled notice,
send a formal message, or update the Publisher/relay ledgers. Its live mode may
post a diagnostic alert to the Publisher's existing private control channel.
The same authenticated bot and restricted scopes are reused; no new credential,
destination, or message-selected command is accepted.

The health check compares the systemd unit's active state, PID and release
directory with the running process and its health record. A stale
`healthy: true` record is insufficient. Failure to read systemd or `/proc` is
reported as an unavailable observation, not proof that the process is dead.

From 08:00 Asia/Shanghai, plus the configured grace period, the checker reads
the original day's report binding from the Publisher database and calls only
the scheduler's `status` action. Success requires the original request ID,
report date, merge commit and bundle hash, `status=sent`, `phase=complete`, all
parts confirmed and the scheduled poster confirmed. A Pages or Slack control
receipt does not satisfy this check. An absent report, missing admission,
unavailable status or incomplete/unknown part produces a distinct diagnostic.
The default one-minute grace avoids an alarm while the normal 08:00 delivery
finishes. It does not change the delivery deadline.

If SQLite cannot open a read-only WAL database after its writer closes, the
checker takes the existing Publisher lock in shared mode, copies the database
and any WAL into a private temporary directory, then releases the lock before
querying the copy. SQLite may rebuild sidecars only in that temporary directory,
which is removed afterward. A busy or missing Publisher lock leaves the check
unavailable; it never permits an inconsistent copy or writes to the report ledger.

## Installation and verification

The supplied systemd units and JSON are templates; merging them does not
install or enable a service. Install the complete reviewed release and its
dependencies at an administrator-pinned path separate from the running
Publisher release. Replace the template Node and script paths with their
actual immutable locations. Use the existing Publisher service account and
unit name. That account must be able to read its own health/database files,
`systemctl show`, `/proc/<MainPID>/cwd`, and the existing scheduler socket.

Create the independent watchdog state directory with mode `0700`, owned by
the service account. Store its configuration in an owner-only directory with
mode `0600`. Its `state_dir` must differ from the Publisher state directory.
The watchdog journal cannot be shared across identities, units or scheduler
configurations. Do not reset it to retry an uncertain alert.
Create `<publisher state_dir>/provider-cooldowns` with mode `0700` and the same
service owner before enabling the watchdog; Publisher also creates it on startup.
Set the watchdog's second `ReadWritePaths` entry to that exact directory. This
grants write access only to shared quota metadata and SQLite sidecars, while
the Publisher report ledger and configuration stay read-only in the watchdog.
Do not give the watchdog write access to the whole Publisher state directory.

First run the script as that account with the absolute config path and
`--check`. This mode does not open the alert journal, contact Slack, write a
message or call any scheduling mutation. Its JSON lists the actual checks and
their observation failures. In an isolated fixture, stop the fixture
Publisher, leave an old healthy file and verify `publisher_not_running` and
`heartbeat_stale`; verify that the watchdog remains independently runnable.
Check a missing or incomplete due fixture and a completed text-plus-image
fixture. Do not use a real report admission or resend as a monitoring test.

Once the reviewed deployment is authorized, install the fixed service/timer
and enable the timer. It runs at most one service instance at a time, normally
one minute after the previous run finishes. Inspect journal output and the
timer's next run after activation. Test delivery alarms in a separate fixture;
do not intentionally break or replay a completed production report.

## Alert guarantees and limits

Each continuing incident has one durable alert intent. A SQLite compare-and-set
claims it before posting. Allowlisted definitive Slack rejection or rate limiting
can retry with bounded exponential backoff. A timeout, malformed response, server error,
or interrupted post becomes unknown. Later runs only read the original alert's
exact text and verified bot identity; they never repost an absent/ambiguous
unknown alert. Resolving a condition closes that incident; a later recurrence
can create a new incident. Clearing a condition cancels a still-unsent alert.
Slack `internal_error`, `fatal_error`, and unrecognized API errors remain unknown
because they do not prove that posting failed before any message was created.
The watchdog shares Slack retry deadlines per method with Publisher, across
alerts, reports and restarts. Throttled history reconciliation cannot query another
alert, while a different method remains independently available. A rejected
post also delays new incidents until its response-based deadline.
See [GitHub rate-limit handling](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
and [Slack message error semantics](https://docs.slack.dev/reference/methods/chat.postmessage#errors).

Alert messages deliberately do not use the report command prefix. They cannot
enter the publication intake. The alert ledger is separate from all report and
WeCom state. No provider response bodies, credentials or arbitrary exception
messages are included in alerts or process errors.

The timer and Slack provider are still dependencies. If Slack authentication
or the checker itself fails, the oneshot exits nonzero with a fixed diagnostic
for host-level monitoring. It cannot guarantee an out-of-band Slack alert when
Slack is unavailable. Unknown alert outcomes remain in the independent journal
for reconciliation instead of being silently reset. Live checks also exit
nonzero while any alert remains pending or unconfirmed, including rejection
backoff and absent or unavailable read-only reconciliation. The included templates
do not alter host-level monitoring, credentials or permissions.

## Correction audit and the fixed updater

An authorized correction made before publication can retain the original
request bytes and metadata in `job_replacement_audit`. The updater accepts only
that exact audited schema and includes every original byte in its state
snapshot. Both old and new release compatibility probes must preserve the
table and its contents unchanged. Historical `original_phase` values do not
represent new pending sends. Do not delete the audit table or its rows to get
past a deployment gate.

`deployment/publisher_cd.py` is a fixed administrator-controlled component.
Merging its changes does not automatically replace the installed updater.
Install its reviewed compatibility fix through the same reviewed control
update chain before attempting a release against a ledger containing this
audit table. Preserve the existing permissions, service bindings and audit
evidence; an unsupported schema is a deployment blocker, not permission to
rewrite the ledger.
