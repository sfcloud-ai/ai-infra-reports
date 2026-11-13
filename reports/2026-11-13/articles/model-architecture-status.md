# 模型与架构：混合状态已见，模型卡变更待核

**本栏为状态说明，不重复计算主文新闻。** Inkling 2 Small机制与引擎影响见[技术主文](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-13/model-serving-gpu/)。它有594B总参数、17B激活参数，48层、384专家top-8，前40层专家采用NVFP4、后8层MXFP8，接受文本与图像，支持最多1M上下文。17B是每次激活规模，不是必须常驻的全部权重大小，不能直接据此估算显存。

block attention residuals、局部/全局混合注意力和短卷积使运行状态不止传统KV。推断上，容量测算应同时关注这些状态；确切字节数、共享生命周期和回收边界仍需实现与实测证据，不能硬套单一KV公式。

## 其他模型源的实际缺口

- [GLM博客](https://z.ai/blog)返回404；[sitemap](https://z.ai/sitemap.xml)只有所读目录，不能替代技术文章核验。
- [DeepSeek模型列表](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&limit=5&sort=lastModified)显示近期修改线索，但未读具体模型卡diff。修改时间不等于架构发布。
- [Qwen模型列表](https://huggingface.co/api/models?author=Qwen&direction=-1&limit=5&sort=lastModified)只覆盖所读前5项，没有完整模型卡证据；[新博客](https://qwen.ai/blog)仅取得动态外壳，[旧博客入口](https://qwenlm.github.io/blog/)不能证明新站完整覆盖。
- [DeepSeek官方动态](https://www.deepseek.com/news/)及[官方infra索引](https://github.com/deepseek-ai/open-infra-index)在所读范围未形成合格新条目，不声称所有文章已全量查清。

上述缺口不是无更新，未核实线索不列入新闻。
