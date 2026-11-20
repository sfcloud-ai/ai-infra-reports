# 推理引擎每日变动：从缓存写入限额到 SM120 专家通信

同样出现“更快”两个字，缓存写入、验证内核和专家通信衡量的工作不同。下面保留各自的分支、对照和部署条件。核查窗口为 11 月 18 日 22:20 至 19 日 22:20 UTC。

## vLLM

#68529 于 11 月 19 日合入 main（`a3b845e2`）。Mooncake 按请求限制新写入的 KV 前缀，同时保留已有缓存的查找与加载。零写入策略、块取整和 CPU 测试见本期模型服务页。用在服务中应分别看后端写流量和后续的重算压力。窗口内读完 121 条已合入 PR 和 121 条默认分支提交；最新可见稳定版 v0.34.0 于 11 月 16 日发布，早于这项合入。官方博客最新可见的 FlyDSL 文章署 11 月 18 日，现有材料不能把它计成本窗新增。[vLLM #68529](https://api.github.com/repos/vllm-project/vllm/pulls/68529) · [稳定版](https://api.github.com/repos/vllm-project/vllm/releases/latest) · [官方博客](https://vllm.ai/blog)

## SGLang

#49068 已合入 main（`e4353c97`），定宽验证的新 BF16 K 复用默认关闭。DeepSeek-V4.1-Flash 在 8 张 H20-3e 的分离部署中同时切换两个复用开关，平均 TPOT 下降 8.54%，平均 TTFT 增加 10.85%；完整负载见本期模型与架构页。窗口内读到 75 条已合入 PR、73 条默认分支提交，最新可见稳定版 v0.5.23 发布于 11 月 2 日。SGLang 官方博客目录所见最新日期为 11 月 12 日。另查 LMSYS，H20-3e 文章有正文但首发时点不足以归窗，Humming 有公告但缺完整博文。这两篇均未作为独立新闻计数。[SGLang #49068](https://api.github.com/repos/sgl-project/sglang/pulls/49068) · [稳定版](https://api.github.com/repos/sgl-project/sglang/releases/latest) · [官方博客](https://www.sglang.io/blog) · [LMSYS 目录](https://www.lmsys.org/blog/)

## DeepInfer

DeepSeek-V4.1-Flash 做 MoE 解码时，需要把 token 送到对应专家，计算后再合并。#291 将 SM120 上原先由 DeepEP 分发、DeepGEMM 计算、DeepEP 合并的路径改为 FlashInfer Cake MegaMoE。每层由一个持久内核完成分发、计算和合并，可映射的对端显存走 PCIe，其余走 NCCL。11 月 19 日改动进入 **nv-dev**（`f29e7209`）。[DeepInfer #291](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/291) · [内核和后端代码](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/291/files?page=1&per_page=100)

基线是 DeepEP，实验为 **8 张 RTX PRO 6000、预填充批大小 8,192、64 个解码请求、5 个 DSpark 草稿 token**。离线解码从 7.18 升至 9.93 步/秒（约 +38%），而预填充由 4,520 变为 4,457 token/秒/GPU。在 1,319 题的 GSM8K 对照中，不同推测解码设置下的分数有升有降。选择后端需按自己业务的预填充/解码比例重测，尤其不能从每秒解码步数推算线上 P99。[性能表和质量对照](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/291)

同窗随后合入 nv-dev 的 #294（`78f57c13`）为 SM120 固定 NCCL 2.30.7，并从该构建去掉要求更高 NCCL 版本的 DeepEP。可选值为 `auto`、`cake`、`nccl`；SM100 继续使用 NCCL 2.32.3 和 DeepEP。#291 的历史基线与 #294 的最终可选后端要分开看。窗内已合入 PR 共 4 条，默认分支提交为 0；最新稳定版入口返回 404，替代的官方发布清单为空。工程证据来自开发分支及其文档补丁，尚无稳定发布标签支撑；亦无 H100、H200 的同条件结果。[构建修订 #294](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/294) · [支持矩阵的实际改动](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/294/files?page=1&per_page=100) · [官方发布清单](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?page=1&per_page=5) · [官方技术索引](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md)
