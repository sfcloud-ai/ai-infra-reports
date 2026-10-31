# AI Infra Reports

AI 基础设施报告的独立公开档案。每天一个索引，每个主题一篇独立文章；完整分析、证据和图片在站内阅读。消息端长期格式为「本期子标题 + 已发布的日期索引 URL + 单张信息海报」。

站点直接复用 [MetriCraft](https://github.com/NagareWorks/metricraft) 的 Astro Shell、Doc、导航、Pagefind、主题与移动对话框代码，移除 SDK / Rust / playground 耦合，换用中性白灰和炭灰主题。来源固定在 728caaae2b59021c62731c6d54c3f515fe629811；许可与修改说明见 LICENSE、NOTICE。

## 本地验证

需要 Node 24.22.2 与 Git：

`npm ci --ignore-scripts --no-audit --no-fund`

`npm run check` 运行测试、档案校验、正式静态构建与 Pagefind 索引。正式 reports 为空，不夹带合成报告。

`npm run build:preview` 使用 tests/fixtures/archive 的合成样例，输出 dist-preview。预览：设置环境变量 REPORT_PREVIEW=1 后运行 `npm run preview -- --port 4178`，打开 http://127.0.0.1:4178/ai-infra-reports/。仅监听本机。

## 资料结构

- reports/YYYY-MM-DD/rN/report.json：本期元数据、子文章、来源条目、图片及摘要。
- 同目录 articles/主题-id.md：独立 Markdown 文章；禁止 MDX 与 frontmatter。
- 同目录 assets/*.png 或 *.jpg：带 SHA-256 与说明的公开图片。
- reports/index.json：从所有不可变版本重建的报告与事件索引，必须与内容在同一提交。
- 稳定网址：/ai-infra-reports/YYYY-MM-DD/rN/；子文章追加 /主题-id/。

版本从 r1 连续递增，发布后不覆盖旧文件。事件 ID 的内容和 update_of 不可变；同一事件有实质变化时分配新 ID，并引用先前相关 ID。规范化来源 URL、内容摘要与文章哈希共同防止历史证据重复发布。不同报告生成模型的评分/权重配置属于上游生产器，本库不将多个模型的权重混成一个值。

完整、可执行的示例在 tests/fixtures/archive；这些样例只用于测试。report.json 的 poster 可为 null（尚无推送海报），但不能用于满足通知发送门禁。生成器在发表前负责实质审校、公开信息检查与海报内容质量，机器校验无法证明文字没有敏感信息。

## 机器人与发布

详见 [机器人操作说明](docs/publishing.md)。已实现 GitHub App 提 PR、数据与路径门禁、受限合并和 Pages 工作流；默认保持禁用。生产者与可信合并 App 使用独立身份/私钥，并要求 main 更新权限与无 bypass 的质量规则分离；实际隔离需启用前负向联调确认。没有自动创建 App、密钥、权限、仓库规则或生产定时任务。

高权限流程只运行默认分支代码，通过 Git 对象 API 把 PR 内容当作数据校验，不 checkout 或执行 PR 脚本，不下载 PR artifacts。报告写入方不持有 Pages 部署权限。

Pages 成功后还需 `node scripts/verify-publication.mjs EXPECTED_COMMIT YYYY-MM-DD REVISION` 核对实际可访问页面。它不发送通知，也不能证明 Slack/企微送达。发布失败、页面版本不符或请求结果未知时，停止推送并核对状态，不自动补发历史消息。
