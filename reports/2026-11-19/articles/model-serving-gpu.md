四个路由副本同时看到同一份“最空闲”榜单，下一刻就可能一起把请求排到同一张队尾。11 月 18 日，SGLang 将可选的 `least_tokens` 策略合入 main（#51147，提交 `009b31b0`）。它解决两个不同的问题：队列里还有多少工作没有反映在 KV 用量上，以及多个路由器怎样避免同时选择同一个 rank。

同时启用 `--dp-aware` 和 `--dp-rank-policy least_tokens` 后，路由器先确定 worker。引擎还须在 `--kv-events-config` 中配置发布器，并启用 `--load-publish-endpoint`。作者的四 rank 测试取值为 `auto`。这样路由器才能收到各 rank 的负载。仅开启 DP 感知时，rank 的默认策略仍是 `least_in_flight`。已有粘性键或缓存前缀能够确定 rank 的请求沿原路径走。其余请求才随机取两个 rank，比较已承诺的 token 负担。V4 上报的 `num_total_tokens` 包含在用 KV 和尚未获准运行的请求所带的提示 token。旧版上报器只给出在用 KV。两种上报只要对所有 rank 都足够新，路由器就用它们估算负载，并计入自己在上报后新分派的请求。任一 rank 的读数缺失或过期时才回退到 `least_in_flight`，避免误把沉默的 rank 当作空闲。

![V4 和旧版上报的计数范围、路由器的本地修正及读数缺失或过期时的回退](assets/routing.png)

| 观测条件 | 对照 | 实际分派结果 |
| --- | --- | --- |
| 一个 rank 正跑短请求，另排五条 2,000-token 提示，其余 rank 各占 3,000 KV tokens | 只按在用 KV 排序，对比计及队列 | 发出的三次请求中，前者三次都选中积压 rank，后者零次选中 |
| 四个路由副本各同时发出一条 1,000-token 请求，共五轮 | 总取全局最小值，对比随机二选一 | 前者每轮四条都去同一 rank；后者单个 rank 每轮最多收到 2、2、2、3、3 条 |

两组都是作者在 MI350X、Qwen3-0.6B、四个 DP rank、`max-running-requests=1` 下的端到端路由观测。计数单位是请求去向。它能说明分派更分散，仍不足以回答“同卡还能多放几个实例”。

做多租户容量试验时，应分别记各模型权重、实例的 KV 或循环状态、计算工作区和图内存。不同模型权重各自占用；相同模型的实例是否共用权重还取决于运行时及隔离方式。把长短提示比例、到达率和实例配置固定，再将负载分布同峰值显存、完成时间和 P99 对齐，才能判断这项分流对具体 SLO 和成本的影响。

## 原始来源

- [SGLang #51147：算法、测试配置和逐轮计数](https://api.github.com/repos/sgl-project/sglang/pulls/51147)
- [该提交中的引擎负载上报配置](https://github.com/sgl-project/sglang/blob/009b31b0100d45629797261c5b61b3f8eaed5ad0/python/sglang/srt/arg_groups/fields/observability.py#L143-L146)
- [本次合入的文件与差异](https://api.github.com/repos/sgl-project/sglang/pulls/51147/files?page=1&per_page=12)
