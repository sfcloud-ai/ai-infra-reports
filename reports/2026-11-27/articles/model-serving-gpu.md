# 模型服务与 GPU 超配：用 GDS 读回 KV，按 DCP 分片缩小常驻缓冲

## 文件命中后，KV 怎么回到 GPU

vLLM #66805 于北京时间 11 月 26 日 22:41 合入。文件系统卸载新增 GDS 后端，cuFile worker 在 GPU 缓存和文件之间读写 KV 块。合入文档使用 `FSOffloadingSpec` 和 `fs_backend=gds`。作者的基准配置把 CPU 与文件分层写入交给一个连接器，把 GDS 读回交给另一个连接器。[原 PR](https://github.com/vllm-project/vllm/pull/66805) · [合入文档与实现](https://api.github.com/repos/vllm-project/vllm/pulls/66805/files?page=1&per_page=100)

作者在 8 张 H100、共享文件系统及 Meta-Llama-3.1-8B 的 inference-perf 测试中，使用 GDS 读回文件 KV。作者报告该 inference-perf 测试的吞吐超过对照两倍。原文未写明吞吐单位，图表未单独复核，具体口径尚未核定。新增测试包括以 POSIX 模拟 cuFile。实际部署还需要在目标存储和命中率下测量回载、重算各自的时延，以及读写并发时的尾延迟。[实验说明](https://github.com/vllm-project/vllm/pull/66805)

## 每个 DCP rank 需要分配多宽的缓冲

#70178 于北京时间 11 月 27 日 01:11 合入。解码元数据已经局部化时，稀疏索引 logits 缓冲按 DCP 分片和交错粒度计算宽度，显存预估也用同一上界。PCP 和未局部化的解码路径依旧按全局宽度分配。[原 PR](https://github.com/vllm-project/vllm/pull/70178) · [宽度计算与测试](https://api.github.com/repos/vllm-project/vllm/pulls/70178/files?page=1&per_page=100)

![DCP 局部宽度分配前后，CUDA graph pool 从每 rank 9.10 GiB 降至 6.91 GiB，KV 缓存块数从 3551 增至 3762](assets/dcp-local-kv.png)

作者在旧运行补丁上比较了 Kimi K3.1 Pro，使用两台各装四张 GB300 的节点，配置为 TP8/DCP8。每 rank 的 CUDA graph pool 从 9.10 GiB 降到 6.91 GiB，KV 缓存块数从 3551 增至 3762。两组各启动一次，并使用不同节点对。当前合入的 PR head 没有重跑 GPU，也没有测吞吐。[A/B 条件与数据](https://github.com/vllm-project/vllm/pull/70178)

这两项改动分别影响 KV 回载路径和每个进程常驻的缓冲。比较 30–80B 或 200–500B 的模型池时，仍需按总参数和实际精度分别核算模型权重，并列出 KV、CUDA graph、工作区、并行和抢占回载开销。现有实验没有直接测量异模型同卡运行时的隔离或尾延迟。

## 跨仓检索范围

内存、调度、计算和数据路径四类查询各读取主窗首屏 20 条。80 行对应 71 个仓库，8 行所列的推送时间落在主窗外。仓库列表用于寻找线索，本页两项事件由各自 PR 和实际改动核定。[内存](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+%22KV+cache%22+offload+GPU+in%3Areadme+pushed%3A2026-11-25T22%3A20%3A00Z..2026-11-26T22%3A20%3A00Z&sort=updated) · [调度](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+%22multi-tenant%22+scheduling+isolation+in%3Areadme+pushed%3A2026-11-25T22%3A20%3A00Z..2026-11-26T22%3A20%3A00Z&sort=updated) · [计算](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+kernel+matrix+throughput+inference+in%3Areadme+pushed%3A2026-11-25T22%3A20%3A00Z..2026-11-26T22%3A20%3A00Z&sort=updated) · [数据路径](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+RDMA+transfer+storage+in%3Areadme+pushed%3A2026-11-25T22%3A20%3A00Z..2026-11-26T22%3A20%3A00Z&sort=updated)
