# 六主题缺页接续合同

此合同需要 Reports、Brief relay、page-scoped 审计/permit 同时兼容后启用；单独合入不代表正式投递已接通。历史 1.0/1.1 原包与原回执保持不变。

新报告 `schema_version=1.2` 增加 `page_delivery`：

```json
{"previous":null,"added":["model-serving-gpu"],"pending":[{"id":"hardware-status","reason":"实验条件尚待正文核验"},{"id":"model-architecture-status","reason":"模型卡变更尚待核验"},{"id":"embodied-training","reason":"训练论文正文尚待核验"},{"id":"small-model-status","reason":"质量成本证据尚待核验"},{"id":"inference-engines","reason":"PR diff 尚待核验"}]}
```

`articles` 和 `pending` 互斥划分全部六主题，按 `page-delivery.mjs` 的顺序；`added` 是本轮就绪页。首发 revision=1、previous=null、added=全部 articles，不带 revision_notice。未就绪页没有正文文件、URL 或 articles 条目。首发通知只列已验证链接，并追加“晨报说明”列出全部待补主题及具体原因。

补页 revision=N 沿原 report_date，用 `previous={request_id:morning-YYYYMMDD-r(N-1),bundle_sha256:原包哈希}` 绑定上轮；附 `revision_notice={kind:page_completion,summary:简短说明}`。完整当前网页源保留旧页，added 仅包含原 pending 中此次补齐的页；旧页标题、摘要和正文哈希不变。补充通知只列 added 的标题/URL，不重发旧页或整期海报。普通事实纠错仍须适用的独立修订协议，不能伪装成补页更改原已发送页面。

可信发布校验器从原包生成 `page_state`，存入 T4 原 scheduled 记录；其中保留 previous/added/pending 及每个就绪页的 id/title/sha256。补页准入须核对前次原请求/hash、complete/sent 和文字图片分项全送达。pending、sending、unknown 或部分送达不能换 rN 重试。重复同一原包返回原回执；冲突字节拒绝。全部失败及旧绑定保留。

小时任务读取原 T4 状态的 page_state.pending，从私有研究检查点继续；下一轮指下一小时 :20，不是第二天。任务投递 complete 只表示本批通知完成，pending 非空不表示整期研究完成。不能通过新 run 重开预算；审计/permit 必须按原授权关联后继包，尚未具备此能力时保留明确阻断而非绕过。

`page_delivery` 的 reasons 是公开单行文字，不得包含凭据、私有诊断或未验证 URL。固定原始证据、研究和编辑审计、原包/草稿哈希、Pages 原图校验仍必需；本文不授予上传或发送权限。
