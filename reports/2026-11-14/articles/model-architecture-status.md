11 月 13 日，NVIDIA 发布了 **GLM-5.3 NVFP4 在两台 DGX Station 上运行的部署实测**。这次增量是具体的软件配置、权重分片和并发测量。GLM-5.3-Flash、Qwen3.8-Flash-Next 的混合架构则是已有背景，用来说明接入不同模型时，哪些内存可以分片、哪些状态必须随请求一起管理。

### 双机让权重装得下，剩余空间仍要留给请求

实测采用两台 **GB300 DGX Station**，每台 GPU 有 252GB HBM3e，经选定的 **400Gb/s ConnectX-8 RoCE** 链路连接。模型是 **GLM-5.3：753B 总参数、每 token 激活约 40B**；NVFP4 checkpoint 约 464GB。这里要与 **320B 总参数、18B 激活的 GLM-5.3-Flash** 区分。

vLLM 的 **TP=2** 把同一个模型的张量分到两个 rank。每个 token 的计算都需要两端通信；入口由 Station A 提供，Station B 是 worker。两台机器各保留完整的磁盘 checkpoint，加载后每张 GPU 约有 218GiB 权重。无请求时约 231.35/231.34GiB 的 GPU 总占用还包含 KV 与运行缓冲，不能全算成权重。

```text
请求 → Station A：API + rank 0 ← RoCE 通信 → Station B：rank 1
             两个 rank 共同计算同一个模型的每个 token
```

这套配置关闭 CPU 权重卸载，使用固定摘要的 `vLLM v0.30.0-aarch64` 镜像、FP8 KV、前缀缓存和每步四个 MTP 草稿 token；上下文上限为 98,304 token。NVFP4 针对特定 MoE 线性权重与激活，不能把全部张量都按四位估算。增加一台机器解决了常驻权重容量问题，KV、临时工作区和通信开销仍要单独预算。

### 并发翻倍，吞吐已经越过拐点

AIPerf 0.12.0 使用 SPEED-Bench Coding 的 80 个会话、89 轮输入，按 `3×并发数` 暖机、`10×并发数` 测量；高并发会重复部分会话。测试开启前缀缓存，采用默认 `max` 推理力度和 8,192 token 输出上限，输出统计包含 reasoning token。

| 配置并发 | 总输出吞吐 | 平均请求延迟 | 平均首 token 延迟 |
| --- | ---: | ---: | ---: |
| 16 | 607.8 tok/s | 136.4 s | 482.90 ms |
| 32 | 385.0 tok/s | 453.5 s | 899.36 ms |

因此，“装得下模型”之后，还要寻找负载下的合适并发。提高并发到 32 已经同时损伤吞吐和平均延迟。这里没有 p99 数据，也没有关闭 MTP 的对照，不能把整套配置的吞吐全部归给草稿解码，或用平均值承诺在线尾延迟。

上述数据来自 **2×GB300 的单模型服务**。H100/H200 的精度内核、容量和互连条件不同，必须重新建立同硬件基线；**Pro5500（型号待核实）**不作兼容承诺。不同模型仍有独立权重，TP 分片本身没有证明跨模型超配收益。

原文与完整复现条件：[NVIDIA 双 DGX Station 部署文章](https://developer.nvidia.com/blog/when-one-gpu-isnt-enough-serving-glm-5-3-across-two-nvidia-dgx-stations-with-vllm/)，发布于 **2026-11-13 17:00 UTC**。

### 混合模型要分别管理 KV、循环状态与查表权重

以下是接入时需要保留的机制背景，不计作本日新模型发布。

**Qwen3.8-Flash-Next** 的 48 层由 12 组“3 层 Gated DeltaNet + 1 层 Qwen Sparse Attention”组成。GDN 把历史压入固定大小的循环状态；QSA 用微块索引选择上下文。其主干为 125B，另有 51B n-gram embedding 和 4B MTP，6B 激活参数不代表常驻权重大小。

n-gram 表的查询位置可提前确定，因此可以放在主机内存并异步预取。这类模型权重的驻留，与请求 KV、稀疏索引和循环状态的生命周期不同。做前缀复用、请求分叉、抢占恢复或草稿回退时，应分别验证这些对象的身份、位置与一致性，不能把固定大小的循环状态套进普通全注意力 KV 的容量公式。这里是由机制导出的验证要求，不代表各引擎已经实现相同的卸载和复用策略。

**GLM-5.3-Flash** 采用线性与稀疏注意力的混合设计，并用 IndexPool 将四个索引 key 加权池化为一个。官方文章描述了 SGLang 定制栈中的 ReplaySSM、混合缓存精度和分离部署；这与上面的 GLM-5.3 NVFP4 双机实例属于不同模型和部署条件，配置与性能数字不能相互套用。

模型卡给出了 Flash-Next、GLM-5.3-Flash 的 vLLM/SGLang 接入入口。本页核实了这些官方声明，但尚未逐一确认它们全部功能的最低上游稳定版本；部署时应按目标模型、缓存精度、草稿路径和并行方式核对具体 recipe/commit。DeepInfer 的既有离线支持范围也不能扩写为这两个模型的在线服务支持。

**DeepSeek-V4.1-Flash-1017** 的现有模型卡还明确要求协议感知的编码实现，没有提供 Jinja chat template；消息、思考和工具调用的编码与解析需要单独验证。本轮未据此新增模型发布条目。已经核实的 Rubin 服务技术文保留在[推理引擎每日变动](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-14/inference-engines/)，不重复计算事件。

机制来源：[Qwen Flash-Next 官方文章](https://qwen.ai/blog?id=qwen3.8-flash-next)、[Qwen 模型卡](https://huggingface.co/Qwen/Qwen3.8-Flash-Next)、[GLM-5.3-Flash 官方文章](https://z.ai/blog/glm-5.3-flash)、[GLM 模型卡](https://huggingface.co/zai-org/GLM-5.3-Flash)、[DeepSeek 模型卡](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017)。

### 下一步：用同硬件基线检验真正的容量收益

在 H100/H200 上，先分别测出权重、KV/循环状态、临时工作区与安全余量，再测多模型并驻下的队列、回取带宽和 TTFT/p99。对循环状态与稀疏索引加入请求分叉、抢占恢复和草稿回退场景。只有容量增益、状态正确性与服务延迟都满足目标，才有依据推进超配配置。

核查范围保持本期原 **11 月 14 日 07:20（北京时间）**截点。此次读到的 Qwen 官方研究列表包含 40 篇文章，最新日期为 9 月 20 日；Flash-Next 的列表时间与正文页头分别为 8 月 26 日、8 月 3 日，均作为旧背景。GLM 已读的是模型卡链接的具体官方文章，日期为 8 月 26 日；博客列表入口仍返回 404，因此没有据此断言全站或云端文档“没有更新”。
