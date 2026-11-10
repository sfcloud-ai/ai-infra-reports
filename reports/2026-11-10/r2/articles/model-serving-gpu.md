# 模型服务与 GPU 超配｜KV 容量之外，还有状态与回载带宽

混合模型的可复用前缀，不只由 KV 是否存在决定；把更多 KV 搬到外部内存，也不保证单位请求更快。本期关注一个窗口内的新 SGLang 提案，以及两篇近七日官方技术文章，分别讨论 recurrent-state 容量、缓存分片和外部内存带宽。博客日期按页面标注保留到日，PR 时间统一使用北京时间。

![KV 与循环状态共同决定前缀可复用，外部容量还受回载带宽约束；原创机制简图，不是性能比较](assets/state-and-bandwidth.png)

## 混合模型：KV 还在，状态丢了仍要重算

[SGLang #49430](https://github.com/sgl-project/sglang/pull/49430) 于北京时间 11 月 10 日 10:08 提出，复核时仍未合入。

KDA、GDN 或 Mamba 与 attention 混合后，恢复某个缓存前缀还需要对应的 recurrent state。状态池通常比 KV 池紧张。作者给出的 GLM-5.3-Flash NVFP4、2×B200、TP2、默认池配置中，KV 池可放约 297 万 token，但只有 419 个 state slots，每个运行请求要用 5 个。会话等待工具返回时，KV 可能仍在，最近的状态却已经被逐出，恢复只能退回更早状态甚至 token 0，再做一次长 prefill。

提案加入 GreedyDual-Size 状态淘汰策略。优先级由老化水位加重建成本组成，重建成本从最近仍保留的祖先状态算起；容易补回的状态先淘汰，长会话唯一的有效状态更值得保留。Full KV 仍按 LRU 排序，策略在 Python 与 Rust 两种树实现中都提供，默认关闭，混合模型下不兼容 --enable-session-radix-cache。

基于 coding-agent traces 的 CPU 调度模拟中，64 sessions 下每请求平均未缓存 token 由 10,276 降至 6,820。但中位数没有改善，说明主要修的是少量大幅回退的尾部。另一组 1×H200 测试使用 dummy 8-layer 模型，后两轮输出吞吐约增加 9%；它不是完整 GLM-5.3-Flash 的生产实测，部分轮次还有客户端错误。原文中的完整 B200 模型实验仍等待补充。

实际可用的观察指标因此不应只有 KV hit rate，还包括状态池压力、KV 仍在但 state 缺失的重算 token，以及长会话恢复尾延迟。

## Kimi K3.1：PCP 拆计算，不代表 KV 已分片

[SGLang 的 Kimi K3.1 Pro 官方文章](https://www.sglang.io/blog/kimi-k3.1-pro-day0-support) 标注发布于 11 月 4 日，属于近七日技术文章，不是今日新发布。文中有两处容量规划细节值得保留。

第一，当前 prefill context parallelism（PCP）分配的是计算工作，DSA KV 在 CP group 内仍然复制。Decode context parallelism（DCP）才按 token 将 KV 与 index cache 分片；不能看到“context parallel”就按卡数等比例扣除缓存占用。

第二，32×H200 的 LoRA rollout 中，把 attention 从 TP32 改成四组 DP-attention，可在 256 running requests 时把每卡 KV 从 16.9 GiB 降至 4.2 GiB，decode step 从 202.6 ms 降至 166.6 ms。但在 64 requests 时，step 反而由 110.5 ms 增到 136 ms。减少重复 KV 和跨节点 attention 通信确有价值，吞吐收益仍依赖负载是否足够高。

这篇文章的 Day-0 recipes 使用 preview images，不能写成 stock SGLang release 已全部支持。上述硬件结果是指定 LoRA rollout 配置，不外推任意 H200 部署或 H100。

## XM-Sparse：容量与带宽要一起扩，2–3 倍结果先看测试条件

[LMSYS 的 XM-Sparse 文章](https://www.lmsys.org/blog/2026-11-04-xm-sparse/) 页面日期是 11 月 5 日，尽管 URL 含 11 月 4 日。文章由 Netpreme 团队撰写，讨论用外部高带宽内存承载完整 KV，GPU 只保留热点缓存与 indexer。

核心问题是：稀疏 attention 每步只读取部分 KV，但仍要保留完整历史，因为下一步选中的位置会改变。增加外部容量可以支持更多并发；如果回载带宽不够，新增并发也会带来更多 I/O 等待。

测试环境必须与标题里的收益一起读：4×B300 负责 decode，另外 4×B300 的 HBM 模拟外部 memory banks；使用 synthetic KV、固定 20% 或 40% miss rate，并关闭 prefetch。24 TB 是用于限定 batch 的容量预算，不是这八张 GPU 实际装出的 24 TB 内存；X-Mem 芯片本身尚未交付。

在 16K、每 GPU batch 192、20% miss rate 下，平均 TPOT 167.48→84.99 ms。跨 16K–1M context 的峰值吞吐为 host DRAM 基线的 2.09–3.04 倍，但长 context 的比较同时改变了可容纳的 batch，因此混合了容量与带宽的收益。小 batch 改善很小，甚至可能略慢。

这篇文章值得纳入超配研究，但其意义是展示容量和带宽共同约束的实验，不是实物 X-Mem 在真实线上请求中已经实现 2–3 倍收益，也不能直接移植到 H100/H200。

## 外置 KV connector：内存访问能力应由接口声明

[vLLM #66605](https://github.com/vllm-project/vllm/pull/66605) 是 北京时间 11 月 10 日 00:22 提出、复核时仍 open 的相关线索。问题是 extensible KV 的 VMM/物理 chunk 布局，必须满足外部 RDMA 注册或跨进程共享的要求，不能只靠内置 connector 名单猜测。

当前 diff 已从正文最早描述的布尔接口推广为 KVCacheAccess flags 和 kv_cache_access()，区分注册、FD/Fabric 导出与 legacy IPC，并由 MultiConnector 汇总子 connector 的需求。其中 EXPORTS_FD 仅声明需求，导出尚未实现；legacy IPC 不能与 extensible KV 并用。跟踪时应以具体 head 的实现为准，不将 flags 列表当作全部能力已经可用。

8×H800、39/39 KV puts 结果来自下游 fork 上移植的初始 hook，没有覆盖当前所有泛化改动。它说明这一接口缺口值得跟进，不构成直接升级或开启超配的建议。

## 多模型超配：把独立预算和恢复代价一起计入

上述变化可用于设计验证，但不能直接相加成多模型超配收益。不同模型分别持有权重、KV 与运行状态，不默认共享权重或跨模型 KV；同一 engine 内的 DP 表去重也不等于跨模型共享。容量预算应逐模型计入权重、活动 KV、recurrent state、临时 workspace，再单独记录 host tier、pinned memory 和待完成拷贝持有的页。

值得验证的是在相同请求负载下，提高并发或驻留模型数之后，抢占与恢复耗时、OOM 频率、TTFT/TPOT 的 p95/p99，以及租户间干扰是否恶化。吞吐提高但首 token 或长会话恢复超时，不能算服务目标下的收益。

## 重点方向的实际覆盖

H200 的直接数据限于上面的 Kimi LoRA rollout 和 dummy 8-layer 状态淘汰实验；H100 的证据主要是引擎定向正确性测试。GB300、B300 或 H800 的结果不能替代 H100/H200 验收。本期未完成重点硬件 SKU、互联、MIG 与支持矩阵的专项核查；Pro5500（型号待核实）保留原称，不填猜测规格。

模型架构重点包括 GLM 混合状态与 Kimi 缓存布局，Qwen 的 CPU PLE 表变化见[推理引擎每日变动](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/r2/inference-engines/)。DeepSeek、Qwen、GLM 模型索引只是部分发现入口，Qwen 博客正文仍有读取缺口，不能据此宣称所有架构方向已查全。制造业具身与 2B 小模型的任务质量取舍见 [GR00T 2](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/r2/embodied-training/)；独立文本/多模态小模型本期尚未全面覆盖，也没有完成 LeRobot/OpenPI 专项核查。
