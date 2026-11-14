本篇将 **vLLM、SGLang、DeepInfer** 放在一起，分别说明代码变化、技术文章与核查边界。代码以原定 **11 月 14 日 07:20 北京时间**为截点；两家活跃仓库的提交分页已覆盖此前 24 小时，截点之后的提交不计入。11 月 12 日的技术文章属于扩展至 72 小时的内容，不称为今天刚发布。

### vLLM：先回收暖机占用，再测 KV 容量

**11 月 13 日 21:10 UTC** 合入的 #67485（`b73d3762`）调整 extensible KV cache 的启动顺序。内核暖机可能提交接近全部缓存块；随后做 KV sizing warmup 又需要临时缓冲区，两者叠加可能造成启动内存压力。

本次在 `run_kv_cache_sizing_warmup` 之前执行 `commit(min_committed_blocks, shrink=True)`，把暖机遗留块缩回最低提交量。它与此前“CUDA Graph capture 前回收”的修复不同：回收点前移到容量测量之前，连 `enforce_eager` 路径也覆盖。新增测试使用 Qwen3-0.6B，检查容量测量前提交块已经缩回。

这能解释一个具体启动峰值来源，不能据此宣布所有 OOM 已解决。更新策略应核对实际部署版本是否包含这个提交，并在相同并驻模型和启动次序下观察峰值；本期没有把上游测试描述成我们在目标 GPU 上做过性能实测。

#### Rubin 技术文：先看 token 怎么计数

11 月 12 日的 DeepSeek-V4.1-Flash / Vera Rubin NVL72 技术文，比单个提交更完整地解释了系统路径：Rubin 特定内核与内存布局、不同并行方案、推测解码，以及 KV/embedding 数据放置共同作用。它同时包含外部 FlashInfer 路径和引擎侧融合，不能把全部组合收益归给某一个算子。

最容易误读的是文中的 **1.7M tokens/s/GPU**：该口径包含**缓存输入、未缓存输入和输出 token**，不是每秒生成 170 万输出 token。**58×**比较也绑定了特定 AgentX 负载及 **P90 387 tokens/s/user** 的交互约束。

低延迟 TP8 与高吞吐 DEP32 不是同一套配置。低延迟实验使用固定的 DSpark 接受长度 **3.51**；部分 DEP32 target-forward 对比来自单台 4 GPU 的模拟，不能写成整套线上真实生成结果。远端 KV 池与 Engram embedding 的分片对象、通信路径也不同，不构成不同模型共享权重的前提。

这篇文章的实际价值是拆解瓶颈与计量口径。迁移到 H100/H200 时，应重新验证模型状态布局、内核与通信路径，不能沿用 Rubin 的 FP4 和存储架构收益；Pro5500 型号仍待核实。此前已报的 EPD、Inkling2 Small 事件没有重复当成新消息。

### SGLang：`non_blocking` 之前还要看 host 内存

**11 月 13 日 21:11 UTC** 合入的 #49633（`0e509eaf`）针对 HiCache **kernel backend 的 host indices**。原路径从 pageable CPU 内存上传索引，即便调用标了 `non_blocking=True`，也可能发生等待；新公共函数 `async_h2d_tensor` 在支持时先 pin CPU tensor，再发起 H2D，cache controller 与 unified pool 共用该逻辑。

这里改的是索引控制数据，不是宣称全部 KV payload 都改成 pinned 或所有搬运都已优化。CUDA Confidential Computing、CPU 目标或不支持 pin 的环境有回退，设备上已有的 tensor 也不额外 pin。应通过 profiler 核对主机等待和 stream 重叠，再观察请求尾延迟；该提交没有给出可直接引用的在线吞吐提升百分比。

博客另行核查了 SGLang 官方列表、LMSYS 的 Neuron、Vera 训练沙箱和 NIM 正文。后几篇只有日期粒度，尚不足以满足本期候选完整时间戳要求，保留为待核线索，不伪造午夜或把它们说成没有更新。Vera 文章中的推理加速情景推演，也不能转写为 H200 训练已实测得到的加速。

### DeepInfer：提交检索结果与当前能力边界分开

官方提交请求从 **11 月 6 日 23:20 UTC**起返回空列表；另行读取了 DeepInfer README 和 open-infra-index。因此，本节不虚构一条新发布，也不从空列表推出“整个项目没有进展”。

当前 README 的重点是离线推理，列出的 GPU/平台包括 **SM100 NVIDIA 与 Ascend 950**，支持矩阵不能直接外推到 H100/H200。README 还明确没有集成完整 KV cache 系统、P/D 分离和负载均衡，不能把它当成与完整在线服务直接等价的替换件。DeepInfer 与 FlashInfer 是不同项目。

下一步若评估它的内核或并行实现，应先选定支持的平台和模型，再把离线计时与在线系统需要的缓存、调度、容错成本分开测量。

原始来源：[vLLM #67485](https://github.com/vllm-project/vllm/commit/b73d37629f66290cf0c40f68b3b4db2ce248d31c)；[vLLM Rubin 技术文](https://vllm.ai/blog/2026-11-12-deepseek-v41-flash-vera-rubin)；[带发布时间的原 Markdown](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-12-deepseek-v41-flash-vera-rubin.md)；[SGLang #49633](https://github.com/sgl-project/sglang/commit/0e509eaf4c7d20aae67c76bf1838ff9d5975d51e)；[DeepInfer README](https://raw.githubusercontent.com/deepseek-ai/DeepInfer/main/README.md)；[DeepInfer 原窗口提交查询](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?per_page=100&since=2026-11-06T23%3A20%3A00Z)。
