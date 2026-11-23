# 推理引擎每日变动：HiCache 把驱逐等待移到前向流，首 token 和逐 token 延迟怎样变化

本期窗口为北京时间 11 月 22 日 06:20 至 23 日 06:20。三份默认分支提交列表均无下一页，分别返回 18、56 和 0 项。同期全仓合并 PR 分别为 vLLM 18、SGLang 57、DeepInfer 0。默认分支提交与全仓合并 PR 分别统计。截至本期截点，已逐项检查四个重点 PR 合入后的默认分支提交消息及合并 PR 标题，未见显式回退。这个检查只覆盖窗内可见记录。

vLLM 和 SGLang 的 GitHub Releases 首页各返回 30 条，均有下一页。返回项中最新的正式版分别为 vLLM v0.34.0（11 月 16 日 UTC）和 SGLang v0.5.23（11 月 2 日 UTC），均早于本期窗口。现有发布记录不能把四项主线合并列为稳定版功能。[vLLM 发布记录](https://github.com/vllm-project/vllm/releases/tag/v0.34.0) · [SGLang 发布记录](https://github.com/sgl-project/sglang/releases/tag/v0.5.23)

## vLLM

窗内默认分支返回 18 项，全仓合并 PR 也是 18 项。[vLLM 合并 PR](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Avllm-project%2Fvllm+is%3Apr+merged%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated)

已逐项核对 #66719 的 CPU 层增量卸载、#69168 的 RTX 5090 小矩阵乘和 #68198 的 Nemotron Shortcut 适配，三项均合入 main，合并 SHA 与本窗提交行一致。服务、硬件、架构三栏分别给出机制和实验条件，索引按各自主栏目归属。官方博客目录已取回，目录字节变化本身不足以确定本窗新增文章。[默认分支提交](https://api.github.com/repos/vllm-project/vllm/commits?page=1&per_page=100&since=2026-11-21T22%3A20%3A00Z&until=2026-11-22T22%3A20%3A00Z) · [PR #66719](https://github.com/vllm-project/vllm/pull/66719) · [PR #69168](https://github.com/vllm-project/vllm/pull/69168) · [PR #68198](https://github.com/vllm-project/vllm/pull/68198) · [官方博客](https://vllm.ai/blog)

## SGLang

窗内默认分支返回 56 项，全仓合并 PR 为 57 项。逐项核对后，多出的是 #52168：它将上期已报道的 #51995（加载权重时预留 MoE 工作区）移植到 `release/v1.0.0` 分支。本期索引不将它重复计作新机制；该分支合并也不能证明稳定版已经发布。[移植 PR #52168](https://github.com/sgl-project/sglang/pull/52168) · [SGLang 合并 PR](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Asgl-project%2Fsglang+is%3Apr+merged%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated)

#50469 在 11 月 22 日 16:46 UTC 合入 main。此前 HiCache 在 write_back 驱逐时会阻塞调度线程，等 KV 从设备拷到主机。统一缓存走这条异步路径时，`write_fence_stream` 必须可用，且 `load_fence_stream` 必须指向同一条栅栏流。写回完成事件在这条流上建立顺序。后续从主机到设备的复制（H2D）在独立的加载流上执行，通过等待该栅栏排在写回之后。满足这些条件且启用重叠调度时，前向流等待复制完成事件，调度器可以提前组织下一批请求。未启用重叠调度时，运行前向和状态复制的当前流也要等待该事件。L3 存储后端、缓冲流水线、cache linker、统一内存池和分离部署的 decode 路径仍需主机等待，因为它们可能在前向流的顺序之外访问相关页。[PR #50469](https://github.com/sgl-project/sglang/pull/50469) · [#50469 文件差异](https://api.github.com/repos/sgl-project/sglang/pulls/50469/files?per_page=100)

作者在 GB300 上回放 DeepSeek‑V4.1‑Flash 多轮请求，预填充与解码分离，使用 14 个预填充服务和 DEP16 解码，开启重叠调度。两组都包含 #47650，使用同一镜像，每组两轮，每轮 1,200 秒，只切换当前补丁。[PR #50469](https://github.com/sgl-project/sglang/pull/50469)

| 延迟分位数 | 基线 | 加入 #50469 |
| --- | ---: | ---: |
| 首 token 延迟（TTFT）p50 / p90 | 4.26 / 12.0 秒 | 2.73 / 9.6 秒 |
| 每个输出 token 耗时（TPOT）p50 / p90 | 6.75 / 7.25 毫秒 | 6.92 / 7.32 毫秒 |

这组回放中，用户更快看到第一个 token，但后续 token 的典型间隔略长。不能把两者合称为“推理延迟全面下降”。SGLang 与 LMSYS 官方博客目录均已取回，本期文章判定仍以原文日期和窗口为准。[默认分支提交](https://api.github.com/repos/sgl-project/sglang/commits?page=1&per_page=100&since=2026-11-21T22%3A20%3A00Z&until=2026-11-22T22%3A20%3A00Z) · [SGLang 博客](https://www.sglang.io/blog) · [LMSYS 博客](https://www.lmsys.org/blog/)

## DeepInfer

默认分支窗内有 0 项提交，全仓合并 PR 也为 0 项。GitHub Releases 接口返回空列表，未取得该入口的发布记录。[DeepInfer 发布接口](https://api.github.com/repos/deepseek-ai/DeepInfer/releases) · [DeepInfer 合并 PR](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Adeepseek-ai%2FDeepInfer+is%3Apr+merged%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated) · [默认分支提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100&since=2026-11-21T22%3A20%3A00Z&until=2026-11-22T22%3A20%3A00Z)

同日取得的 DeepInfer 官方 README 和 DeepSeek Open Infra 项目索引，与上一期保存的同一来源响应逐字节相同。这两个入口没有提供新的技术文章证据。[DeepInfer README](https://raw.githubusercontent.com/deepseek-ai/DeepInfer/HEAD/README.md) · [DeepSeek Open Infra 索引](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md)
