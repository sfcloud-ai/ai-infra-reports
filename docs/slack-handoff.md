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

By default, `sender_user_id` pins a human sender and bot/App messages are rejected.
For an App-based cloud producer, explicitly configure both `sender_bot_id` and
`sender_app_id` alongside its `sender_user_id`. All three identities must match
the authenticated message; a human message, another App, an incomplete identity,
or the publisher's own bot cannot substitute for that sender. Native file shares
and bot messages with a verified native file are accepted in this mode.

Obtain all sender IDs from trusted Slack metadata, never from a display name or
the report payload. Membership alone does not prove the upload identity; if the
connector does not expose `app_id`, leave App-mode activation blocked until it
is verified. A sender identity change is also a state-store identity change and
requires reconciliation. The producer App must be explicitly invited to the
control channel; adding it or the publisher bot requires separate authorization.
The read-only `!ai-brief` control protocol remains independent.

Some user-authorized connectors upload as the connected human, attach an App ID
without a bot ID, render a separate attribution block, and store JSON as a native
Slack snippet. This is a distinct opt-in mode: set `sender_user_app_id` and
`sender_attribution_text` alongside `sender_user_id`, and omit both bot-sender
fields. For example, a verified connector might use App `AEXAMPLE` and the exact
attribution `*Sent using* <@UCONNECTOR>`. Obtain the values from authenticated
message metadata and verify harmless uploads in the actual scheduled runtime.
Do not copy display names, assume that desktop and scheduled tools share an
identity, or activate from an offline fixture alone.

This mode pins the human and App IDs, rejects bot identities, and requires the
single visible command plus the exact attribution in both fallback text and
native blocks. It accepts only the verified native file-share shape; arbitrary
attachments, additional visible content, edits and thread replies are rejected.
The JSON may be `hosted` or `snippet`, but its owner and workspace, private share
timestamp, filename, size, Slack download origin and payload hash remain checked.
An editable snippet is not trusted after upload: changed bytes fail the bound
digest before admission. Other sender modes still reject snippets and connector
attribution. The attribution is a format check, never a substitute for App identity.

Switching sender modes changes the durable state identity. Reconcile and retain
existing state before provisioning a separately scoped store; do not delete or
reset it to retry. Leave consumption disabled until the real transport and the
complete adapter validation pass. These optional fields do not change the
publisher's OAuth permissions, installation scope or final-notification contract.

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
is not suitable. The reviewable [publisher manifest](../deployment/slack-publisher.manifest.json)
contains only those four bot scopes, with no user scopes, event subscriptions,
webhooks or socket mode. It is an offline template, not an installed App;
installation and creation/storage of its bot token require separate approval.
Slack API documentation: [history](https://docs.slack.dev/reference/methods/conversations.history/),
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

For an App producer, add the two explicit fields to that config (example IDs only):

```json
{
  "sender_user_id": "UPRODUCERBOT",
  "sender_bot_id": "BPRODUCERBOT",
  "sender_app_id": "APRODUCER"
}
```

This fragment replaces `sender_user_id` and supplements the complete config;
it does not replace the other required fields. Then run one approved tick:

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

After GitHub reports the pinned PR as merged, the reader obtains its SHA from
the repository's own [`merged` timeline event](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#merged).
It requires a complete, bounded page (at most 100 events), exactly one merge
event, a commit URL in this repository, and matching merge time and actor from
the PR response. A legacy `merge_commit_sha`, when present, must agree. Missing,
conflicting or paginated evidence stops the read without changing durable state;
the reader never substitutes the current main tip or a commit mentioned in text.
The worker then independently checks both Git commit objects, identical trees,
and each commit's sole parent against the bundle's pinned base.

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

A job stopped at `pr_open` solely because the PR response omitted its legacy
merge SHA needs no reset or replacement request. Preserve the database and
external evidence, validate the corrected reader, and resume only the original
job after reviewing its phase and the deployment identity. A code deployment
that changes the Pages manifest commit can still make an older report's exact
publication check fail; this fix does not relax that check or authorize a replay.

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
3. Recheck Pages before notifying. Send the article-list delivery format (date header, every article title and its
   verified article URL, no summary text, and one native landscape poster attachment) through the existing cloud
   Slack identity to its already approved final destination. This preserves the
   relay's sender filter. Do not redirect delivery to a channel based on its name.
4. Validate the actual returned Slack message with the existing brief project's
   `prepare_article_notice_preview` / `check_received_notice` contract and the
   generated `/reports/YYYY-MM-DD/rN/notice.json`. The manifest binds the complete
   ordered title/URL list, raw report hash, poster hash and publication commit. Keep its timestamp with the report version,
   commit, URL, poster digest and destination. A send timeout means read and
   reconcile, never post a fresh message blindly. WeCom remains separately
   verified by the relay receipt.

The optional [durable notification protocol](durable-notifications.md) reserves
each edition and recovers uncertain control replies without reposting. It is
disabled unless a destination and fixed activation boundary are explicitly
configured. The cloud sender still must adopt that protocol, verify its actual
DM, and reconcile unknown sends without retrying. It does not establish WeCom
delivery from a sender's assertion, change a schedule, or guarantee 08:00 delivery.

The same guide provides a readiness migration that stages a verified copy of a
quiescent database, preserving completed reports and deduplication. It never
changes the active config or deletes the source state.

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
