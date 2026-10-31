# Slack report handoff

This is an opt-in publisher adapter, not an enabled deployment. It does not create
credentials, join channels, modify schedules, change repository rules, merge PRs,
or send the final morning notification. Run the offline tests with `npm test`.
The existing `proposeWithApp` and report validators remain the only GitHub writer.

## Protocol and producer

The producer first reads the exact report repository `main` SHA and the exact
prompt repository commit it used. Build one edition directory under `reports/`
with report metadata, Markdown articles, declared PNG/JPEG images and a poster.
The poster must be at most 2,000,000 bytes. A bundle contains at most 64 files,
6 MiB decoded and 8 MiB encoded. `reports/index.json` is rebuilt by the publisher.

Offline packing (Node 24.22.2; the bundle root contains `reports/`):

```sh
node scripts/report-handoff.mjs BUNDLE_ROOT REQUEST_ID MAIN_SHA PROMPT_SHA > ai-brief-bundle.json
sha256sum ai-brief-bundle.json
```

Upload that file using the already authorized producer's Slack identity, with
this exact initial comment as a new top-level message in the approved private
control channel:

```text
!ai-report publish REQUEST_ID SHA256_OF_UPLOADED_BYTES
```

Request IDs are 8–80 lower-case letters/digits/hyphens, beginning with a letter
or digit. The JSON envelope contains only `schema_version: "1.0"`, `request_id`,
`repository: "sfcloud-ai/ai-infra-reports"`, `expected_base_sha`,
`prompt_commit_sha`, and `files`. Every file has `path`, `sha256` and canonical
`base64`. There are no URLs, commands, credentials, branch names or notification
destinations supplied by the payload. A new ID or message timestamp is not an
automatic retry mechanism; the same ID with different bytes or source message
is rejected. Do not edit, thread or repost the original command.

The first adapter deliberately accepts only an explicitly pinned **human Slack
user identity**. A cloud connector's actual upload identity must be observed in
an approved trial; channel membership does not prove the sender identity. If
uploads instead come from an App/bot identity, do not broaden the allowlist:
that identity requires a separately reviewed adapter change. The read-only
`!ai-brief` control protocol is independent and remains untouched.

## Independent publisher process

Provisioning and activation require separate authorization. The intended runtime
is a dedicated, non-root Linux user/container with Node 24.22.2, Git and this
reviewed checkout, no GPU, no public inbound port and no mount of the relay's
credentials. Keep code read-only. All config, token and private-key parent
directories must be absolute, not symlinked, owned by the service UID, mode 0700;
files must be regular, single-linked, owned by that UID and mode 0600. The state
directory must also be private 0700, on a local filesystem supporting SQLite
locking and durable writes. It contains report data and operation state, never
tokens. Back it up consistently; do not delete it to retry.

The dedicated Slack bot needs exactly `groups:read`, `groups:history`,
`files:read`, `chat:write`, and membership only in the approved private control
channel. Preflight checks the workspace, bot user and bot ID, exact scopes,
channel privacy/membership and absence of sharing. The existing DM relay token
is not suitable. Slack API documentation: [history](https://docs.slack.dev/reference/methods/conversations.history/),
[file information](https://docs.slack.dev/reference/methods/files.info/),
[thread messages](https://docs.slack.dev/reference/methods/chat.postMessage/).

Example config, with deliberately fictitious IDs:

```json
{
  "team_id": "TEXAMPLE",
  "channel_id": "CEXAMPLE",
  "sender_user_id": "UPRODUCER",
  "bot_user_id": "UPUBLISHER",
  "bot_id": "BPUBLISHER",
  "producer_app_id": 100,
  "merger_app_id": 101,
  "slack_token_file": "/var/lib/report-publisher/secrets/slack-token",
  "producer_key_file": "/var/lib/report-publisher/secrets/producer.pem",
  "state_dir": "/var/lib/report-publisher/state",
  "ready_for_review": false
}
```

After the credentials, scope, service and one real publication have been approved:

```sh
node scripts/run-handoff.mjs /var/lib/report-publisher/config/publisher.json --live
```

This command performs **one tick**. It is not a service installer. A separately
approved supervisor must serialize ticks and wait at least 120 seconds between
successful ticks. Stop on a nonzero exit and inspect the phase before resuming;
do not use unconditional restart-on-failure. In particular, honor API rate limits
before retrying reads. The adapter makes no automatic HTTP retries. Channel
history is a complete, at-most-15-message window from the past 15 minutes; an
incomplete page stops intake rather than skipping unseen commands. Outages past
that window require explicit recovery, not replay of old commands. One pending
request progresses per tick, so a waiting/failed older request must be reconciled
before later work can advance. Public GitHub reads use no authentication token.

The Producer App key is read only for the proposal. Its existing short-lived
installation token is narrowed to this repository and revoked by the existing
token wrapper. The Merger App's ID is used to enforce independent identities;
the publisher never receives its private key. `ready_for_review: false` creates
a draft PR. The first trial can be reviewed, marked ready and merged manually.
Enabling ready PRs or the existing automated merge workflow is a separate
activation decision, not part of running these tests.

## State and recovery

SQLite records the immutable bundle bytes, digest, request ID and Slack source
timestamp before any GitHub mutation. Compare-and-set transitions prevent
concurrent ticks from claiming the same external write. The store is bound to
the configured workspace/channel/sender/bot/App identities and readiness mode;
changing them requires reconciliation. Capacity is 1,000 requests and requires
an explicit retention/archive procedure before it is exhausted.

| Phase | Meaning / next step |
| --- | --- |
| `received` | Valid transport stored; archive/history checks run again in the proposer. |
| `proposing` / `proposal_unknown` | A process interruption or write failure might have created objects, a branch or a PR. Inspect the deterministic branch and exact contents, plus token revocation, before operator recovery. Never reset blindly. |
| `pr_open` | Poll only; wait for merge. Closed, changed, foreign or wrong-base PRs stop. |
| `merged` | Require the exact proposal tree, one parent equal to the pinned main base, and an actual merged PR; this first version supports squash merges only. |
| `verified` | Manifest has exact merge SHA and edition; the edition and every article have the expected marker; every declared image matches its digest. Repeat these checks immediately before the receipt. |
| `sending` / `receipt_unknown` | A receipt may already exist. Read the original thread and reconcile exact request/hash/commit and publisher identity. Never automatically resend. |
| `receipt_sent` | Slack acknowledged the private control-thread receipt. It does not prove a final notification or WeCom delivery. |

No automatic database reset or force-retry command is provided. Recovery must
record the observed external state before an operator changes a stalled phase.
A stale base or intervening deployment needs a fresh explicit decision; the
worker does not rebase, replace reports, or accept a newer deployment as proof.

## Cloud task completion contract

The publisher replies only to the source control thread with
`!ai-report receipt ` followed by JSON. The receipt includes `status: published`,
request ID, bundle digest, exact merge commit, edition, verified public URL,
poster digest, PR URL and verification time. `delivery_allowed` remains false:
publication and notification are distinct receipts.

The scheduled cloud task still needs a separately authorized prompt update:

1. Produce and validate the report bundle using pinned prompts and current main;
   upload it to the explicitly approved control channel and retain its file ID,
   source timestamp, request ID and digest.
2. Read the actual control thread. Authenticate the pinned publisher bot's
   identity and match **all** receipt identities, including poster digest and
   exact edition URL. Never trust a quoted JSON receipt or arbitrary URL.
3. Recheck Pages before notifying. Send the existing delivery format (title,
   verified day URL and native poster attachment) through the existing cloud
   Slack identity to its already approved final destination. This preserves the
   relay's sender filter. Do not redirect delivery to a channel based on its name.
4. Validate the actual returned Slack message with the existing brief project's
   `check_received_notice` contract. Keep its timestamp with the report version,
   commit, URL, poster digest and destination. A send timeout means read and
   reconcile, never post a fresh message blindly. WeCom remains separately
   verified by the relay receipt.

The worker does not own a durable final-notification outbox. If the cloud run
ends before the publication receipt arrives, manual continuation is required;
unattended recovery needs an additional approved task/outbox integration.
Consequently this adapter alone is not a guarantee of automatic morning delivery.

## Activation checks requiring separate decisions

- Confirm the actual cloud upload sender; install/invite a narrowly scoped Slack
  publisher bot to the one control channel and store its token privately.
- Generate and privately store the Producer App key on the publisher; deploy the
  reviewed runtime and serialized supervisor. Neither is done by this change.
- Authorize one real bundle upload, PR and public report, then inspect real Slack
  file-sharing metadata and download behavior as well as GitHub permissions.
- Update the existing morning task's handoff/completion instructions and test its
  duration and unknown-send recovery. Keep the final destination unchanged unless
  explicitly requested.
- Only for unattended merging: separately configure the Merger key/identity,
  verify the live negative permission cases, then authorize its enable switch.
