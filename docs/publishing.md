# 发布与恢复

实现和启用是两个步骤。本 PR 只提供可审查的代码；创建凭据、修改保护规则、打开合并或部署开关都需要仓库所有者另行批准。

## 最小身份与权限

报告生产器使用只安装于 sfcloud-ai/ai-infra-reports 的 GitHub App。安装令牌须短期签发，仅授予 Contents write 和 Pull requests write；不授予 Actions write、Workflows write、Pages、管理权限或其他仓库。私钥保留在生产器的秘密管理设施，不能写入报告或本库。正文公开发布必须完成上游内容审校；机器验证不构成披露授权。

合并工作流运行在默认分支。基础 GITHUB_TOKEN 只有 Contents read；独立可信 Merger App 的短期令牌拥有 Contents write、Pull requests write、Actions read、Checks read，仅限本库。Merger App 私钥只保存在可信工作流秘密中，生产者不得持有该私钥或任何同一 App 的其他私钥。REPORT_MERGER_APP_ID 与 REPORT_PRODUCER_APP_ID 必须是两个不同的 App ID；Bot 用户 ID 是另一种标识，需分别核对。固定 REPORT_BOT_ID（数字）及 REPORT_BOT_LOGIN（完整 [bot] 登录名）；不能只按分支前缀信任身份。仓库变量 REPORT_AUTOMERGE_ENABLED 默认缺省/false。

启用前，仓库所有者须明确批准并配置三个独立的仓库级 active ruleset：

- main：只包含 refs/heads/main；无 bypass actors；要求 pull_request、non_fast_forward、deletion，以及绑定 GitHub Actions 的 validate 严格检查。pull_request 必须启用 require_code_owner_review 与 dismiss_stale_reviews_on_push；全局 required_approving_review_count 可设 0，让无 code owner 的纯报告 PR 自动通过审查要求。
- main 更新权限：只包含 refs/heads/main，只有 update 规则且 update_allows_fetch_and_merge=false；bypass 仅允许 Merger App 和明确命名的人类 User，拒绝 Producer App、GitHub Actions、角色或团队。不能把质量规则放进这个允许 Merger bypass 的 ruleset。质量规则仍独立、无任何 bypass。
- 其他分支：include 为 ~ALL，exclude 仅 refs/heads/main；要求 update 限制。仅可给明确的人类 User ID 配置 always bypass，不能给 GitHub Actions、其他 App、团队或角色绕过。这样机器人仍能创建一次性报告分支，但不能更新分支；合并调用即使遇到并发 retarget，也不能写入任何非 main 目标。维护代码的人需在明确的 User 列表内。

默认分支 .github/CODEOWNERS 必须把所有路径交给已验证的人工维护者 @shipiyouniao，仅 /reports/ 排除。规则和 CODEOWNERS 自身也受人工审查保护。这样生产者即使直接调用 merge API，也不能自行合并脚本、依赖或配置变更；不会把“两个 App”或同一私钥的 token 降权当成安全隔离。运行时核对准确 base 的 CODEOWNERS 内容及 GitHub 检测结果。代码所有者必须持续具备仓库写权限；角色、成员或规则变更前先停用自动化。

GitHub 的普通工作流令牌不能读取完整 bypass_actors，因此不能把字段缺失当作“没有绕过”。配置完成至少五秒后，所有者在本地用既有、已授权且能管理这些规则的令牌运行 `node scripts/verify-configuration.mjs QUALITY_ID NON_MAIN_ID MAIN_UPDATE_ID ACTIONS_APP_ID PRODUCER_APP_ID MERGER_APP_ID`，令牌仅通过 REPORT_CONFIGURATION_TOKEN 注入。脚本只 GET 配置并输出核验后的公开 JSON，不修改规则；把输出作为 .github/report-policy.json 的独立审查提交。初始文件为 null，自动合并因此保持关闭。该管理令牌不进入 Actions 或报告生产器。

合并任务读取默认分支中的核验记录，用普通元数据权限比对实时 ruleset ID、范围、规则、状态和 updated_at；缺失或配置变更一律停止。仓库管理员属于受信任配置方；修改规则前必须先关闭 REPORT_AUTOMERGE_ENABLED，等待运行结束，再修改并重新核验，不能在合并过程中更改授权。旧式 branch protection 不满足此契约。本 PR 没有执行上述配置步骤。

## 生产器调用

1. 读取 main 的准确 SHA，把本期 report.json、子文章与图片放在一个目录下的 reports/YYYY-MM-DD/rN/ 中。生产器不需要构建索引。
2. 在受信任的生产器运行 `node scripts/propose.mjs BUNDLE_ROOT EXPECTED_MAIN_SHA`。REPORT_APP_TOKEN 从环境注入，不能作为命令行参数或日志输出。默认创建 draft。
3. 完成内容审校并决定启用全自动模式后，可显式加 --ready。此参数只选择新 PR 的 draft 状态；不会将已存在的 draft 自动转为 ready。
4. 脚本校验内容，重建索引，一次创建包含二者的 Git commit，再创建确定性分支及 PR。相同输入及 base 重跑会复用同一分支/PR，绝不 force push。主分支变更时停止并重新准备。
5. CI 成功后，受信任合并任务按 PR 分组，避免不同 PR 的 pending 任务互相覆盖。合并工作流检查实际作者、仓库、准确 head、base、单提交父节点、完整 Git tree、路径与模式、内容与索引，最后使用 GitHub merge API 的 sha 条件；非 main 的服务端更新限制封闭该 API 不提供 base 条件的窗口。未准备就绪、合并性未知或并发变更均停止。

正常情况下机器人 PR 可自动合入；这依赖上述身份、开关和仓库保护全部配置到位。代码不存在默认放行。

## Pages 与通知

REPORT_PAGES_ENABLED 默认缺省/false。启用前需由仓库所有者配置 GitHub Pages 的 Actions 发布源、github-pages environment 和所需保护。Pages 构建只 checkout main；部署令牌只出现在 deploy job。报告生产器拿不到它。

Merger App 合并会正常触发 main push 发布，也保留手动触发。只保留这条 push 链，不叠加 workflow_run 造成重复发布。发布任务串行构建最新 main，publication.json 记录真正构建的 commit。

发布后查询 publication.json 与本期索引 HTML，要求提交相同、preview=false、日期/版本存在且页面返回正确标识，方能使用报告 URL。核验失败不声称站点可用。

之后才准备符合 ai-infra-brief 格式契约的顶层 file_share：子标题、日期索引 URL、单张 PNG/JPEG 信息海报。当前仓库不改变生产定时任务，不发送 Slack 或企微消息。发送者、可见 blocks、文件读取权限、真实 Slack 回读、企微回执和去重仍由通知链路负责。

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

这仍是默认关闭的候选实现，离线测试不代表 GitHub 上的权限隔离已完成。获得具体仓库/测试分支与凭据授权后，必须核验：Producer 对全绿报告 PR 直接 merge 和直接 push 都不能更新 main；Merger 缺少 required checks 时仍被拒绝；代码、workflow、symlink 混入报告被拒绝；head/base 改变使旧验证失效；组织继承规则与管理员绕过不会削弱以上三个规则。记录实际回执后才允许启用。当前没有运行这些真实写入测试，没有创建 App、密钥或配置规则。

如果所在仓库计划/规则 API 不支持该配置，则保持关闭，改评估生产者对目标库零写权限的独立收件箱或可信发布器；不通过给 Producer main 绕过权限来降级。
