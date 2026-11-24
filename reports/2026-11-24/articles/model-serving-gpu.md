# 模型服务与 GPU 超配：两套预填充引擎如何放下 188.83 GiB 的 Engram 表

北京时间 11 月 23 日 15:55，#68685 合入主线（`dddd8b7`）。11 月 21 日已报道 vLLM #67539 如何让独立引擎分片读取同一模型的只读 Engram 表。#68685 延续这种分片方式，改变的是表的存放位置。在四张 GB200 上，DeepSeek‑V4.1‑Flash 的两张表合计 188.83 GiB，放在 HBM 时每张 GPU 占用 47.21 GiB。按作者记录，原配置在第二套引擎启动过程中耗尽显存；改用 Grace EGM 承载分片后，两套 TP1/DP2+EP 预填充引擎都能服务。分片仍归属各 GPU 对应的 Grace NUMA 节点，其他 GPU 以只读方式映射同一张表。这 188.83 GiB 是 Engram 表的占用，KV 容量另计。[原有分片机制](https://github.com/vllm-project/vllm/pull/67539) · [本次 PR](https://github.com/vllm-project/vllm/pull/68685)

整轮实验中，EGM 组和每引擎主机副本组各完成 144 个单 token 输出请求。作者另列了下表的 16K 延迟测点，未给出该点单独的请求数。

| 对照 | 实验条件 | 作者记录 |
| --- | --- | --- |
| 整请求 | 16K 输入，每引擎并发 4，每 rank 4 GiB KV，每请求生成 1 个 token | EGM 的 p50/p95 为 553/719 ms，每引擎主机副本为 563/735 ms |
| 单独查表 | 四卡重放，每卡 8,192 个 token | HBM 的 p50/p95 为 0.205/0.210 ms，EGM 为 0.858/1.563 ms |

![整请求与独立查表重放使用不同的对照组](assets/engram-egm.png)

EGM 的独立查表耗时更长。这个实验的价值在于移出 HBM 的表为两套引擎腾出了启动空间。整请求的对照是另一种可启动的配置，即每引擎主机副本。长输出解码时的尾延迟以及不同模型之间的资源隔离仍需另测。[作者说明与对照设置](https://github.com/vllm-project/vllm/pull/68685)

这条 EGM 路径要求 host-NUMA CUDA VMM、FABRIC 句柄、可用的 IMEX channel，并且每个 Grace NUMA 节点有足够的可分配容量。上述四卡结果对应 GB200，不能直接套在 H100、H200 或没有 Grace 内存的机器上。[实现差异](https://github.com/vllm-project/vllm/pull/68685/files)

这里的整请求数据来自 #68685 的作者说明。MoRI 的会话 KV 池处理可复用的前缀状态，详见本期硬件篇。[含作者完整说明的合并记录](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Avllm-project%2Fvllm+is%3Apr+merged%3A2026-11-22T22%3A20%3A00Z..2026-11-23T22%3A20%3A00Z&sort=updated)
