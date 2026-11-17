同一张性能图里，GPU 数量、并发、延迟目标和功耗分母都可能不同。选型时先固定这些条件，才知道“更快”对应单用户体验、集群吞吐，还是某种配置下的能效。

### 推理：10 倍标题不能直接搬到同卡数服务

NVIDIA **11 月 16 日 16:00 UTC** 的 MLPerf Endpoints 技术文，比较满足**每用户至少 50 token/s**条件的不同运行点，以 token/s 除以**配置功率 kW**给出超过 10 倍的标题结论。Rubin 结果仍属 provisional，待 MLCommons 验证。

其中 Kimi 对比用了 **32 与 48 个加速器、1024 与 48 并发**。这不是同卡数、同负载、同延迟的直接升级比，也不是整机实测用电量。它提示大并发下的吞吐空间，但不能据此给 H100/H200 的既有服务承诺同等倍数，更不能外推到型号尚未核实的 Pro5500。

### 训练：达到基准质量阈值，不等于完整预训练

同日同时间发布的 MLPerf Training v6.1 文章，主要同 GPU 数表格给出 **1.4–2 倍**变化；DeepSeek-V3 的 **1024 GPU**比较为 **8.03 分钟到 4.14 分钟**。另一个 **10240 个 GB300、1.38 分钟**结果代表更大规模下的绝对完成时间，不能与同卡数表混算。

这里测的是达到基准规定质量目标的时间，**不是从零完成 671B 模型全部预训练**。文中后续新软件重跑的“最高 2.4 倍”尚未作为正式验证结果，不能与已提交成绩混写。对训练平台，实际应同时核对任务、质量目标、精度、并行规模和数据输入路径，再比较时间与资源成本。

### TileOPs：冷缓存测量本身也会改变数字

TileOPs **11 月 16 日 23:14:47 UTC** 合入 **#2985**（`a9a484ce`）。新流程先用 CUDA stream blocker 排队一组样本，每个样本执行 reset、约两倍 L2 容量的读取冲刷和被测调用；样本之间不插入主机同步。它与每个样本单独冷启动的流程不同。

补丁记录 SM0 时钟均值，不因降频直接丢弃样本；排队超时会放弃该组并缩小分组，CUPTI 丢失 kernel 记录会触发重测。`l2_flush` 协议标签用于区分历史结果，autotuner 仍保留 drained 路径。这些是**测量方法变化，不是被测 kernel 已经加速**。

工程上应先冻结测量协议、时钟与缓存条件，再重建可比基线。在线服务还需要加入请求排队、通信、存储与调度，不能把冷缓存 microbenchmark 当成线上 SLO。上述材料没有形成新的 H100/H200/Pro5500 同条件横向测量，本期也不据此绘制速度排名。

原始来源：[原始来源 1](https://developer.nvidia.com/blog/nvidia-vera-rubin-nvl72-leads-agentic-inference-performance-on-mlperf-endpoints-v1-0/)；[原始来源 2](https://developer.nvidia.com/blog/feed/)；[原始来源 1](https://developer.nvidia.com/blog/nvidia-vera-rubin-nvl72-achieves-up-to-2x-blackwell-ultra-performance-in-mlperf-training-v6-1/)；[原始来源 2](https://developer.nvidia.com/blog/feed/)；[原始来源 1](https://api.github.com/repos/tile-ai/TileOPs/pulls/2985)；[原始来源 2](https://api.github.com/repos/tile-ai/TileOPs/pulls/2985/files?per_page=100)；[原始来源 3](https://api.github.com/search/issues?q=%22FP32%22+%22throughput%22+updated%3A2026-11-15T23%3A20%3A00Z..2026-11-16T23%3A20%3A00Z&sort=updated&order=desc&per_page=5&page=1)；[原始来源 4](https://api.github.com/search/issues?q=repo%3Atile-ai%2FTileOPs+is%3Apr+%22cold+measurement%22&sort=updated&order=desc&per_page=5&page=1)。
