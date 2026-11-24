# Publisher 自动更新

固定主机入口从公开 GitHub API 检查 `main`，仅接受当前版本的后继提交及同一 SHA、同一仓库、`push` 事件的 `validate.yml` 成功结果。较新的失败重跑不会被旧成功覆盖。无需 GitHub Token、入站端口或新的 App 权限。

候选源码与锁定依赖在非生产账号的隔离容器内准备。依赖安装使用 `npm ci --ignore-scripts`；完整 `npm run check` 在无网络、无生产凭据挂载的容器内执行。验证后重新比对源码，将只读代码安装到独立 SHA 目录。测试失败不会停止现役 Publisher。

更新前要求报告、通知和控制回执均已完成。有在途任务、保留但未发送的通知或未知写入时推迟升级。随后只向主监督进程发送 SIGTERM，等待当前串行 tick 自行结束，不强杀。新旧代码先打开隔离账本副本，必须保持完整内容与结构不变；需要迁移的版本留待显式迁移流程处理。

服务切换保留原账号、配置文件和状态目录，只更换代码入口。新服务完成两个正常 tick 后确认健康。失败时，仅在确认进程退出、账本没有未知状态且旧代码可兼容读取后恢复旧代码；不恢复数据库、不重置游标。跨进程中断留下 `pending.json`，后续定时检查只报阻断，必须核实真实结果后恢复，不能盲目重发停止或启动命令。

## 一次性主机接入

管理员审查后安装固定的 `publisher_cd.py`、`publisher-cd.service` 和 `publisher-cd.timer`。固定入口本身不从应用仓库自动替换，也不自动修改权限、安全规则、运行时镜像或部署账号。应用 `scripts/publisher-service.mjs` 及 Publisher 业务模块随 release 更新。

root 所有的 `/etc/ai-report-publisher-cd.json` 明确指定 `base`、`control`、`state`、`publisher_config`、`unit`、`node`、`git`、`image`、`uid`、`gid`、`validation_uid`。这些值从已核实的服务布局取得，不能来自 Slack 消息。`control` 是 root 私有目录，初始 `active.json` 只记录已验证的线上 `commit`。验证账号与生产账号必须分离，沿用已安装、按摘要固定的容器镜像和 Node/Git 运行时。

接入前在隔离副本演练排空、失败恢复和状态保持；部署后核对真实版本、账本和健康，再启用定时器。定时器在上轮结束五分钟后检查，不保证 GitHub 或网络故障时仍按时更新。磁盘空间不足、接口限流、CI 未成功或账本需要对账均保留现役版本。历史 release 和操作证明暂不自动删除，应监控磁盘容量。

### 2026-11-21 手工送达记录

11 月 21 日的正文和海报由手工通道送达。原调度行停在 `admission_pending`，会使 CD 在选版前退出。在发布空档按顺序取得 `control-entry.lock`、`deployment.lock`，确认没有未完成的 CD 操作。持锁核对现役 relay 的原请求、正文及海报摘要和 2/2 回执。若 Publisher 早于防重基线 `0bcd657`，先备份服务入口、版本指针，手工部署基线并核对新进程健康。从原交付取证取得 `/etc/ai-report-original-20261121.fact`，核对其 SHA256 与 `scripts/manual-delivery-fact.mjs` 的固定值一致。使用单链接普通文件，root 所有、Publisher 主组、模式 `0440`。

从已审查的提交暂存 `deployment/reconcile-original-manual.mjs`，保留相对目录布局。逐文件比对实际现役 release 的 `scripts/` 与该提交中的文件及字节，并比对 `package-lock.json`。一致时可将暂存目录中的 `scripts` 链接到该只读 release 的 `scripts/`，复用其已安装依赖。否则直接暂存已审查的源码和按其锁文件安装的依赖。使用服务的 Node 和服务账号。以 SQLite backup 另存一份受保护的原账本，再制作演练副本。将演练配置放在服务账号所有的私有目录中，文件权限为 `0600`，把 `state_dir` 改为演练目录，核对其 `handoff.sqlite` 与线上文件的设备号和 inode 组合不同。

先执行 `node deployment/reconcile-original-manual.mjs /path/to/rehearsal-publisher.json` 并核对副本。然后对现役配置执行 `node deployment/reconcile-original-manual.mjs /path/to/active-publisher.json`。命令取得现有 handoff 锁，核验手工回执并通过原调度入口只读查询同一 ID。自动准入返回 `not_found` 后，将真实结果记为 `complete`、`delivery_kind=manual_initial`。完整的原调度行保存在 `result.reconciliation.previous`，包括原始诊断文本。重复执行会复核已存回执并返回 `changed:false`。随后释放部署锁，运行普通 CD，核对 `updated`、服务实际版本和两个健康周期。

这套 CD 只部署 Publisher，不发送日报、不改变晨报日程。Pages 使用原有工作流；转发器、控制运行时与校验器由 brief 仓库自己的受限部署入口更新。

## 从 T4 恢复原单研究归档

通常先以普通 CD 安装支持收档的应用和控制程序。若现役服务因缺少父归档而无法通过健康检查，在发布空档执行以下短停升级。核对父件的原票据和等待子件的 Slack 消息、文件 ID 与哈希。原请求负责人暂停提交后，从已有 Slack 记录取该原单最后一条控制写入的时间戳。确认 T4 已完成覆盖该时间戳的扫描，再暂停 CD 定时器，依次取得 `control-entry.lock`、`deployment.lock`，核实无未完成的部署或未知写入，使用已验证候选的 `snapshot(path, settled=True, fingerprint=False)` 检查现役账本是否已结算。若发布作业仍在途中，先让它完成。

若现役版本已支持收档且与已验证的 main 一致，核对已加载的 unit、当前控制程序摘要及版本指针。依照步骤 1 的 SIGTERM 方式排空服务，备份 SQLite，保留现役版本与指针，释放两把部署锁，保持定时器暂停，再执行步骤 3 和 4。旧诊断已能证明父件身份时直接执行步骤 4。

1. 使用 `select_candidate` 选取 main CI 已通过的精确提交。在两把部署锁内核对 `pending.json` 和 `control-pending.json` 均无未完成操作，`blocked.json` 与 `control-blocked.json` 均未封存候选，再用 `stage` 完成隔离验证。在操作目录备份原 unit、控制程序和版本指针。沿用普通 CD 的 `pending.json` 原子记录前后提交、unit 和配置摘要、操作目录及 `drain_intent`。执行 `systemctl kill --kill-who=main --signal=SIGTERM ai-report-publisher.service`，最多观察 300 秒，等主进程自行排空；若未退出，保留记录并核对状态。确认 inactive/dead、MainPID 为 0 后备份 SQLite，在副本上用候选版本检查账本兼容性。
2. 切换前再用原现役提交执行 `select_candidate`，比对提交、CI run、attempt、暂存证明和配置摘要。再次检查两项封存记录和本次操作身份。在修改任何指针前将阶段写为 `activation_intent`，安装验证过的 release 和配套控制程序，保留原服务账号、配置和状态目录。更新应用及已配置的控制版本指针，执行 `systemctl daemon-reload`。逐项比对已加载 unit、应用指针、控制程序摘要及已有的控制指针与目标版本；将核对结果落盘后清除本次 pending 记录，保持定时器暂停，释放部署锁。遇到中断，按留存的原记录核对各项真实状态后接续。
3. 若子件的旧 `archive_parent_unavailable` 记录缺少父件哈希，用 `systemctl start ai-report-publisher.service` 启动刚安装的候选。归档 worker 会在原事件的 `next_at` 到期后重新认证同一条 Slack 消息，并校验下载字节。用下列只读查询绑定原子件，观察一个已到期的重试，最多等十分钟。取得匹配的父件哈希后，用步骤 1 的主进程 SIGTERM 和 300 秒上限排空。若重试受限或父件不符，保留原结果与下次可读时间，结束本次维护尝试。整个过程沿用原事件、原文件与原票据。

   ```sql
   SELECT phase, next_at, coalesce(json_extract(diagnostic,'$.missing_parent_sha256'),
       json_extract(diagnostic,'$.verified_parent.missing_parent_sha256')) AS parent
   FROM research_archive_events
   WHERE kind='save' AND request_id=? AND source_ts=? AND file_id=? AND hash=?;
   ```

4. 确认服务已停止、发布作业已结算，从当前账本复制演练副本，用候选版本在副本上验收同一父件。随后对正式账本执行下述命令。若同一原单还有待处理的控制写入，启动 Publisher 让它处理原队列，再排空并重试收档。在此次独占维护窗口内由同一位操作员管理服务启停，收到回执后再启动。命令重新取得两把部署锁和账本锁，核对 systemd 服务账号、启动参数、精确版本及原票据，在账本锁内再次核对停止状态。持锁期间，Publisher 的普通 tick 会等待或延后。启动后核对父件回执。若有等待父件的子件，核对子件收档；若原事件已经终态拒绝，核对该拒绝记录。健康检查连续成功两次后恢复 CD 定时器。首次收档后的恢复版本也须支持 T4 收档记录。

研究原件需要在 T4 恢复时，先从原票据回执核对文件 ID、SHA-256、长度及实际上传结果。将精确匹配的字节写入 `/var/lib/report-publisher/host-archive-inbox/<sha256>.json`。目录和文件均由 root 与 Publisher 主组持有，权限分别为 `0750` 和 `0440`。以 root 在现役控制程序目录执行 `python3 publisher_cd.py receive-host-archive <现役提交> <原请求> <原票据操作ID> <Slack文件ID> <sha256> <原单最后控制写入的Slack时间戳>`。成功回执包含 T4 收档时间及原文件身份。交付岗沿用该归档结算取证和提交 checkpoint。首次收档后，部署与回滚均核验目标运行时能识别这类回执。

## 六篇首发规则的上线顺序

先部署能识别首发拒绝回执的 Publisher 和配套控制程序。从 2026-11-19 报告日起，签发发布许可、接收报告包和更新网页都核验六篇完整专题，后续修订也保留六个入口。核对现役应用提交、控制程序摘要及两个健康周期，再在 relay 启用六篇规则。数据库已有明确拒绝记录时，部署和回滚都要求目标版本能识别该记录。

切换前按原请求检查 `scheduled_handoffs`。已有 `admission_pending` 继续核对原请求、报告提交与包摘要；通用错误不能证明 relay 已拒绝。只有 relay 对同一份原始数据返回明确且绑定一致的拒绝回执，才能将这次首发记为拒绝。

首次切换应在交付负责人确认的发布空档执行。合入前对现役账本运行 `python3 -B deployment/edition_cutover_preflight.py /path/to/handoff.sqlite "$pause_start_ts"`。传入空档开始时的 Unix 秒数，含六位小数。预检确认 Slack 已扫描至该时刻，并核对待处理命令、已签发许可与原发布回执。检查发现待办时，先按原许可和仍有效的 Git 基线完成交付，再合入。从检查至部署完成，由原交付负责人维持同一空档，随后恢复生产。

CD 也在隔离账本副本上核对未接收的许可。已上线的残缺报告沿相同日期和六个固定网址发布完整的重要修订。尚未签发许可的旧分页预约在原操作全部结算后可沿整期修订入口补全。首次企微通知以实际出站回执为准。
