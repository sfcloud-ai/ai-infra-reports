# 推理引擎每日变动：vLLM 新增 GDN 解码内核，SGLang 减少 Q/K 拷贝

本期代码窗口为北京时间 11 月 21 日 06:20 至 22 日 06:20。vLLM 调整 GDN 循环状态更新，SGLang 调整 ROCm 上的 Q/K 归一化。

## vLLM

北京时间 11 月 21 日合入的 #69065 为 BF16/FP16 循环状态新增 GDN MTP 解码内核。这个内核只为 `sm_103a` 构建，调整了点积归约时线程间交换数据的方式。[内核和正确性测试](https://api.github.com/repos/vllm-project/vllm/pulls/69065) · [分派条件和实际差异](https://api.github.com/repos/vllm-project/vllm/pulls/69065/files?per_page=100)

合并前，FP16 循环状态默认回退到 Triton。这次改动也让融合 CUDA 路径能接受 FP16 状态。核对服务所用路径时，需要结合状态精度、设备和实际分派条件。[内核和正确性测试](https://api.github.com/repos/vllm-project/vllm/pulls/69065) · [合并前的分派源码](https://raw.githubusercontent.com/vllm-project/vllm/2f170a0fed20fd84dfcf6da2a3a8188a32f67e4e/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py)

本期同时核对了 vLLM 默认分支和官方博客。[提交记录](https://api.github.com/repos/vllm-project/vllm/commits?page=1&per_page=100&since=2026-11-20T22%3A20%3A00Z&until=2026-11-21T22%3A20%3A00Z) · [官方博客](https://vllm.ai/blog)

## SGLang

北京时间 11 月 21 日合入的 #39071 让 ROCm 融合归一化内核直接处理 packed QKV 中带步长的 Q、K 切片，并原地更新。命中这条路径时，可以省去为归一化准备连续张量的拷贝。[步长传递与路径选择](https://api.github.com/repos/sgl-project/sglang/pulls/39071/files?per_page=100) · [合并说明](https://api.github.com/repos/sgl-project/sglang/pulls/39071)

本期还核对了 SGLang 的窗内合并列表和官方博客。[窗内合并列表](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Asgl-project%2Fsglang+is%3Apr+merged%3A2026-11-20T22%3A20%3A00Z..2026-11-21T22%3A20%3A00Z&sort=updated) · [官方博客](https://www.sglang.io/blog)

## DeepInfer

本窗口的默认分支提交和全仓合并 PR 均无新增，读取的 release 列表为空。已核对的官方 Open Infra 目录和仓库 README 也未提供可确认为本期新文的条目。[默认分支提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100&since=2026-11-20T22%3A20%3A00Z&until=2026-11-21T22%3A20%3A00Z) · [全仓合并列表](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Adeepseek-ai%2FDeepInfer+is%3Apr+merged%3A2026-11-20T22%3A20%3A00Z..2026-11-21T22%3A20%3A00Z&sort=updated) · [发布列表](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?page=1&per_page=5) · [Open Infra 目录](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md) · [官方 README](https://raw.githubusercontent.com/deepseek-ai/DeepInfer/HEAD/README.md)
