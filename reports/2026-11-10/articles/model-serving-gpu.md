# 模型服务与 GPU 超配｜先分清隔离共驻、路由和卸载

提高 GPU 利用率有几条不同路径：固定分区让独立模型共驻，路由避免同一模型重复计算，权重与 KV 卸载扩大可承载容量。这些机制解决的问题不同，不能把各自数字相加成多模型超配收益。本期结合外置 KV、内存带宽与三项相关进展，分别核对适用条件和部署边界。

新闻截止点沿用北京时间 11 月 10 日 10:19；本轮补读晚于截止点。文章按一手页面发布日期标注，11 月 4–6 日材料为近七日补读，不冒充当日新闻。页面状态按本期复核时所见表述。

![独立模型分区、缓存路由与权重卸载对应不同资源边界，不能混称跨模型共享](assets/serving-boundaries.png)

## SageMaker MIG：独立模型共驻，但分区仍是静态容量

[AWS 11 月 6 日官方公告](https://aws.amazon.com/blogs/machine-learning/sagemaker-inference-now-supports-multi-instance-gpu-to-maximize-gpu-utilization-for-model-endpoints/) 为实时 inference component 端点加入 GPU 分区支持。每个模型组件的一个副本占用一个 MIG 分区，计算与显存按 profile 固定隔离。不同模型仍有各自权重、KV 和运行时；这不是显存动态超配，也不共享跨模型 KV。

[Developer Guide](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-components-accelerator-partitioning.html) 的约束会直接影响部署设计：布局在创建端点时确定，运行中不能通过 UpdateEndpoint 更改；换布局需新端点并迁移流量，组件换分区类型也需新建。主机 CPU、内存、存储、网络和端点路由仍共享，不能当成完整租户隔离。单模型端点、serverless 和异构实例池不在此能力范围。

官方基准用 Llama-3.1-8B-Instruct，对比一个 H100 的 mig-3g.40gb 与一个完整 A100 40GB，双方各测试一个模型副本，不是 16 个独立模型同时满载的共驻实测；覆盖五类输入/输出形态及并发 2–512。在每类流量成本收益最大的负载点，作者报告输出吞吐高 53–89%；越过各自交叉点后，每百万输出 token 成本低 18–34%。低并发和短输入时，完整 A100 仍可能更便宜；长输入高并发时 A100 出现较多 serving deadline 失败，不能脱离成功率解读曲线。完整 dtype、量化、调度参数没有在基准段全部给清，本期未独立复现。

这里的成本是整实例价格除以可用单位的分析分摊，并非单独 MIG 切片的售价。实例小时费用没有因为分区而下降，其他分区确实被有效利用才有意义。H100 的 3g.40gb 是 3/7 计算资源与 4/8 显存，不能称恰好半张卡的算力。支持 SKU、监控限制与 H200 的缺项见[重点硬件](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/hardware-status/)。

## Kinference：让请求去已有前缀的 worker，不搬运模型状态

[vLLM 11 月 4 日介绍](https://vllm.ai/blog/2026-11-04-introducing-kinference) 的 Kinference 是基于 Kubernetes/vLLM 的控制面。它观察 KV-cache events、队列等状态，用预测 TTFT 选择 worker，核心是少做重复 prefill，而不是合并各 worker 或不同模型的权重、KV。

[Buoyant 同日基准](https://www.buoyant.io/blog/distributed-inference-benchmarks-kinference-vs-plain-kubernetes) 使用 vLLM 0.31.0、Qwen3.8-27B-FP8，两组各三个单 L40S pod，对比普通 Kubernetes 随机连接路由。共享 16K 前缀负载下，TTFT 中位数由 6.88 秒降至 0.31 秒，峰值 goodput 约为基线 7.4 倍。这里的 goodput 是满足实验 TTFT 阈值的吞吐：共享前缀要求 90% 请求不超过 8 秒，多轮不超过 4 秒，不能当成交互聊天的通用验收标准。无共享前缀的对照中，TTFT 中位数没有显著差异；固定低到达率下，两侧输出吞吐也基本相同。

采用前要看实现而不只看宣传。[本次固定版本 README](https://github.com/Kinference-AI/kinference/blob/c12a4c8f1ecf22f09280652d75eee9deb54470de/README.md) 明确称 alpha、尚无持续生产验证，Known limitations 仍列出 /v1/messages、rate limiting、semantic classifiers 和 multiple replicas 缺失。最后一项是控制面实现限制，不代表基准只有一个 vLLM worker。它值得评估 KV-aware 路由，但不能把愿景功能写成生产网关已全部交付。

## Bevy：用请求交错隐藏专家权重从 SSD 读入的等待

[Bevy 预印本](https://arxiv.org/abs/2611.04794) 的 v1 提交时间为 11 月 3 日 12:30:30 UTC，位于本期七日扩窗内。它面向单个 MoE 模型的专家权重放不下的情况：让专家已就绪的请求先进入下一层，提早暴露确定的专家需求，再把读取与其他请求计算重叠；同时优先照顾落后的层，并动态合批。这与预测未来要用哪个专家再预取不同。

[论文正文](https://arxiv.org/html/2611.04794v1) 在 llama.cpp 上实现 Metal/CUDA，使用 M6 Mac mini 和 Jetson AGX Thor、Q4_0 的 Qwen3.6-35B-A3B 与 Gemma4-26B-A4B，报告 decode 吞吐相对 llama.cpp 为 1.26–3.46 倍、相对最快预取基线为 1.01–1.55 倍。平台均为统一内存，专家来自 SSD，不是 H100/H200 多模型共驻实验。

数字还有采样限制：实验覆盖 2–16 请求及 30% 专家缓存，另在 8 请求下改变 10–70% 缓存；512 步中前 256 步用于预热，各系统比较都排除了观测到 SSD 读取变慢的步。论文没有给出端到端在线 p99 或 SLO 结论，本期也未确认独立可部署代码，不能写成已集成上游 llama.cpp。它补足权重卸载方向，但仍不提供不同模型共享权重或 KV 的证据。

## XM-Sparse：外置 KV 的容量与带宽要一起扩

[LMSYS 的 XM-Sparse 文章](https://www.lmsys.org/blog/2026-11-04-xm-sparse/) 页面日期是 11 月 5 日，尽管 URL 含 11 月 4 日。文章由 Netpreme 团队撰写，讨论用外部高带宽内存承载完整 KV，GPU 只保留热点缓存与 indexer。

核心问题是：稀疏 attention 每步只读取部分 KV，但仍要保留完整历史，因为下一步选中的位置会改变。增加外部容量可以支持更多并发；如果回载带宽不够，新增并发也会带来更多 I/O 等待。

测试环境必须与标题里的收益一起读：4×B300 负责 decode，另外 4×B300 的 HBM 模拟外部 memory banks；使用 synthetic KV、固定 20% 或 40% miss rate，并关闭 prefetch。24 TB 是用于限定 batch 的容量预算，不是这八张 GPU 实际装出的 24 TB 内存；X-Mem 芯片本身尚未交付。

在 16K、每 GPU batch 192、20% miss rate 下，平均 TPOT 167.48→84.99 ms。跨 16K–1M context 的峰值吞吐为 host DRAM 基线的 2.09–3.04 倍，但长 context 的比较同时改变了可容纳的 batch，因此混合了容量与带宽的收益。小 batch 改善很小，甚至可能略慢。

这篇文章值得纳入超配研究，但其意义是展示容量和带宽共同约束的实验，不是实物 X-Mem 在真实线上请求中已经实现 2–3 倍收益，也不能直接移植到 H100/H200。

## 外置 KV connector：内存访问能力应由接口声明

[vLLM #66605](https://github.com/vllm-project/vllm/pull/66605) 于北京时间 11 月 10 日 00:22 提出、复核时仍 open 的相关线索。问题是 extensible KV 的 VMM/物理 chunk 布局，必须满足外部 RDMA 注册或跨进程共享的要求，不能只靠内置 connector 名单猜测。

当前 diff 已从正文最早描述的布尔接口推广为 KVCacheAccess flags 和 kv_cache_access()，区分注册、FD/Fabric 导出与 legacy IPC，并由 MultiConnector 汇总子 connector 的需求。其中 EXPORTS_FD 仅声明需求，导出尚未实现；legacy IPC 不能与 extensible KV 并用。跟踪时应以具体 head 的实现为准，不将 flags 列表当作全部能力已经可用。

8×H800、39/39 KV puts 结果来自下游 fork 上移植的初始 hook，没有覆盖当前所有泛化改动。它说明这一接口缺口值得跟进，不构成直接升级或开启超配的建议。

## 多模型超配：把独立预算和恢复代价一起计入

上述变化可用于设计验证，但不能直接相加成多模型超配收益。不同模型分别持有权重、KV 与运行状态，不默认共享权重或跨模型 KV；同一 engine 内的 DP 表去重也不等于跨模型共享。容量预算应逐模型计入权重、活动 KV、recurrent state、临时 workspace，再单独记录 host tier、pinned memory 和待完成拷贝持有的页。

值得验证的是在相同请求负载下，提高并发或驻留模型数之后，抢占与恢复耗时、OOM 频率、TTFT/TPOT 的 p95/p99，以及租户间干扰是否恶化。吞吐提高但首 token 或长会话恢复超时，不能算服务目标下的收益。

本轮没有找到窗口内、已验收的“独立多个模型权重与 KV 统一弹性超配”完整系统。上述静态分区、路由与卸载应分别实验，不能拼成已有端到端方案。混合状态和 Kimi 的分片差异移到[模型与新架构](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/model-architecture-status/)，引擎物理页与主机副本管理见[推理引擎每日变动](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/inference-engines/)。
