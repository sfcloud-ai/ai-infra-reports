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
not require an input archive. Before schedule cutover, verify the actual native
transport with original uploaded bytes and readback (an existing successful
upload on the same installed transport may supply this evidence), then verify
authenticated control queries against the activated host. Keep production runs
empty during this installation. Input-reference tests alone prove neither path.

The first real daily claim starts the original research deadline. Verify the
complete authority-to-archive chain using that run's first new research output:
native operation intents, stored archive bytes and authenticated hash readback.
After that receipt, continue the authorized research, audit, publication and
delivery. Do not claim a future date for today's acceptance: even zero-charge
native operations would consume its wall-clock research window. Record this
first-run acceptance as pending until it actually happens; transport/control
acceptance and isolated recovery tests are not a full live archive receipt.
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

## Required coverage before publication

Every new daily permit requires the original validator's `schema_version=1.3`
summary and `coverage_contract=daily_required_v1`. All six research directions
and thirteen official source groups must be present. The host rejects an older
summary, missing/duplicate checks, unchecked directions, a substituted draft or
prompt/history bytes, and changed attempt/time limits before storing a permit.
The summary's `inputs.draft_sha256` binds the exact bundled report metadata;
prompt and history hashes bind the original host plan. This is a trusted audit
declaration, not automated fact checking or a substitute for content review.

Verified nonempty partial reports remain eligible with actual failed-source
gaps and public disclosure. Missing timing remains a warning; original attempt
and elapsed budgets remain enforced. Zero-news reports require complete checked
coverage. The pinned prompt commit and its validator must implement this contract;
an older validator cannot be used as a fallback for a new daily permit. Historical
receipts remain readable and their original bytes are retained.

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
are explicit migrations. All history remains intact. Use the staged acceptance
above: actual transport and activated control queries before schedule cutover,
then the first new-output archive on the real daily run. Isolated fixtures alone
are not live-provider acceptance evidence. An uncertain first archive preserves
its original operation/file and enters recovery; it never authorizes a replacement
upload or a fresh daily plan.

## 分层预算与按小时接续（须显式部署与激活）

`research_plan_v4` 使用 `successful_work_hourly_continuation_v1`，与 audit 1.4 对应。
旧 v3 计划与失败记录不改写；旧任务只有追加经过宿主独立批准的 recovery grant 后才采用有效恢复预算。
源码支持不代表已部署，先核实 `status.capabilities`，再使用新计划或恢复命令。
该层已安装时，尚无任务和已有 v3 任务但未接纳 grant 的 status 都返回能力声明；
能力声明本身不激活旧任务恢复。未安装时，合法 recovery_grant 返回持久拒绝
`recovery_layer_not_installed`，不会隐式建表或留作无结论的 pending。

新计划的 `limits` 精确包含 `max_attempts_per_source`、`max_attempts_per_model`、
`source_attempt_timeout_seconds`、`model_stage_timeout_seconds`、`total_budget_seconds`。
来源单次网络超时与模型阶段额度分开。失败和超时的次数、耗时、原输出持续保留，
但只有原归档证明的明确失败可释放成功额度；`acknowledged` 本身不等于成功或失败。
未核实结果继续预留额度并禁止盲目重放。成功额度跨小时累计，不因恢复或换 owner 重置。

每个小时的 `:20` 接续同一请求；每个阶段在一个窗口内最多自动尝试两次，
用完本窗口尝试后保留检查点，等待后续窗口。它不是总重试次数或总等待年龄截止。
3600 秒是小时调度窗口，与原 `total_budget_seconds` 成功额度独立；
原额度不足 3600 秒的合法计划也可接续，但原成功额度不会因此提高或重置。
已成功阶段不为接续而重做。来源正文、检查点与真实失败先归档，后结算。

模型恢复必须绑定同阶段的上一原 operation、已保存结果的 archive/file SHA256 以及
前后两次真实输入哈希。补齐证据可产生新输入，但原 operation/input 与检查点链不能改写。恢复结果须保留已有完成内容与失败记录；未知结果先对账。
不得把检查点保存、控制回执或进程存活代替真实研究、审计、Pages 或企微完成证据。
新的预算规则不追认原定时链路成功，也不授予第二次正式投递许可。

### 激活与旧任务补充授权

停止 Publisher，保留备份，在原非 root 宿主账号下使用新 release 的
`research-recovery-admin.mjs CONFIG --install REFERENCE`。工具持有原 Publisher
独占锁并校验原配置和账本身份，仅追加 recovery 表，不迁移原计划或操作。
未来 v4 任务只有该层已显式安装才可 claim；此前状态查询不会隐式安装。

旧 v3 任务先构造 `research_recovery_grant_v1` 原 JSON 字节，绑定原
request_id、generation、plan_hash、前 grant SHA 和真实授权引用。
`effective_not_before` 为批准时之后首个实际可触发的小时 `:20`，
`window_seconds=3600`、`continuation_policy=hourly_20_until_complete`、
`failed_attempts_consume_success_budget=false`。使用
`research-recovery-admin.mjs CONFIG --approve REFERENCE GRANT` 固定其 SHA 和原字节；
然后恢复 Publisher，通过原正式客户端 `recovery_grant` action，
args 为 `{grant_base64: 原字节的 base64}`，在原 owner/epoch/revision 下接纳。
此控制命令不能自行批准预算，未经独立批准的哈希会拒绝。

该 grant 提供有效恢复策略，原 v3 计划、started_at、charged_seconds、失败结果不变。
新增有效预算将原来源上限用于单次请求，将原整轮额度用于成功研究和模型阶段，
成功次数沿原额度，明确失败不扣成功额度。新 audit 1.4 在独立恢复归档记录
采用时间、grant SHA、新验证器 SHA 与原输入 SHA，不把新提示词冒充原输入。

新 v4 source 结果 JSON 必须带 request_id、operation_id、url、status 和真实
elapsed_seconds；model 结果须带 request_id、operation_id、status（或
stage_status）及真实 elapsed_seconds。二者须与原操作和归档一致。
旧 v3 source 历史只能经同请求唯一 result_file 关联、URL 与实际耗时核实；
一个历史文件不能释放多个操作的额度。未知结果、未知耗时不据此自动重试。

### 用户明确授权的一次性立即恢复

用户对原请求另行明确授权立即恢复时，可使用
`continuation_policy=immediate_once_then_hourly_20_until_complete`，其余原请求、
计划哈希、generation、前 grant 链保持不变。离线模板的
`effective_not_before` 必须为 `null`，由
`research-recovery-admin.mjs CONFIG --approve-now REFERENCE TEMPLATE`
在原宿主锁内记录真实批准时刻并返回 `grant_base64`、SHA256 和 `approved_at`；
将返回的精确字节经正式 `recovery_grant` 接纳，不手工倒填小时调度时刻。
批准时的北京时间日期须与原 report_date 相同，每个原请求仅允许一次即时批准。
同一精确批准字节可幂等核对；调用结果未知时先检查原批准记录，不重复生成新模板。
首段从真实批准时刻持续至下一小时 `:20`，其后仍每小时 `:20` 接续。
旧计划、首次开始时间、实际失败、已用成功额度及未知操作保护全部不变。

旧 v3 来源原结果若绑定响应正文而非 JSON，只在同一已认证归档内存在唯一
匹配原 operation_id 与正文 SHA 的元数据时分类。还须核实原 key/input SHA、
URL identity、预留额度、单次尝试数、正文长度、真实耗时及 HTTP/退出码；
缺失、不一致或无法判定仍是 unknown。新 v4 不使用此历史格式兼容路径。
