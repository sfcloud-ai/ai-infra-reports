# 模型与新架构｜服务能力、缓存结构与可部署性分开判断

本期关注 11 月 9 日发布的 Meta Muse Ember，以及混合状态与 Kimi 缓存分片的机制。模型 API 发布、引擎实现与架构细节不是同一类证据，不能因为模型名字或目录更新时间变化就认定有新的架构突破。

新闻截止点沿用北京时间 11 月 10 日 10:19；本轮补读晚于截止点。文章按一手页面发布日期标注，11 月 4–6 日材料为近七日补读，不冒充当日新闻。页面状态按本期复核时所见表述。

## Muse Ember：高频代理子任务的 API 模型，未披露自托管条件

[Meta 11 月 9 日发布](https://research.meta.ai/blog/muse-ember) 将 Muse Ember 定位于工具调用、代码子任务、路由、抽取和长文档处理。官方说明它原生理解文本、图像、音频和视频，提供 1M 上下文与最高 512K 输出，通过 Meta Model API 和 Muse Code 提供，模型名为 muse-ember-1.0，支持 Responses API。

官方页面仅给日期，本期未核实其精确发布时间与时区，因此按七日补充纳入，不断言落在原 24 小时窗口。

价格必须与上下文档位一起看：提示不超过 200K token 时，每百万输入、缓存输入、输出分别为 0.10、0.004、0.50 美元；超过 200K 后分别为 0.30、0.012、1.50 美元。不能把低档价格直接用于 1M 上下文成本估算，也不能只按牌价推算实际代理工作流节省。

官方称它是该系列最小、最高效的模型，但所读材料未披露参数量或开权重下载，没有 H100/H200 或消费卡自托管需求与性能证据。这里确认的是 API 能力与定价，不是一个可直接采购硬件部署的开放小模型，也没有足够细节据此宣称新的内部架构。

[评测报告](https://research.meta.ai/static/muse-ember-evaluation-report) 对内部对比使用任务特定共同 harness，但专有竞品设置是 best effort；外部编码基准仍保留供应商各自 harness，Terminal-Bench 4.0 不是同一代理框架下的严格对照。FrontierCode 2.0 表中仍落后 Claude Haiku 5.5，OSWorld 的 partial-credit 和严格成功率也不能混用。本期没有运行模型，适合先在固定工具调用或抽取任务上测准确率、重试率、总延迟及账单，而非概括为全面超过同类。

## 混合模型：KV 还在，状态丢了仍要重算

[SGLang #49430](https://github.com/sgl-project/sglang/pull/49430) 于北京时间 11 月 10 日 10:08 提出，复核时仍未合入。

KDA、GDN 或 Mamba 与 attention 混合后，恢复某个缓存前缀还需要对应的 recurrent state。状态池通常比 KV 池紧张。作者给出的 GLM-5.3-Flash NVFP4、2×B200、TP2、默认池配置中，KV 池可放约 297 万 token，但只有 419 个 state slots，每个运行请求要用 5 个。会话等待工具返回时，KV 可能仍在，最近的状态却已经被逐出，恢复只能退回更早状态甚至 token 0，再做一次长 prefill。

提案加入 GreedyDual-Size 状态淘汰策略。优先级由老化水位加重建成本组成，重建成本从最近仍保留的祖先状态算起；容易补回的状态先淘汰，长会话唯一的有效状态更值得保留。Full KV 仍按 LRU 排序，策略在 Python 与 Rust 两种树实现中都提供，默认关闭，混合模型下不兼容 --enable-session-radix-cache。

基于 coding-agent traces 的 CPU 调度模拟中，64 sessions 下每请求平均未缓存 token 由 10,276 降至 6,820。但中位数没有改善，说明主要修的是少量大幅回退的尾部。另一组 1×H200 测试使用 dummy 8-layer 模型，后两轮输出吞吐约增加 9%；它不是完整 GLM-5.3-Flash 的生产实测，部分轮次还有客户端错误。原文中的完整 B200 模型实验仍等待补充。

实际可用的观察指标因此不应只有 KV hit rate，还包括状态池压力、KV 仍在但 state 缺失的重算 token，以及长会话恢复尾延迟。

![KV与recurrent state共同决定前缀可复用，外部容量还受回载带宽约束](assets/state-and-bandwidth.png)

## Kimi K3.1：PCP 拆计算，不代表 KV 已分片

[SGLang 的 Kimi K3.1 Pro 官方文章](https://www.sglang.io/blog/kimi-k3.1-pro-day0-support) 标注发布于 11 月 4 日，属于近七日技术文章，不是今日新发布。文中有两处容量规划细节值得保留。

第一，当前 prefill context parallelism（PCP）分配的是计算工作，DSA KV 在 CP group 内仍然复制。Decode context parallelism（DCP）才按 token 将 KV 与 index cache 分片；不能看到“context parallel”就按卡数等比例扣除缓存占用。

第二，32×H200 的 LoRA rollout 中，把 attention 从 TP32 改成四组 DP-attention，可在 256 running requests 时把每卡 KV 从 16.9 GiB 降至 4.2 GiB，decode step 从 202.6 ms 降至 166.6 ms。但在 64 requests 时，step 反而由 110.5 ms 增到 136 ms。减少重复 KV 和跨节点 attention 通信确有价值，吞吐收益仍依赖负载是否足够高。

这篇文章的 Day-0 recipes 使用 preview images，不能写成 stock SGLang release 已全部支持。上述硬件结果是指定 LoRA rollout 配置，不外推任意 H200 部署或 H100。

## 研究范围

这里保留的是已读的具体 API 发布、混合状态提案和 Kimi 官方机制文章，不声称覆盖全部新架构。Qwen CPU PLE 表在[引擎变动](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/inference-engines/)中讨论，那是同一 engine 的实现优化，不等于发布了新模型架构。独立文档专用 2B 模型的证据与缺口见[前沿小模型](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/small-model-status/)。

本轮还补查了 [Qwen](https://huggingface.co/api/models?author=Qwen&sort=lastModified&direction=-1&limit=50)、[DeepSeek](https://huggingface.co/api/models?author=deepseek-ai&sort=lastModified&direction=-1&limit=50)、[GLM](https://huggingface.co/api/models?author=zai-org&sort=lastModified&direction=-1&limit=50) 官方 Hugging Face 组织按 lastModified 排序的各前 50 项及代表提交。Qwen3.8-27B 的 [11 月 7 日提交](https://huggingface.co/Qwen/Qwen3.8-27B/commit/37561816e66b5b9153b1b64c10968c18c1e6f4a0) 改的是 response template/generation tags，2.4T-A95B 也属同类模板工作，不计作新架构或权重发布。

DeepSeek-V4.1-Flash-1017 的 [模板提交](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/commit/08c8657f02291e11b6f6b63e0e16014f8e748518) 时间为 11 月 10 日 02:22:56 UTC，比原截止点晚 3 分 35 秒；所见仅新增 chat_template.jinja，不改权重，不回填原新闻窗口。[API Change Log](https://api-docs.deepseek.com/updates/) 的最新模型公告仍为 10 月 17 日。zai-org 所查 50 项中最新变更为 10 月 15 日，未见七日内条目更新。

这些结果只覆盖上述入口。Qwen 博客正文仍只取得应用壳，Z.ai 博客路径未成功读取完整文章；它们不是“所有官方来源没有新闻”的依据，也不能排除 API 或其他组织内更新。
