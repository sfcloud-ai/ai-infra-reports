# 模型服务与 GPU 超配：HiSparse 分开接收两类 KV，SGLang 定义权重快照格式

## 普通 sparse-MLA 预填充怎样接到 HiSparse

11 月 27 日 11:33 合入的 vLLM #66502 让 Mooncake 能对接布局不同的预填充与解码端。发送端可把 source KV 和 indexer KV 放在同一组。HiSparse 解码端可以把 source KV 放入共享主机池，把 indexer KV 留在各 rank 的 GPU。传输按层匹配，并使用两端各自的 cache group。共享主机池由解码侧 TP rank 0 请求写入，各 rank 仍处理自己的 GPU indexer KV。[PR 与实验记录](https://github.com/vllm-project/vllm/pull/66502) · [实现与测试](https://api.github.com/repos/vllm-project/vllm/pulls/66502/files?page=1&per_page=100)

每组的未命中页必须形成连续后缀。该路径要求 sparse MLA、PP=1、两端 token block size 相同，且物理页未经拆分。两侧 TP 不同时，较大的一侧须为较小一侧的整数倍。中间有缺页或由滑窗裁剪的页集合不在此路径的适用范围内。[配对条件](https://github.com/vllm-project/vllm/pull/66502)

作者在 16 张 H200 上使用 GLM-5.2-FP8、TP8→TP8，比较 129、513 和 1025 token 的冷导入以及匹配历史后的前缀增长。返回的 token ID 和 logprobs 与预填充端重放一致。测试衡量的是这些条件下的正确性，未提供多租户争用时的尾延迟或显存节省比例。[H200 验证](https://github.com/vllm-project/vllm/pull/66502)

## 快照要保存哪些关系

SGLang #51728 于北京时间 11 月 28 日 06:10 合入。load-diff 格式遍历模块的命名参数、buffer、属性和容器，将底层 storage、tensor view 和普通值的关系写进快照。两份 view 若指向同一块 storage，格式可以保留这种别名关系。它也能表达命名参数之外的量化标志和索引缓存。[PR](https://github.com/sgl-project/sglang/pull/51728) · [快照格式实现](https://api.github.com/repos/sgl-project/sglang/pulls/51728/files?page=1&per_page=100)

本次合入的是独立格式模块，尚无调用方。快照构建、导出、安装和端到端服务仍待验证。规划 30–80B 或 200–500B 的同卡模型池时，需要按各模型总参数和实际 dtype 核算独立权重，再列出 KV、CUDA graph、工作区、并行与抢占回载成本。此次变更未测异模型共享权重、隔离或 SLO。

## 跨仓检索的覆盖

内存、调度、计算和数据路径四类查询各读取两页。八页共 160 行，去重后为 141 个仓库，其中 17 行的推送时间晚于截稿。仓库活动用于筛线索，两个合入事件的时间与机制均由各自 PR 和补丁佐证。[内存](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+%22KV+cache%22+offload+GPU+in%3Areadme+pushed%3A2026-11-26T22%3A20%3A00Z..2026-11-27T22%3A20%3A00Z&sort=updated) · [调度](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+%22multi-tenant%22+scheduling+isolation+in%3Areadme+pushed%3A2026-11-26T22%3A20%3A00Z..2026-11-27T22%3A20%3A00Z&sort=updated) · [计算](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+kernel+matrix+throughput+inference+in%3Areadme+pushed%3A2026-11-26T22%3A20%3A00Z..2026-11-27T22%3A20%3A00Z&sort=updated) · [数据路径](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+RDMA+transfer+storage+in%3Areadme+pushed%3A2026-11-26T22%3A20%3A00Z..2026-11-27T22%3A20%3A00Z&sort=updated)
