缓存恢复不只是“命中多少 token”，还涉及恢复点、checkpoint 和调度轮次；CPU 卸载的初始化也可能占住启动关键路径。本期把这两类工程变化放在各自真实条件下看。

### vLLM：Mamba 块中途恢复与 CPU 卸载

**11 月 16 日 03:43 UTC** 合入的 **#66938**（`5b028fb`），使 `align` 模式下的 Mamba 可以保留块内私有 checkpoint，打通 core、worker 和 scheduler 的恢复状态。示例中 **1920→2880 的剩余 960 token**从三次 prefill 调度变成一次；轮次缩减不等于端到端快三倍。

它仍保留此前 #67717 的正确性约束：没有对应完整块状态的非整块 checkpoint，不能登记为可复用的整块 hash。缓存多一点与缓存正确，是两个独立问题。

性能证据来自 **Kimi K3.1、TP8/DCP8、2×4 GB300、prefix match 128、block 1280、Mooncake cache**。OSL=1 的 prefill trace 中，平均 TTFT 在并发16时 **0.69→0.60 秒**、并发48时 **2.12→1.88 秒**，吞吐基本相同。另一组端到端 PD 测量的 TTFT p50 下降约12–22%，吞吐变化约在1.5%以内，交互性在表格的3P1D、并发384组由73.0降至71.4，约下降2.2%；并发1的 p90 反而约增20%。两组测量不能混成一个统一加速比，也不能外推 H100/H200。

**#66583**（`33ca7f415b23`，11月16日19:10 UTC合入）为 CUDA 的 `CPUOffloadingSpec` 增加默认关闭的 `async_init`：先建立映射，再在后台 prefault/pin。注册以 **8 MiB** 为分块目标，但保持完整 block row/worker slot；最小单元较大时可以超过该目标，按 worker slot 和注册耗时节奏推进，默认间隔为耗时的两倍；所有 worker 准备好才启用卸载，准备失败保持禁用。后台设置线程使用 relaxed capture，避免与图捕获相撞。

`TieringOffloadingSpec` 尚不支持这条异步路径，会告警并同步初始化。PR 中 **GLM-5.3、16×H100、真实权重的 439→334 秒**，以及 Qwen3-8B dummy 配置的 **241.5→57–61 秒**，都包含未合入的 Tiering 后续工作，不能归给本补丁。已给出的 **2×H100、Qwen3-0.6B、TP2、8 GiB CPU tier**验证侧重正确性和 capture race，CPU tier 太小，不能据此证明启动收益。试用时先核对 spec/开关和 readiness，再用真实容量比较启动及尾延迟。

### SGLang：状态与模型适配各归其问题

本期三项实质变化分别在[模型服务与 GPU 超配](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-17/model-serving-gpu/)、[模型与架构](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-17/model-architecture-status/)和[前沿小模型](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-17/small-model-status/)展开：HiSparse/HiCache 数据平面、DeepSeek 上下文并行与 graph、LFM3 多模态输入及文本输出。不在这里重复计作额外新闻。

默认分支提交和后续 revert 已核对；同窗口已被撤销的 Blackwell hybrid 变化未纳入有效进展。SGLang 与 LMSYS 官方博客也另行读取，Inkling、Miles/Vera 等已报事件没有靠新的入口访问日期重新入报；594B 总参数、17B 激活的 Inkling 也未混入“小权重模型”。

### DeepInfer：核查结果与离线范围

所查默认分支的24小时提交查询、release 列表均为空，官方 README 与基础设施文章索引已经读取；这只说明这些入口的本期结果。当前材料涉及 **SM100 与 Ascend 950、受限的滑窗重放以及 DSpark 离线能力**，没有据此形成 H100/H200 上完整在线 KV 管理、调度与服务 SLO 的证据。DeepInfer 与 FlashInfer 是不同项目。

本期截至 **北京时间 11 月 17 日 07:20**。vLLM 的 v0.34.0 release 时间为07:22，超出截止而未冒充窗口内发布；vLLM 官方 EPD 正文与代码分别检查，博客中的已报事件按历史去重。代码合入、release 和线上服务验证三种状态保持分开。

原始来源：[原始来源 1](https://api.github.com/repos/vllm-project/vllm/pulls/66938)；[原始来源 2](https://api.github.com/repos/vllm-project/vllm/commits/5b028fb8369d)；[原始来源 1](https://api.github.com/repos/vllm-project/vllm/pulls/66583)；[原始来源 2](https://api.github.com/repos/vllm-project/vllm/commits/33ca7f415b23)；[DeepInfer 官方说明](https://github.com/deepseek-ai/DeepInfer)。
