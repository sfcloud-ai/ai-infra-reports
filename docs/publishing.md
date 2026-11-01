# 发布与恢复

实现和启用是两个步骤。仓库代码不会自行创建凭据、修改保护规则或打开合并、部署开关；这些操作需要仓库所有者明确授权。提交公开配置核验记录不等于启用自动合入。

## 最小身份与权限

报告生产器使用只安装于 sfcloud-ai/ai-infra-reports 的 GitHub App。安装令牌须短期签发，仅授予 Contents write 和 Pull requests write；不授予 Actions write、Workflows write、Pages、管理权限或其他仓库。私钥保留在生产器的秘密管理设施，不能写入报告或本库。正文公开发布必须完成上游内容审校；机器验证不构成披露授权。

合并工作流运行在默认分支。基础 GITHUB_TOKEN 只有 Contents read；独立可信 Merger App 的短期令牌拥有 Contents write、Pull requests read、Actions read、Checks read，仅限本库。Merger App 私钥只保存在可信工作流秘密中，生产者不得持有该私钥或任何同一 App 的其他私钥。REPORT_MERGER_APP_ID 与 REPORT_PRODUCER_APP_ID 必须是两个不同的 App ID；Bot 用户 ID 是另一种标识，需分别核对。固定 REPORT_BOT_ID（数字）及 REPORT_BOT_LOGIN（完整 [bot] 登录名）；不能只按分支前缀信任身份。仓库变量 REPORT_AUTOMERGE_ENABLED 默认缺省/false。

启用前，仓库所有者须明确批准并配置六个独立的仓库级 active ruleset：

- main 质量：只包含 refs/heads/main；无 bypass actors；要求 pull_request、non_fast_forward、deletion，以及绑定 GitHub Actions 的 validate 严格检查。pull_request 的 required_approving_review_count=0、require_code_owner_review=false、require_last_push_approval=false，启用 dismiss_stale_reviews_on_push。所有人都必须通过 PR 和 CI；具备写权限的审查者提交的阻塞性 Request changes 仍须解决，不能利用独立人工审查例外跳过。
- main 更新权限：只包含 refs/heads/main，只有 update 规则且 update_allows_fetch_and_merge=false；bypass 仅允许 Merger App 和明确命名的人类 User，拒绝 Producer App、GitHub Actions、角色或团队。不能把质量规则放进这个允许 Merger bypass 的 ruleset。质量规则仍独立、无任何 bypass。
- 其他分支更新与删除：include 为 ~ALL，exclude 仅 refs/heads/main；同时要求 update（update_allows_fetch_and_merge=false）和 deletion 限制，此规则集不混入 creation。仅可给明确的人类 User ID 配置 always bypass，不能给 GitHub Actions、其他 App、团队或角色绕过。机器人不能更新或删除分支，也不能通过删除后重建替换既有分支；合并调用即使遇到并发 retarget，也不能写入任何非 main 目标。维护代码的人需在明确的 User 列表内。

- main 代码审查：只包含 refs/heads/main，只有 pull_request 规则；require_code_owner_review=true、dismiss_stale_reviews_on_push=true、required_approving_review_count=0、require_last_push_approval=false。仅同一批明确命名的人类 User 使用 pull_request bypass；两个 App 没有此例外。不能把 CI、禁止强推或删除限制放进这个规则集。
- 日报分支创建：仅 include refs/heads/report/*，无 exclude，只包含 creation 规则。always bypass 仅限 Producer App 和同一批人类 User，不能包含 Merger、其他 App、角色或团队。
- 其他非 main 分支创建：include 为 ~ALL，exclude 精确为 refs/heads/main 和 refs/heads/report/*，只包含 creation 规则；always bypass 仅限同一批人类 User。两条创建规则不改变 main 门禁，也不赋予 Producer 更新或删除分支的例外。GitHub 的单个 * 不跨斜杠，因此 report/nested/name 不属于 Producer 范围；创建规则不校验十六进制命名，生产器与合并脚本仍验证完整 report/<12hex>-<24hex> 格式。

五个人工例外名单必须是相同、无重复的 User ID，成员须为实际拥有 write 或更高权限的真人。人工通过 PR 合入无需等待另一个人 Approve；GitHub 可能要求明确选择仅跳过代码审查规则。质量规则没有 bypass，因此 Request changes、失败或过期的 validate 仍会阻塞。新增或移除写入成员时，须同步这五个名单并重新生成核验记录；不以 RepositoryRole 绕过替代，以免扩大 App 权限。Request changes 的 GitHub 语义见[提交审查的官方说明](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request#submitting-your-review)。

默认分支 .github/CODEOWNERS 必须把所有路径交给已验证的人工维护者 @shipiyouniao，仅 /reports/ 排除。机器人合入规则、CODEOWNERS、脚本、依赖或配置时仍须人工代码审查；真人写入成员可通过独立审查规则的 PR 例外自行合入。Producer 还受 main 更新限制，即使报告 PR 全绿也不能自行合并。不会把“两个 App”或同一私钥的 token 降权当成安全隔离。运行时核对准确 base 的 CODEOWNERS 内容及 GitHub 检测结果。代码所有者必须持续具备仓库写权限；角色、成员或规则变更前先停用自动化。

GitHub 的普通工作流令牌不能读取完整 bypass_actors，因此不能把字段缺失当作“没有绕过”。配置完成至少五秒后，所有者在本地用既有、已授权且能管理这些规则的令牌运行 `node scripts/verify-configuration.mjs QUALITY_ID NON_MAIN_ID MAIN_UPDATE_ID CODE_REVIEW_ID REPORT_CREATION_ID OTHER_CREATION_ID ACTIONS_APP_ID PRODUCER_APP_ID MERGER_APP_ID`，令牌仅通过 REPORT_CONFIGURATION_TOKEN 注入。脚本只 GET 配置并输出 schema_version=3.0 的公开 JSON，不修改规则；把输出作为 .github/report-policy.json 的独立审查提交。旧版三条或四条规则记录被拒绝，不能静默省略创建限制。该管理令牌不进入 Actions 或报告生产器。已有 gh 登录也可读取六个完整 ruleset 后在本地调用 mergerPolicy 核验，无需导出凭据。

合并任务读取默认分支中的核验记录，在初始验证和最终合并写入之前均用普通元数据权限比对六条实时 ruleset 的 ID、范围、规则、状态和 updated_at；若能看到 bypass_actors 也逐项比对。创建规则被停用、移除、改变范围或扩大例外，同样会阻止合并；不要求增加 App 管理权限。仓库管理员属于受信任配置方；修改规则前必须先关闭 REPORT_AUTOMERGE_ENABLED，等待运行结束，再修改并重新核验，不能在合并过程中更改授权。旧式 branch protection 不满足此契约。核验记录本身不会开启 REPORT_AUTOMERGE_ENABLED。

GitHub 的 [合并 PR 接口](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)要求 Contents write；当前 Merger 只读取 PR 元数据，不更新 PR、审查或评论，所以 Pull requests 保持 read。离线权限模型测试覆盖完整合并路径；它不代替真实 GitHub App 的权限负向联调。

只限制 update 的旧 non-main 核验记录不满足新契约，运行时会拒绝；需要所有者另行授权补齐 deletion 并重新核验，不能沿用旧记录声称已经禁止删除。deletion 只阻止删除既有分支，不阻止创建全新的报告分支；机器人不清理已发布分支，后续清理由明确授权的人类完成。

## 生产器调用

1. 读取 main 的准确 SHA，把本期 report.json、子文章与图片放在一个目录下的 reports/YYYY-MM-DD/rN/ 中。生产器不需要构建索引。
2. 在受信任的生产器运行 `node scripts/propose.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA`。REPORT_APP_TOKEN 从环境注入，不能作为命令行参数或日志输出。默认创建 draft。
3. 完成内容审校并决定启用全自动模式后，可显式加 --ready。此参数只选择新 PR 的 draft 状态；不会将已存在的 draft 自动转为 ready。
4. 脚本校验内容，重建索引，一次创建包含二者的 Git commit，再创建确定性分支及 PR。相同输入及 base 重跑会复用同一分支/PR，绝不 force push。主分支变更时停止并重新准备。
5. CI 成功后，受信任合并任务按 PR 分组，避免不同 PR 的 pending 任务互相覆盖。合并工作流检查实际作者、仓库、准确 head、base、单提交父节点、完整 Git tree、路径与模式、内容与索引，最后使用 GitHub merge API 的 sha 条件；非 main 的服务端更新限制封闭该 API 不提供 base 条件的窗口。未准备就绪、合并性未知或并发变更均停止。

正常情况下机器人 PR 可自动合入；这依赖上述身份、开关和仓库保护全部配置到位。代码不存在默认放行。

## 受信任生产器的 App 接入

已有短期令牌的调用方仍可使用 propose.mjs，并自行负责令牌回收。需要由既有 Producer App 签发的调用方可运行：

`node scripts/propose-with-app.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA [--ready]`

调用进程从秘密管理设施取得 REPORT_PRODUCER_PRIVATE_KEY_FILE，环境中另外指定 REPORT_PRODUCER_APP_ID 和独立的 REPORT_MERGER_APP_ID。私钥文件必须位于受信任生产器的秘密存储中，不能放在报告包、仓库或命令行内。新入口不会创建 App、生成或保存私钥，也不会配置安装、规则、仓库变量或定时任务。

入口先读取本地报告包和检查准确 SHA，再使用 RS256 JWT 读取固定仓库的安装信息，拒绝身份错误、暂停、非 selected 安装或权限超额。只请求 ai-infra-reports 的 Contents write 和 Pull requests write，核对返回令牌的权限、到期时间和实际可见仓库。Metadata read 是 GitHub 的必要附带权限。有效令牌最多约一小时，保留一分钟时钟偏差；不会持久化、打印或传给 Git 子进程。JWT 允许一分钟时钟偏差且签名有效期不超过十分钟。

通过校验后在同一进程调用现有 propose，默认 draft；只有完成上游内容审校后才能显式传 --ready。成功或失败均先关闭 Git 对象读取器，再请求撤销本次令牌。撤销未确认时退出失败，不能据此盲目重新提交：先查询已存在的 PR 和分支。网络错误、权限拒绝及签发响应不明不会自动重试。强制终止进程可能无法撤销，必须依赖令牌到期并由调用方核对运行结果。

该入口只核实本次令牌的有效范围，不证明持有私钥者无法为其他安装或仓库另签令牌；Producer App 的实际安装范围、独立私钥、服务器权限隔离仍须按前述要求人工配置及联调。离线测试全部使用临时内存测试密钥和模拟传输，没有真实签发、提交报告或启用自动合入。后续生产接入仍缺 App/秘密存储配置、实际负向联调，以及上游生成器将审校后的版本包和准确 main SHA 交给该入口的调用步骤；本改动没有替换或启动生产定时任务。

参考：[安装令牌的范围与到期](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)、[撤销安装令牌](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token)。

## Pages 与通知

REPORT_PAGES_ENABLED 默认缺省/false。启用前需由仓库所有者配置 GitHub Pages 的 Actions 发布源、github-pages environment 和所需保护。Pages 构建只 checkout main；部署令牌只出现在 deploy job。报告生产器拿不到它。

Merger App 合并会正常触发 main push 发布，也保留手动触发。只保留这条 push 链，不叠加 workflow_run 造成重复发布。发布任务串行构建最新 main，publication.json 记录真正构建的 commit。

随后校验 publication.json、独立的 reports/YYYY-MM-DD/rN/publication-proof.json 与本期所有 HTML。报告原始合入提交与整站部署提交分开记录：部署须等于原提交或由 GitHub compare 证明是其后继；期次源文件的 Git blob 哈希须与 GitHub 不可变提交树完全一致，交接调用还核对原始报告包。构建后生成的期次证明绑定部署提交及最终 HTML 的 SHA-256，页面标识和证据区仍须存在；读取结束后重新核对清单及证明，拒绝混合部署。图片继续逐一校验原始 SHA-256。这样后续代码或其他期次部署不会误拒完整旧报告，但更早、分叉、内容改变或无法证明的部署仍失败。

根 publication.json 和 notice.json 的既有结构不变，通知清单继续绑定当前部署，兼容现有严格读取器。新校验器要求新构建生成的独立证明，缺失时等待重新部署，不回退到只看页面标识；GitHub 公共只读 API 不可用或限流时也保持未验证。证明依赖受信任的 Pages 构建，不是对恶意托管端的签名证明，也不代表 Slack/企微送达。

之后才准备符合 ai-infra-brief 格式契约的顶层图文：日期标识、每篇子标题及对应子文章 URL、一张横版分区 PNG/JPEG 总海报，不加各篇摘要。内容复用 articles，并核对同源 notice.json 的完整顺序与版本；原机器人使用 file_share，固定连接器允许已验证的缺省 subtype。当前仓库不改变生产定时任务，不发送 Slack 或企微消息。发送者、可见 blocks、文件读取权限、真实 Slack 回读、企微回执和去重仍由通知链路负责。

## 失败与并发

- 写 Git 对象失败：可能留下不可达对象，没有更新 main；读取后再决定重试。
- 创建分支/PR 响应丢失：先查询确定性分支及实际 SHA，再查 PR；不同内容或多个结果停止处理。
- PR 关闭未合入：不自动重开。
- base 前进：新输入需基于新 main 重新校验。旧 PR 保留供人工核对，不能盲目改写。
- CI 失败或合并性未知：停止；修复后重新验证准确 head。
- 合并响应未知：读取实际 PR merged 与 head 状态；只有明确一致才记录成功，不重复 merge。
- 部署失败：报告可能已合入但尚不可读。修复发布后核验同一版本；不会因此发送历史消息或重复发送。
- 不承诺跨 GitHub、Pages、Slack 与企微的“恰好一次”。每个阶段应记录独立回执。

参考：[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)、[合并 PR 的 sha 条件](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)、[GITHUB_TOKEN 触发行为](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow)。

历史读取通过固定公开仓库的 Git 对象传输，使用隔离的临时 bare 仓库、禁用 hooks/submodules、不 checkout PR。报告 blobs 一次批量读取并按不可变 SHA 复用，不对每篇历史文章单独调用 REST API。读取结束清理临时对象目录。

PNG/JPEG 在 CI、提 PR、受限合并和站点构建中都必须通过 Sharp 完整解码，限制输入字节、像素、维度、单帧与解码时间。合并任务仅安装默认分支锁定的依赖且禁用安装脚本，不安装或执行 PR 提供的依赖。

规则 API 的字段可见性与范围语义见 [GitHub rulesets REST 文档](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset)。

当前 GitHub API 2026-03-10 文档支持 ruleset bypass actor_type User；旧 API/服务器若不支持，应停止启用，不降级为角色或 App 绕过。CODEOWNERS 语义见 [官方文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)。

## 启用前必须完成的真实负向联调

这仍是默认关闭的候选实现，离线测试和配置回读不代表 GitHub 上的权限隔离已经实测完成。获得具体仓库/测试分支与凭据授权后，必须核验：Producer 对全绿报告 PR 直接 merge 和直接 push 都不能更新 main；Producer/Merger 不能删除或更新既有非 main 分支，Producer 能创建全新报告分支但不能创建其他非 main 分支，Merger 两类分支都不能创建；Merger 缺少 required checks 或代码所有者批准时仍被拒绝；代码、workflow、symlink 混入报告被拒绝；head/base 改变使旧验证失效；组织继承规则与管理员绕过不会削弱以上六个规则。人工路径须验证：零 Approve 的全绿 PR 可以合入；另一位 write 成员提交 Request changes 后不能合入，须该审查者批准或按 GitHub 权限正式撤销阻塞审查；CI 失败、过期或缺失也不能合入。记录实际回执后才允许启用。自动化测试不创建真实 App 或密钥，不执行这些真实写入测试。

如果所在仓库计划/规则 API 不支持该配置，则保持关闭，改评估生产者对目标库零写权限的独立收件箱或可信发布器；不通过给 Producer main 绕过权限来降级。

通知清单由同一原始 report.json 生成，包含所有文章标题/链接、原始报告与海报 SHA-256 以及构建提交。1900 字节预算包含全部标题和完整 URL；最新期次超限或不符合单行标题规则时构建失败。已通过完整归档校验的历史期次若仅因旧标题格式或通知字节预算无法导出，仍生成原有页面，但不导出 notice.json，并输出警告；这不代表已投递。数据结构、来源或资产损坏始终失败，不修改不可变历史内容。
