# 推理引擎每日变动：HY4 Flash 加入流水线并行和分离式 DFly

## vLLM

#70300 于北京时间 11 月 27 日 22:20 合入。HY4 Flash 移除了 PP=1 限制，加入流水线并行支持。预填充与解码分离时，DFly 接受 NixlConnector 或 MooncakeConnector。文档和测试补充了相关连接器组合。[PR](https://github.com/vllm-project/vllm/pull/70300) · [文档与测试改动](https://api.github.com/repos/vllm-project/vllm/pulls/70300/files?page=1&per_page=100)

作者在 GB200 上用 HY4 Flash FP8 测了指定 PP、TP 组合和 1P1D。1P1D 测试使用一台 TP4 预填充节点和一台 TP4 解码节点，报告了任务准确率和 DFly 接受率。作者另报告 PP 等价测试的逐位一致结果。这些结果覆盖 PR 列明的 CUDA 环境、拓扑和连接器组合，稳定版可用性仍需核对发行记录。[作者的 GB200 验证与 PP 等价测试](https://github.com/vllm-project/vllm/pull/70300)

普通 sparse-MLA 预填充接入 HiSparse 的传输条件见服务页，Qwen4Exp FP8 QSA 的单卡数据见架构页。[HiSparse PR](https://github.com/vllm-project/vllm/pull/66502) · [QSA PR](https://github.com/vllm-project/vllm/pull/70187)

## SGLang

load-diff 新增权重快照格式，尚无调用方。GB10 上的低 M MXFP8 MoE 分支改为仅单 token 使用。Ascend 950DT 上的 GLM-5.3-Flash 交错预填充 CP 数据及其测试条件见架构页。[权重快照](https://github.com/sgl-project/sglang/pull/51728) · [GB10 分流](https://github.com/sgl-project/sglang/pull/53557) · [Ascend 预填充 CP](https://github.com/sgl-project/sglang/pull/51185)

## DeepInfer

官方已关闭 PR 列表去重后为 32 条，已越过 72 小时下界，未见主窗合入。官方 open-infra README 还列有历史项目和文章，单凭该索引无法确认本窗的新技术文章。其他分支、发行版本和实际部署能力仍需对应证据。[官方 closed PR 列表](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls?direction=desc&page=1&per_page=100&sort=updated&state=closed) · [官方基础设施索引](https://api.github.com/repos/deepseek-ai/open-infra-index/readme)

## 分页与文章覆盖

两家引擎的已关闭 PR 各读两页，每页 100 条，vLLM 与 SGLang 分别去重为 199 和 200 条。第二页已越过 24 小时下界，仍有第三页，未到 72 小时下界。两项查询也未覆盖全部 commits 与 releases。[vLLM 第二页](https://api.github.com/repositories/599547518/pulls?direction=desc&page=2&per_page=100&sort=updated&state=closed) · [SGLang 第二页](https://api.github.com/repositories/740303686/pulls?direction=desc&page=2&per_page=100&sort=updated&state=closed)

vLLM 官方归档可见 ERNIE 5.5 Flash Preview 和 vLLM-GR 的 11 月 24 日条目，尚缺正文与带时区的发表时刻。SGLang 官方博客已读取，Intel 技术文章的日期精度见硬件页。[vLLM 归档](https://vllm.ai/blog/archive) · [SGLang 官方博客](https://www.sglang.io/blog) · [Intel 技术原文](https://www.lmsys.org/blog/2026-11-27-sglang-intel/)
