# 推理引擎每日变动：技术文章已读，代码覆盖有缺口

本篇保留三家引擎的独立核查状态。Inkling 2 Small两家首日适配已合并到[同一技术主文](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-13/model-serving-gpu/)，这里不重复计作新闻。

## vLLM

已读[官方博客归档](https://vllm.ai/blog/archive)和[11月12日Inkling文章](https://vllm.ai/blog/2026-11-12-inkling2-small)，原始Markdown提供2026-11-12 09:00 UTC时间。主文涉及层边界融合、长输入sequence parallelism和6:1 GQA解码kernel。

所读[release列表](https://api.github.com/repos/vllm-project/vllm/releases?per_page=5)最新版本为v0.33.0rc3、时间11月2日；未完成最新commit/PR核查，不能据此称代码没有更新。文章的day-0支持也不等于本期已确认稳定release或精确可复现commit。

## SGLang

已读[博客列表](https://www.sglang.io/blog)和[Inkling支持正文](https://www.sglang.io/blog/inkling-2-small-day0-support)，日期精度为11月12日。统一缓存、HiCache、MegaMoE和relative-bias attention的机制与实验限制见主文。性能图是decode-only且接受长度模拟为3.5，不是端到端线上SLO结果。

所读[release列表](https://api.github.com/repos/sgl-project/sglang/releases?per_page=5)最新v0.5.23发布于11月2日；未补齐最新commit/PR与完整recipe，保留代码覆盖缺口。[LMSYS博客入口](https://www.lmsys.org/blog/)未取得可用当前文章列表，不能写成无新文章。

## DeepInfer

已单独读[官方仓库](https://github.com/deepseek-ai/DeepInfer)和[默认分支最近5条提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?per_page=5)。所读最新提交为a679bb86ce36e883a98a97733492b686e5b9a08e，时间2026-11-03 07:31:40 UTC，早于本期一周窗口；在这个明确范围内未选出合格新变动。README静态能力及早期文档变更不作为本期新闻。

另读[官方infra索引](https://github.com/deepseek-ai/open-infra-index)，没有把索引时间当成技术文章发布时间。该核查不代表全仓库所有分支/PR或全部站点已查清。DeepInfer与FlashInfer不是同一项目，不混称。
