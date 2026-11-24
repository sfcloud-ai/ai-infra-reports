# 推理引擎每日变动：MI355X 的稀疏解码如何省去一次 KV 中转

## vLLM

本期 24 小时合并 PR 查询返回 61 项。#68685 的 Engram 表移入 Grace 内存，详见服务篇。vLLM 官方仓库另有 MoRI 会话存储的系统说明，硬件篇梳理了磁盘读回与跨节点传输的区别。[当窗合并查询](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Avllm-project%2Fvllm+is%3Apr+merged%3A2026-11-22T22%3A20%3A00Z..2026-11-23T22%3A20%3A00Z&sort=updated) · [MoRI 系统原文](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-23-skip-the-dram-tier.md)

## SGLang

SGLang 的合并查询返回 24 项。[当窗合并查询](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Asgl-project%2Fsglang+is%3Apr+merged%3A2026-11-22T22%3A20%3A00Z..2026-11-23T22%3A20%3A00Z&sort=updated)

北京时间 11 月 23 日 21:44 合入的 #45196（`ac0380c`） 在符合条件的 gfx950 QSA 解码上接入 AITER 的 FlyDSL 稀疏内核。启用 HIP 上的 AITER 路径且相应模块可用时，代码还要求 gfx950、BF16 query、BF16 或 FP8 KV、head_dim 256、每个 KV 头对应的查询头数不超过 16。PR 的 TP1 用例有 24 个查询头、2 个 KV 头，因此每个 KV 头对应 12 个查询头。满足条件后，内核通过 `req_to_token` 直接从池中读选中的 KV，并把每行选择的工作分给多个线程块，省去旧路径写入临时缓冲区的往返。不满足条件时走原回退路径。[实现差异](https://github.com/sgl-project/sglang/pull/45196/files) 实测为单张 MI355X、Qwen3.8-Flash-Next Quark MXFP4、TP1。在 agenticX 并发 16 的负载上，ITL p50 从 7.85 降到 6.97 ms。性能对照两侧都设置了 2.32 的模拟 MTP 接受长度，因而这组数字只反映该设置下的服务表现。[作者的内核路径与测量表](https://github.com/sgl-project/sglang/pull/45196)

另一个调度修复 #52494 先进入 `release/v1.0.0`，#52510 将同一提交移植到主线，两次合并只算一项修复。[原修复](https://github.com/sgl-project/sglang/pull/52494) · [主线移植](https://github.com/sgl-project/sglang/pull/52510)

LMSYS 官方目录收录了一篇标注为 11 月 23 日的 SGLang 与 Miles 文章，讨论 rollout 和训练端的对数概率对齐。本期读到了目录摘要，原文抓取未取得响应，准确发文时间、适用模型和开销仍待核实。[LMSYS 目录](https://www.lmsys.org/blog/) · [文章入口](https://www.lmsys.org/blog/2026-11-23-miles-true-on-policy/)

## DeepInfer

同一 24 小时合并 PR 查询返回 0 项。这个结果仅限于该入口。项目 [README](https://raw.githubusercontent.com/deepseek-ai/DeepInfer/HEAD/README.md) 可以核对引擎支持范围；本期只据该查询说明合并结果。[当窗合并查询](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Adeepseek-ai%2FDeepInfer+is%3Apr+merged%3A2026-11-22T22%3A20%3A00Z..2026-11-23T22%3A20%3A00Z&sort=updated)

这三家仓库的查询都限定为已合并 PR。单独提交、稳定版发布和截止时间以后的回退记录未查全。上文的合入时间只说明代码进入对应分支。SGLang 官方博客所查卡片最新标注为 11 月 12 日；LMSYS 的 11 月 23 日条目仅取得目录摘要。[SGLang 官方博客](https://www.sglang.io/blog) · [LMSYS 目录](https://www.lmsys.org/blog/)
