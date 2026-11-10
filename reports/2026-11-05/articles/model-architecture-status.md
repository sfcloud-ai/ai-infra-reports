# 模型与新架构｜本轮未新增合格的 GLM DeepSeek Qwen 架构发布

本轮按 24 小时、72 小时再至 7 天窗口核查官方模型索引和项目入口，没有找到足以独立收录、同时具备新架构与缓存适配证据的 GLM、DeepSeek、Qwen 发布。这里是已检查来源的筛选结果，不是断言所有渠道都没有消息。

- **GLM：**官方 Hugging Face 按最近修改排序，最新的 GLM-5.3-Flash-BF16 主线更新时间为 2026-10-15 06:53:11 UTC；官方 GLM-5 仓库最近 push 也早于窗口。此次不把旧权重或旧 chat-template 变动当新架构。
- **DeepSeek：**最新主线模型 DeepSeek-V4.1-Flash-1017 更新于 2026-10-17 05:46:55 UTC，早于窗口。LeanSparse 研究的是 DeepSeek-V4-Flash 的 CSA 索引键/KV 生命周期，是第三方服务系统论文，不是 DeepSeek 新模型发布；机制与 H100 证据统一见模型服务栏，不重复计一条。
- **Qwen：**官方模型索引最新修改为 Qwen-Image-2.1-Turbo，2026-10-12 09:45:49 UTC。组织页近期活动中的 Qwen3.8-Flash-Next [IFBench 结果 PR #80](https://huggingface.co/Qwen/Qwen3.8-Flash-Next/discussions/80)只是向 `.eval_results` 加已有分数，且讨论涉及评测口径映射，仍 open；没有更改架构、权重或缓存布局，不入选。

来源：[GLM 官方模型索引](https://huggingface.co/zai-org)、[DeepSeek 官方模型索引](https://huggingface.co/deepseek-ai)、[Qwen 官方模型索引](https://huggingface.co/Qwen)。带时间戳的官方 API 读取及组织仓库记录保存在证据记录中。Hugging Face API 首次经网页工具访问失败，随后通过同一官方 API 直接读取成功，已补齐时间戳；[Qwen 官方博客](https://qwen.ai/blog)仍未返回可读正文，不能把该博客入口算成完成全文检索。

引擎适配状态由推理引擎栏目独立核查；LeanSparse 仅有“在 SGLang 上实现”的论文证据，本轮未找到对应公开实现/合并/发布版本，不能写成 SGLang 正式版本已经支持。
