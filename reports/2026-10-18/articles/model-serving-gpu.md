历史归档：原期次 2026-10-18，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

## 远端 KV 要赢的是加载时间，而不是命中率

KV 缓存省掉 prefill 计算，却增加查询、搬运和多卡同步。GPU 足够快时，远端命中也可能输给直接重算。[When the KV Cache Is Slower Than the GPU v1](https://arxiv.org/html/2610.21500v1)复盘 GLM-5.3 FP8、每节点 8×B300 的部署，重点是 MLA 与 prefill context parallelism 下，搬运集中在 rank 0，其他 worker 在通信处等待的问题。

已有前缀缓存、CPU 层和异步预取都应算作基线，尤其应先考虑 HiCache 本机 RAM 及尽量命中本地状态的亲和路由，而不是从“GPU 缓存不够”直接跳到远端系统。HiCache 已把 GPU、host memory 与可选外部存储组成层级；这里引用[官方文档](https://docs.nvidia.com/dynamo/dev/knowledge-base/modular-components/backends/sg-lang/hi-cache)仅解释基线能力，不把后来文档中的新增集成反投射到当期。原论文没有证明其方案优于 HiCache。

## 增量是拆开集中搬运，并保持共同失败语义

作者方案将 chunk 按固定规则分给各 rank，远端也按 rank 分片，再让各 worker 异步预取。命中后仍可能发生淘汰，因此正式广播前需交换请求与取得块的信息，共同确定连续可用前缀，其余重算。否则某个 rank 提前退出，会让其余成员等待不同通信序列。这是具体数据分布下的协议修复，不是任意拓扑的通用全局调度器。[分片提案 #5545](https://github.com/LMCache/LMCache/pull/5545) · [远端分片 #5548](https://github.com/LMCache/LMCache/pull/5548) · [异步路径 #5553](https://github.com/LMCache/LMCache/pull/5553)

论文还处理完成通知登记竞态、缺失 key 响应和多 rank 异步 key 问题。六项提案截至 10 月 18 日仍未合并，GPU 数据来自旧版加补丁实现，不能称为主干整套方案已完成端到端复测。[通知修复](https://github.com/LMCache/LMCache/pull/5547) · [缺失 key](https://github.com/LMCache/LMCache/pull/5551) · [异步 key](https://github.com/LMCache/LMCache/pull/5550)

## 保留那个不漂亮但重要的对照

在 450 个高命中请求的隔离 prefill 回放里，作者报告旧同步方案 p99 为 83.32 秒，最终方案为 0.67 秒；但中位延迟仍是远端 0.40 秒、直接重算 0.31 秒。所谓约 124 倍主要消除了严重排队，不是普通服务的普遍收益。回放提前预热远端、清空本地缓存，每种条件只跑一次，不包含生成端交接，也没有多引擎共享远端竞争实测。[实验条件](https://arxiv.org/html/2610.21500v1#S6)

合理决策是先比较重算、本机 RAM 命中与远端命中，在真实并发和淘汰压力下统计满足延迟目标的完成请求数，以及 CPU、网络和维护成本。仅凭 GPU 更闲或命中率更高，不能判断资源效率提高。远端若没有独特复用价值，本地层与亲和路由可能是更简单的选择。

## Primus：用少量卡缩小训练配置搜索

[Primus Projection v1](https://arxiv.org/abs/2610.19423v1)面对另一个昂贵问题：每试一种并行布局、batch 与重算策略，都占满大集群并不划算。它先用内存模型过滤明显不可行的配置，再以小规模算子和通信测量外推目标集群，按预测排名缩小最终真实训练范围。[AMD 固定代码](https://github.com/AMD-AGI/Primus/tree/cf1a75a5bb5b12d3a37ff3d1a3cb328aac7ec98e)包含 evaluator、规划与 tuning agent，价值不只在“agent 参与搜索”。

作者给出的 Mixtral 8×22B 示例，在 4 节点 MI355X 上约提高 27% 吞吐，但参考配置是 BF16，候选是 FP8，不能将全部增益算作并行调度优化，也不能省掉收敛质量验收。AMD 栈的预测误差不能外推任意硬件；多租户网络竞争未建模，更不应据预测值承诺共享集群服务指标。[实验与局限](https://arxiv.org/html/2610.19423v1#S4)

因此本项适合离线配置预筛：固定精度与工作量，检查候选排名，再到目标规模验证。它和远端 KV 的共同原则是，先证明复杂方案胜过现成强基线，再支付集成和长期维护成本。
