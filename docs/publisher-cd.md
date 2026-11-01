# Publisher 自动更新

固定主机入口从公开 GitHub API 检查 `main`，仅接受当前版本的后继提交及同一 SHA、同一仓库、`push` 事件的 `validate.yml` 成功结果。较新的失败重跑不会被旧成功覆盖。无需 GitHub Token、入站端口或新的 App 权限。

候选源码与锁定依赖在非生产账号的隔离容器内准备。依赖安装使用 `npm ci --ignore-scripts`；完整 `npm run check` 在无网络、无生产凭据挂载的容器内执行。验证后重新比对源码，将只读代码安装到独立 SHA 目录。测试失败不会停止现役 Publisher。

更新前要求报告、通知和控制回执均已完成。有在途任务、保留但未发送的通知或未知写入时推迟升级。随后只向主监督进程发送 SIGTERM，等待当前串行 tick 自行结束，不强杀。新旧代码先打开隔离账本副本，必须保持完整内容与结构不变；需要迁移的版本留待显式迁移流程处理。

服务切换保留原账号、配置文件和状态目录，只更换代码入口。新服务完成两个正常 tick 后确认健康。失败时，仅在确认进程退出、账本没有未知状态且旧代码可兼容读取后恢复旧代码；不恢复数据库、不重置游标。跨进程中断留下 `pending.json`，后续定时检查只报阻断，必须核实真实结果后恢复，不能盲目重发停止或启动命令。

## 一次性主机接入

管理员审查后安装固定的 `publisher_cd.py`、`publisher-cd.service` 和 `publisher-cd.timer`。固定入口本身不从应用仓库自动替换，也不自动修改权限、安全规则、运行时镜像或部署账号。应用 `scripts/publisher-service.mjs` 及 Publisher 业务模块随 release 更新。

root 所有的 `/etc/ai-report-publisher-cd.json` 明确指定 `base`、`control`、`state`、`publisher_config`、`unit`、`node`、`git`、`image`、`uid`、`gid`、`validation_uid`。这些值从已核实的服务布局取得，不能来自 Slack 消息。`control` 是 root 私有目录，初始 `active.json` 只记录已验证的线上 `commit`。验证账号与生产账号必须分离，沿用已安装、按摘要固定的容器镜像和 Node/Git 运行时。

接入前在隔离副本演练排空、失败恢复和状态保持；部署后核对真实版本、账本和健康，再启用定时器。定时器在上轮结束五分钟后检查，不保证 GitHub 或网络故障时仍按时更新。磁盘空间不足、接口限流、CI 未成功或账本需要对账均保留现役版本。历史 release 和操作证明暂不自动删除，应监控磁盘容量。

这套 CD 只部署 Publisher，不发送日报、不改变晨报日程。Pages 使用原有工作流；转发器、控制运行时与校验器由 brief 仓库自己的受限部署入口更新。
