# Research recovery from the original host

The cloud execution is disposable. The Publisher's original SQLite database
owns the exact plan, input hashes, selected checkpoints, owner lease, operation
intents, attempts, elapsed charges and publication permit. New research outputs
use [research checkpoints](research-archive.md). Fixed public inputs use Git
references in `research_plan_v3`; they are not uploaded as checkpoints. A cloud directory is a cache;
its disappearance never means that a previous request did not run.

Deploy reviewed code and its matching CD controller, then install
`research_control` with `protocol: "repository_inputs_v1"` explicitly under the original Publisher lock with database
and configuration backups. Its UUID generation, activation timestamp and first
report date are immutable. `installResearchControl` requires the archive policy
and refuses dates with an existing publication. Start with the next unused date;
preserve older missing-history evidence separately. Verify two fresh healthy
ticks. Runtime never initializes or replaces this authority. Installing it does
not require an input archive. Live native output-transport acceptance remains
necessary before schedule activation; an input-reference test does not prove it.
The host client is the single daily research/publication entry. Retired cloud
guards, Producer upload CLIs, archive-based plans and unpermitted stage/submit
commands cannot start work. Before activation, keep the service available for
historical queries and completion of already admitted jobs; new research waits
for the original host policy. No legacy fallback is enabled during cutover.

An already installed authority retains its original configuration and policy
while the reviewed runtime and matching CD controller are deployed. That binding
allows historical `status`, `upload_status` and `receipt` observations only; it
cannot claim, renew, reserve, settle, checkpoint or permit research. CD accepts
either exact policy shape and still requires byte-identical ledger snapshots
before and after its isolated probe. It never performs this migration itself.
Before this cutover, finish or reconcile original staged submissions while their
original runtime can still complete them. The migration refuses unadmitted bundles
and unfinished submission events without changing any row; it cannot strand them
behind the v2 execution fence or label an unpublished bundle as admitted.

For an existing installation, stop the Publisher and hold its original lock.
Back up the database and configuration together. Add only
`protocol: "repository_inputs_v1"` to a copy of the original configuration and
call `migrateResearchControl(db, newConfig, evidenceReference)` with the reviewed
runtime. This transaction preserves every generation, activation date, archive
binding, run, plan byte, attempt, budget, unknown operation and receipt; it changes
only the authority policy and retains the original installation reference in its
migration evidence. Atomically install the matching configuration before restart.
If interrupted, reconcile the policy against the two saved configurations under
the same lock; do not rerun installation or reset any ledger. A repeated or
mismatched migration is refused. Verify the original inode, historical observations
and two fresh healthy ticks before admitting a v3 day. Historical v2 plans remain
read-only after migration as well.

An original v2 dispatch receipt in `sending` or `unknown` remains a blocking
unknown before migration, because the old release is still a possible CD
rollback. Such installations require the explicit stopped-service maintenance
cutover above; ordinary CD cannot bypass its healthy-service prerequisite.
After the protocol binding is durably migrated, those exact v2 unknowns appear
as `frozen_control` warnings. Their events, operations and charged budgets stay
unchanged and queryable. Unknown v3 dispatches still block health. The CD probe
checks the configuration against the installed authority binding; after migration,
even an empty authority rejects an old runtime before opening the ledger.

## Starting or resuming a day

1. Derive the original `morning-YYYYMMDD-r1` identity. Send a fresh `status`
   command and authenticate the native Publisher receipt. A found run supplies
   the original plan bytes, owner, epoch, revision, lease and charged budget.
   Follow `next_offset` for operations; pages contain one operation so the plan
   and source URL still fit one bounded reply.
2. For a v3 plan, read the five public prompt files and report index from their
   original full Git commits, verifying every byte hash. Recover needed new
   research results from the host's checkpoint chain and verify their hashes.
   Journals and attempts are never reconstructed from a cloud directory.
3. If no run exists on an activated unused date, create the plan below and
   `claim` it. An expired run is claimed with its original plan bytes, current
   epoch and revision, and the new execution's owner UUID. A live competing
   owner is refused. Claims preserve the first start time and every attempt.
4. After verifying repository inputs, send `inputs` with `{}` for a v3 plan.
   The host stores the canonical reference-list hash; this is not an archive
   hash and does not select or reset a result checkpoint. Later `checkpoint`
   selections name already stored new-output archives. Inputs cannot change.
5. Reserve source/model operations before executing them. Store their original
   outputs in private checkpoints, then `settle` with the archive/file hashes
   and actual elapsed seconds. A missing duration stays `null` and retains the
   full reservation; a real overrun is retained and charged. Read-only receipt
   recovery cannot dispatch an operation.

The original UTF-8 plan has exactly these fields:

```json
{
  "schema_version": "research_plan_v3",
  "request_id": "morning-20261112-r1",
  "report_date": "2026-11-12",
  "prompt_commit_sha": "EXACT_PROMPT_COMMIT",
  "reports_commit_sha": "EXACT_REPORT_BASE_COMMIT",
  "files": {
    "ai_brief/resources/prompts/audit.md": "EXACT_ORIGINAL_FILE_SHA256",
    "ai_brief/resources/prompts/delivery.md": "EXACT_ORIGINAL_FILE_SHA256",
    "ai_brief/resources/prompts/editor.md": "EXACT_ORIGINAL_FILE_SHA256",
    "ai_brief/resources/prompts/research.md": "EXACT_ORIGINAL_FILE_SHA256",
    "ai_brief/resources/prompts/sources.md": "EXACT_ORIGINAL_FILE_SHA256",
    "reports/index.json": "EXACT_ORIGINAL_FILE_SHA256"
  },
  "model_stages": ["editor", "review"],
  "limits": {
    "max_attempts_per_source": 2,
    "max_attempts_per_model": 1,
    "operation_timeout_seconds": 180,
    "total_budget_seconds": 3600
  }
}
```

Hashes in examples are placeholders. V3 accepts exactly these six paths:
prompts come from `sfcloud-ai/ai-infra-brief` at `prompt_commit_sha`, the index
from `sfcloud-ai/ai-infra-reports` at `reports_commit_sha`. URLs are constructed
from this allowlist; redirects, missing files and hash mismatches fail. There is
no fallback to `main` or a previous cache. Each new day reads its pinned public
repository inputs again. The host accepts up to 12 model stages and cannot
increase the budget ceilings.
The research deadline remains first claim plus total budget across takeovers.
Native transport consumes distinct single-dispatch intents, without charging
research/model time. Native provider cooldowns remain enforced.

Pipe the original plan recovered from the authenticated host receipt to:

```text
node scripts/research-inputs-cli.mjs /private/unused-disposable-cache
```

It fetches through the configured managed HTTPS proxy with normal TLS checks,
no direct fallback or provider retries, and verifies all six files before
creating the cache. Prompt bytes are materialized as `prompts/*.md` and the
index as `history.json`, matching the existing audit. The returned `inputs_hash` hashes
the ordered list of repository, commit, path, byte hash and URL. Losing this
directory requires a fresh host status read and Git fetch, not a replacement
plan, journal, budget or upload. Result checkpoints contain newly generated
research only; fixed input paths or byte-identical copies under another name
are rejected. This check is not a general content-classification engine.

Existing `research_plan_v2` records remain queryable but cannot claim, renew,
reserve, resume, settle or publish. Their unknown operations remain unknown;
they are never rewritten or reset as v3. Install the matching CD controller
before authority activation: even an empty installed authority rejects a
runtime without the single repository-input entry before opening the isolated
ledger. Recovery must use the current protocol; it must not restore an older
database to permit downgrade.

## Commands and original native receipts

`controlCommand` and `researchSourceIdentity` generate the exact bytes and
canonical source hash. A command has schema `research_control_v2`, fresh
`command_id`, original `request_id`, `action`, `owner_id`, `epoch`,
`expected_revision` and `args`. Read actions use `owner_id: null`; mutations
use the current owner and revision. Every command is committed once by UUID.

| Action | Exact args |
| --- | --- |
| `status` | `offset` |
| `upload_status` | `archive_sha256`, `permit_id` |
| `receipt` | original mutation `command_id` |
| `claim` | original `plan_base64` |
| `renew` | empty object |
| `inputs` | empty object |
| `checkpoint` | stored new-output `archive_sha256` |
| `reserve` | `operations`, one to eight |
| `resume` | original `operation_id` |
| `settle` | `operation_id`, `outcome`, `elapsed_seconds`, `archive_sha256`, `file_sha256`, `native_result` |
| `permit` | stored `archive_sha256`, `bundle_sha256`, `audit_sha256` |

A source reservation has `operation_id`, `kind: "source"`, `key`,
`input_sha256`, `input: {"method":"GET","url":"PUBLIC_SOURCE_URL"}` and
`max_seconds`. Both key and input hash are generated by
`researchSourceIdentity(input)`: URL query order cannot reset the same source's
attempt count. Use the actual public URL; credentials do not belong in it.
A model reservation uses a fixed model-stage name as its key, the original
input hash, `input: null`, and its bounded `max_seconds`. Unknown results remain
consumed. Settling original results after takeover preserves the current owner.

The final native control message is limited to 5,000 characters, including
base64 encoding. Validate it before sending. Split a large reservation batch
into smaller commands using the returned revision; a refused oversized batch
reserves nothing. Keep the initial plan small enough for this wire limit and
keep the public source catalog in its pinned `sources.md`. An already claimed
plan is never shortened or reformatted to fit a later retry.

Use a private non-echoing stdin pipe, or disable terminal echo before supplying
native results. A disposable client config contains `scope` with the pinned
`team_id`, `channel_id`, `sender_user_id`, `sender_attribution_text`,
`publisher_user_id` and `publisher_bot_id`. These are existing installation
identities, never values inferred from text inside a Slack message.

```text
node scripts/research-client-cli.mjs /private/client.json /private/command.json --control
```

The bridge emits a `control` request. The orchestrator sends its exact message
through the original native Slack tool and reads that original thread. Feed
`{"type":"control_result","source_ts":"ORIGINAL_TS","invocation":...}`
to stdin. `invocation` contains the actual read-thread `tool`, `arguments` and
unaltered native `result`. The parser authenticates the complete parent,
Publisher bot metadata, original command hash, UUID and reply thread. A message
body containing a claimed bot ID or a hand-built verified flag is insufficient.
Fresh dispatch receipts expire; status/receipt replies are observations.

## Upload and publication

Add `upload: {request_id, owner_id, permit_id, archive_sha256}` to the disposable
config. Private archives use a null permit; report bundles use the immutable
permit returned by the host. Run the corresponding bridge:

```text
node scripts/research-client-cli.mjs /private/client.json /private/checkpoint.json --archive
node scripts/research-client-cli.mjs /private/client.json /private/bundle.json --stage
```

The bridge waits for a host intent before each ticket, raw POST and completion.
Ticket and POST safe results are committed before the next step. Native tool
requests include the host's operation UUID. Feed their original result as
`{"type":"native_result","operation_id":"ORIGINAL_UUID","result":...}`.
The signed URL stays in the living bridge's memory and private stdin; no URL or
credential is written to a checkpoint, control message or diagnostic.

A fresh bridge reads `upload_status` before acting. When the original POST is
acknowledged, it continues completion of that original file without obtaining a
ticket or uploading again. Already completed uploads return their original
source. A provably withheld intent can resume with its existing operation UUID.

The host's actual archive/staging observation settles completion using the
original file, source timestamp, size and hash. Report completion emits
`!ai-report stage-v2 REQUEST HASH PERMIT`. Before issuing a permit, the host
requires the original bundle and a nonblocking audit stored in the same archive,
checks the plan's report base/prompt commit, request/date, and audit validity.
The audit is the existing trusted cloud researcher's declaration; this host
does not independently rerun the fact/source/deduplication audit or prove that
a summary describes particular article bytes. The original cloud workflow must
review the final artifact before selecting its audit and requesting a permit.
Normal `zero_items` audits remain eligible for a verified no-update report.
Audit schema 1.2's historical `delivery_allowed` observation is not a fresh
authorization gate. Missing timing or explicitly disclosed partial coverage
does not by itself block publication; facts, sources and deduplication remain
strict through the existing audit and publication validation.

Once staging is confirmed, add `stage: {file_id, source_ts}` from its original
host receipt and run `--submit` with that same bundle. The host validates the
complete→submit chain before granting the native message. The formal message is
`!ai-report submit-v2 REQUEST HASH ORIGINAL_STAGE_TS PERMIT`. A permit fixes the
request, bytes, prompt, audit and Publisher scope; it does not grant another
upload. Already-intended original completion/submission can settle after an
owner takeover. Continue to verify the original Pages and WeCom delivery.

## Uncertain execution

A lost control acknowledgement is resolved by a new `receipt`/`status` query.
Replaying its UUID never grants a second dispatch. The host can `resume` the
same operation only when its complete grant history proves no effective grant
entered sending. A withheld ready grant or a sent expired observation can be
replaced atomically for the current owner, preserving input, operation ID and
budget. A sent, sending or unknown effective grant requires reconciliation.

If a cloud process disappears after a ticket or POST grant, first inspect the
original operation and original Slack file. A lost signed URL or a missing
ticket response cannot be recovered from a hash alone. Neither timeout, ordinary
`isError`, missing process nor absent file proves no external call occurred.
Keep that operation unresolved and retain its evidence for operator
reconciliation; this protocol does not silently obtain a replacement ticket.
It provides automatic recovery of stored research and unsent host grants, not a
claim that every external-provider uncertainty is automatically decidable.

Changes to the original database/schema, source channel, plan, budget or policy
are explicit migrations. All history remains intact. Validate the real native
bridge and original-byte archive readback before activating it in a schedule;
isolated fixtures alone are not live-provider acceptance evidence.
