# 模型服务与 GPU 超配：CPU 层只能放 13 块，vLLM 如何把 119 块 KV 存下来

当一个请求有 119 个完整 KV 块待卸载，但 CPU 卸载层一次最多只能容纳 13 块时，重试整批不会增加可用空间。vLLM 在 11 月 22 日 06:20 UTC 合入 #66719。CPU 管理器按 token 位置优先保存较早的块。在仍运行的 ON_COMPUTE 请求中，调度器会在后续步骤再次提交本轮放不下的键。请求已经结束或执行交接（hand-off）时，余键不会再提交，系统记录一次分配失败。如果原本就能放下全部块，仍按原流程存储。[PR #66719](https://github.com/vllm-project/vllm/pull/66719) · [#66719 文件差异](https://api.github.com/repos/vllm-project/vllm/pulls/66719/files?per_page=100)

作者用一张 RTX PRO 6000 Blackwell 运行 Qwen3-0.6B。单个请求输入 7,663 个 token，每块 64 个 token，CPU 层下接文件系统。下表是同一场景的计数；基线取自 #64286 之前的 main，补丁侧在当前修订重测。作者的基准说明取自北京时间 11 月 23 日 12:33 读取的 PR 正文，晚于当日 06:20 的晨报截点。[PR #66719](https://github.com/vllm-project/vllm/pull/66719)

| 一次请求的观测项 | 旧 main | 补丁 |
| --- | ---: | ---: |
| 卸载分配失败计数 | 401 | 0 |
| 存储传输次数 | 0 | 10 |
| 文件系统层中的 KV 块 | 0 | 119 |

![单个请求通过 13 块 CPU 层分批写出 119 个 KV 块](assets/kv-offload.png)

这组数字证明了容量受限时可以逐批写出 KV。作者随后用 2 GB CPU 层重启，读回 7,616 个缓存 token。温度为 0 时，400-token 续写与冷运行约在前 90 个 token 一致，之后出现分歧。作者在当前管理器按容量分批写入的修订上重做了字节比对。当前修订分 10 次写出 120 个文件；参考组来自较早修订，以 2 GB CPU 层一次存下同一请求的 119 个块。两组对应文件的 SHA-256 全部一致。写入内容、重载后的输出和在线时延，应分别验证。[PR #66719](https://github.com/vllm-project/vllm/pull/66719)

多租户部署还需要看两份工作负载如何竞争 CPU 层容量和文件系统带宽。复测应记录每租户命中率、重算、首 token 延迟的 P99，以及各实例独立的 KV 和权重占用。作者这次只测了单卡单请求，无法用它推算节省了多少张卡。

本期显存超配与卸载的跨仓检索首屏返回 2/2 个目录项，调度检索首屏返回 20/949 项。这些是项目发现线索，仓库描述和最新推送时间不能证明某项功能于本期合入；此处的工程结论仍来自 #66719 的具体变更。[显存与卸载目录](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=GPU+memory+oversubscription+offload+in%3Areadme+pushed%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated) · [调度目录](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=GPU+sharing+scheduler+isolation+in%3Areadme+pushed%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated)
