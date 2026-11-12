# 模型与架构：Qwen4 预览接入变化，SinkState 重估循环状态

## Qwen4-Max 预览：先处理接口语义变化

Qwen 官方文档确认，Qwen4-Max-Preview 于 **11 月 11 日 10:00（UTC+8）**开始预览，至 11 月 25 日 24:00，结束后下线；仅通过 Token Plan 提供，不支持按量计费。它提供多模态输入和 1M 上下文，但所读发布文档未给出可据以计算本地 KV 容量的架构配置，不能沿用 Qwen3.8 的结构猜测新模型。[官方接入说明](https://docs.qwencloud.com/developer-guides/getting-started/latest-model)

实际接入变化是 `max_tokens` 与 `max_completion_tokens` 一样限制**思考加最终回答**，默认推理力度为 `xhigh`；原来按最终回答长度分配的预算可能使输出提前截断。Chat Completions 默认保留思考，多轮历史的 `reasoning_content` 应按协议回传，不拼进 `content`。这些会影响输出预算和调用状态管理；接口兼容并不意味着旧请求参数语义完全不变。

Qwen 博客动态页本轮未取得可读正文，以上事件由可读的官方发布记录和接入文档补证，没有把它称作已读博客或本地开源引擎已适配。

## SinkState：混合模型的循环状态不能按普通 KV 估算

**近七天未报补充：SinkState，2026-11-10 15:57:35 UTC 提交。** 它研究 Mamba2 与 Gated DeltaNet 混合模型中的循环状态，以自适应低秩表示降低状态存储和解码开销。价值在于改变状态管理的对象，而不是宣布另一款新模型。[论文](https://arxiv.org/html/2611.14246v1)

## 状态对象变了，内存公式也要变

普通全注意力 KV 随上下文累积；循环层维护的是不断更新的状态矩阵。SinkState 利用其中的低秩结构，保留低秩表示并缓冲更新，以局部 SVD 和异步 CPU 合并维持表示。其配置采用 8 步更新缓冲、局部保留 8 个分量。不能把这种状态直接当作一组可随意裁剪或跨请求复用的普通 KV 块。

![混合模型的两类状态及预算对象](assets/hybrid-state.png)

论文测试 Nemotron3-Nano-4B、Nemotron3-Super-120B-A12B、Qwen3.5-9B 和 Qwen3-Next-80B-A3B-Instruct，覆盖 Mamba2 与 Gated DeltaNet。四个模型的测试都使用一张 RTX PRO 6000 Blackwell 96GB GDDR7、PCIe 5.0 和双 Xeon 6515P；4B/9B 为 BF16 权重，大模型为 NVFP4 权重与 FP8 KV，循环状态均为 FP32。

## 减少的是循环状态内存，不是整卡占用

与对应的 Mamba-SSM/FLA 稠密状态基线、相同 batch 比较，峰值状态内存降至 0.38–0.63 倍，解码加速几何平均为 1.25 倍、最高 1.58 倍。权重、普通注意力 KV 和其他缓冲仍要单独计算；权重或 MoE 开销主导时，状态优化带来的整体收益更有限。

在 GSM8K、MATH500、IFEval、IFBench、GPQA、LiveBench 的 24 个模型—任务配对中，准确率变化为 −1.6 至 +2.6 个百分点。因此不能称严格无损，也不能声称所有任务精度不变。论文没有给出 H100、H200 或 Pro5500 的同条件结果。

**适配判断：**调度器与缓存管理器需要区分 attention KV、循环状态、更新缓冲和 CPU 合并任务；暂停、恢复、卸载与跨节点传输必须保存完整状态及其更新位置。仅修改 KV dtype 或沿用按 token 计算的全注意力容量公式，不足以完成适配。本期没有取得 SinkState 已进入 vLLM/SGLang 稳定版的证据，不能把论文实现写成现成配置开关。

GLM 的实际引擎变化另见[统一引擎栏目](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-12/inference-engines/)中 DFlash 草稿 FP8 KV 和 DSA CPU 卸载修复。本轮通过官方页面静态资源读到 GLM-5.3-Flash 的架构文章，原发布日期为 8 月 26 日，未重新计作新闻；博客列表与部分模型发现入口仍有覆盖缺口，本篇不冒充三家最新模型发布的全量核查。
