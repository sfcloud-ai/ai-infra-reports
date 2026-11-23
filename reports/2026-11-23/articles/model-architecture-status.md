# 模型与架构：Nemotron Shortcut 在 vLLM 中如何选注意力键、维护循环状态和分发专家

部署 Nemotron Shortcut 时，输入 token 会走多条计算路径。vLLM 于 11 月 22 日 21:04 UTC 将文本、MTP 和视觉语言适配合入 main。对缓存容量和通信调度最有影响的三步，分别是稀疏注意力的选键、循环混合器保存状态，以及专家分发何时启动。[PR #68198](https://github.com/vllm-project/vllm/pull/68198) · [#68198 文件差异](https://api.github.com/repos/vllm-project/vllm/pulls/68198/files?per_page=100)

稀疏注意力先由索引器为每个查询选择 Top-K 个键，MQA 核心随后读取这些键。Gated DeltaProduct（GDP）混合器维护循环状态。Shortcut MoE 的路由专家可以读取块输入，因此可以在混合器完成前启动专家分发。估算显存时，需要把索引器缓存、注意力 KV 以及循环状态分开核算；仅知道每次选 K 个键，无法得出模型的实际常驻显存。[PR #68198](https://github.com/vllm-project/vllm/pull/68198)

作者的验证环境是一台配备四张 GB300 的节点。组合使用了 main 的编译扩展，以及叠加 #67941、#68353 的 Python 源码。模型配置和图像处理器来自 checkpoint；NVFP4 KV 路径另有 FlashInfer 版本依赖。因此，复现前应固定 checkpoint 和依赖，并分别验证文本、MTP、图像输入。[PR #68198](https://github.com/vllm-project/vllm/pull/68198)

对同卡多实例，先核对每个实例的设备拓扑与显存限额，再分别验证同一检查点的权重共享，以及索引器、KV 和循环状态的分配与回收。现有材料支持 vLLM 的代码适配和上述组合下的作者测试。模型厂商何时发布、哪些权重公开，以及独立受管缓存是否可用，仍需相应的一手证据。

本窗还核对了智谱、DeepSeek、Qwen 在 Hugging Face 的官方模型目录，分别返回 154、106、469 项。逐项核对创建时间与最后修改时间，两种时间在本期窗口内都没有命中。这些日期界定了三个 Hugging Face 官方组织目录的范围。[智谱官方模型目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [DeepSeek 官方模型目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [Qwen 官方模型目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)

## 模型目录和厂商文章分别查到了什么

Qwen 的置顶原帖给出了 Qwen4-Max API 的可用时间。北京时间 11 月 16 日 10:01:55，官方账号宣布 QwenCloud 已开放 API，并称该模型采用 MoE、原生支持视觉、上下文为 100 万 token。11 月 12 日晨报已报道 11 月 11 日开启的限期预览。这次公告补充了 API 可用性，早于本期 24 小时主窗和 72 小时回溯窗。原帖没有提供 Max 可下载权重，也没有本地引擎、缓存管理或多实例共享的验证数据。原帖对较小规格开放权重的描述仍是预告。[Qwen 官方原帖](https://x.com/Alibaba_Qwen/status/2122148127520289151)

原帖链接到 Qwen 同一篇官方文章。英文接口所收 41 篇文章中，有 18 篇的目录日期与正文发布日期不同；Qwen4-Max 的目录标注 11 月 16 日 10:00，正文署名及发布元数据为 8 月 3 日。API 公告的时间来自原帖。三家官方账号的响应各可辨认 5 条本账号帖子，这个范围不足以排除其他公告。[Qwen 官方文章](https://qwen.ai/blog?id=qwen4-max) · [英文文章接口](https://qwen.ai/api/v2/article/retrieval?language=en-US&type=qwen_ai) · [智谱官方账号](https://x.com/Zai_org) · [DeepSeek 官方账号](https://x.com/deepseek_ai)

智谱、DeepSeek、Qwen 的 ModelScope 组织目录各返回按修改时间降序排列的前 50 项，三组末行均早于本窗下界。已读记录的创建和最后修改时间均无窗内命中。DeepSeek 的 GitHub 组织查询只命中 deepseek-harness 的仓库推送，API 更新日志可见的最新条目标为 11 月 13 日。一次仓库推送不足以确定有新模型或新权重。[智谱 ModelScope](https://modelscope.cn/openapi/v1/models?owner=ZhipuAI&page_number=1&page_size=50&sort=last_modified) · [DeepSeek ModelScope](https://modelscope.cn/openapi/v1/models?owner=deepseek-ai&page_number=1&page_size=50&sort=last_modified) · [Qwen ModelScope](https://modelscope.cn/openapi/v1/models?owner=Qwen&page_number=1&page_size=50&sort=last_modified) · [DeepSeek 组织推送记录](https://api.github.com/search/repositories?order=desc&page=1&per_page=50&q=org%3Adeepseek-ai+pushed%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated) · [DeepSeek API 更新日志](https://api-docs.deepseek.com/updates/)

智谱博客返回 HTTP 404。中文研究页可见 15 条带日期的记录，最新为 8 月 26 日，页面还有“查看更多”。站点地图的 29 项均标最后修改于 11 月 18 日，未列出该博客路径。博客文章仍有覆盖缺口。[智谱博客入口](https://z.ai/blog) · [智谱研究页](https://www.zhipuai.cn/zh/research) · [站点地图](https://z.ai/sitemap.xml)
