# H100 长上下文解码：把权重放置与请求 KV 所有权分开

**近七天未报补充：Decode Token Parallelism（TKNP），2026-11-09 22:01:46 UTC 提交。** 论文针对大稠密模型的长上下文、高并发解码，核心是让权重按层分布在节点间，而每个请求的 attention 在持有其 KV 的节点执行。[原论文](https://arxiv.org/html/2611.13293v1)

## 同一个模型减少副本，KV 容量才留得下来

普通数据并行的每个副本都保存完整模型权重，压缩了可供请求使用的 KV 空间。TKNP 基础方案分布保存一份模型：某层权重所在节点用本地 NVLink 域内的 TP 处理整个 batch 的投影和 MLP，各节点同时对自己持有的请求做 attention。跨节点传当前 token 的激活，避免合并各节点的局部 attention 结果。

这是**同一个模型的分布式放置**，不代表不同模型能共享权重。它还需要权衡逐层通信；双活 root 的微批变体额外保存第二份分布式权重，以容量换取计算重叠，不能把所有配置都称作单副本。

## H100 实验说明了什么

实验使用每节点 8 张 H100 80GB、第四代 NVLink，节点间为 8×400 Gb/s InfiniBand。固定两个 prefill 节点，比较四或八节点 decode 池；Llama3.1-405B 和 Nemotron-4-340B 使用 FP8 权重并保留部分 BF16 参数、BF16 KV、CUDA Graph，基于 vLLM 0.19.0。

在 32 张解码 H100、长上下文与高并发的比较中，Llama3.1-405B 相对 DP 的完成吞吐最高达到 2.06 倍。计量包含 decode 池准入等待、分批执行和排空，每请求生成 1,024 token；**不包含前置 prefill 耗时，也不是全系统 32 卡的端到端收益**。小负载可被单副本容量容纳时，DP 更好。64 张解码 H100 下，相对 DCP 的最高 1.7 倍来自增加第二份权重的双 root 方案；单副本方案为最高 1.53 倍。

## H200、Pro5500 的迁移边界

| 重点硬件 | 本期可确认的依据 | 对部署判断的含义 |
| --- | --- | --- |
| H100 | 上述 80GB、NVLink、InfiniBand 实验 | 可以据此设计同条件复测；不能直接套到单卡多模型服务 |
| H200 | [官方产品页](https://www.nvidia.com/en-us/data-center/h200/) | TKNP 未给出 H200 实测；容量与带宽改变后，DP 与 TKNP 的交叉点须重新测量 |
| Pro5500 | 找到确切的 [RTX PRO 5500 官方页](https://www.nvidia.com/en-in/products/workstations/professional-desktop-gpus/rtx-pro-5500/)，标注 84GB GDDR7 ECC | 不能套用 H100 的 NVLink/InfiniBand 拓扑与成绩；先按实际设备确认互联及软件支持 |

这些产品参数是型号核对，**不是今天的新品发布**。本期 SinkState 实验用的是 RTX PRO 6000 Blackwell 96GB，不能把它写成 Pro5500 实测。对长上下文服务，选卡判断应同时看权重留下多少 KV 空间、队列等待以及互联成本，而不只看峰值算力。
