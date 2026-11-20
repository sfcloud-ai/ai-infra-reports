# 模型服务与 GPU 超配：哪些 KV 值得写回 Mooncake

同一服务既接收反复使用长前缀的请求，也接收只生成一次的长文本。前者希望下次还能复用缓存，后者把全部 KV 写入外部存储，可能只增加写流量。现在可以让一个请求继续查找、加载已有前缀，同时把它自己的写入额度设为零。

## 一个请求最多写多少

vLLM 于 11 月 19 日将 #68529 合入 main（`a3b845e2`）。MooncakeStoreConnector 在创建请求跟踪记录时读取 `kv_transfer_params.max_offload_tokens`。常规写入以完整块为单位向下取整。例如每块 16 个 token，上限为 100 时可写前 96 个 token；上限为 0 时停止该请求写入。边界状态交接、结束时的检查点及不满块尾部的处理也受上限约束。调度器仍可查找和加载已有缓存，因此读命中与新写入要分别统计。[vLLM #68529](https://api.github.com/repos/vllm-project/vllm/pulls/68529) · [实际代码变更](https://api.github.com/repos/vllm-project/vllm/pulls/68529/files?page=1&per_page=100)

![每块 16 个 token 时，100 的上限允许写入六个完整块，共 96 个 token；零上限保留已有缓存的查找与加载。](assets/mooncake-prefix.png)

此前有些请求即使指定零额度也会生成写任务。提交者在 macOS 上运行 CPU 调度器测试，103 项通过；请求、调度元数据和块池参与了测试，外部查询服务使用替身。生产接入还要测真实后端的写入字节、命中率和读回等待时间。对长前缀业务，宜同时记录按请求分组的 P99，防止节省写流量却增加下次请求的重算。[测试环境与复现说明](https://api.github.com/repos/vllm-project/vllm/pulls/68529)

## 分别计量权重更新、训练步时和 GPU 小时

NVIDIA 在 11 月 19 日介绍了 Dynamo 如何处理 rollout。路由器同时考虑已有前缀和工作进程负载。ModelExpress 可复用留在 GPU 上的旧权重，并传输压缩的权重增量。恢复流程处理受工作进程故障影响的生成任务。这三处改动分别作用于生成、更新和中断恢复。CoreWeave 给出的最高 **15 倍**针对权重更新速度。H Company 报告平均训练步时最多缩短 **20%**、GPU 小时最多减少 **5%**。两个案例没有共同的硬件和负载基线，三个数字须按各自分母使用。[NVIDIA 的 rollout 技术说明](https://developer.nvidia.com/blog/reducing-rollout-bottlenecks-in-reinforcement-learning-with-nvidia-dynamo/)

## 同卡多实例还缺哪组测量

两项工作都没有给出同卡多租户容量。做配置预算时，应先为不同模型分别计入权重，再计每实例的活动 KV 或其他运行状态、计算图、工作区及通信缓冲。同模型实例能否共享权重，还取决于检查点、精度、布局与运行时共享机制；某个请求可以读已有前缀，也不能据此认定不同租户可以互读缓存。最小对照是固定模型和负载，先跑单实例，再跑同卡双实例，分别测峰值显存、后端流量、隔离与尾延迟。本期材料不足以据此承诺节省卡数。
