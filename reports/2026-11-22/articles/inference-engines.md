# 推理引擎每日变动：vLLM 加快循环状态更新，SGLang 减少 Q/K 拷贝

本期代码窗口为北京时间 11 月 21 日 06:20 至 22 日 06:20。vLLM 和 SGLang 都减少了推理中的内存操作，但一个改的是循环状态更新，另一个改的是 Q/K 归一化。下面分别给出实现、负载和计时单位。

## vLLM

11 月 21 日合入的 #69065 为 CUDA 上的 BF16/FP16 GDN 循环状态增加 MTP 解码内核。新路径用 16 个 lane 分组、128 位读写在寄存器与显存间搬运状态，同时保持与原路径一致的归约顺序。小批次或 FP32 状态仍可走旧路径。作者用 FP32、BF16 和 FP16 循环状态做了共 240 组逐位比对，输出和状态均一致。其中，FP16 用例和下文 FP16 微基准都以补入本 PR 的 FP16 支持后的旧融合 CUDA 内核为参照。合并前的基线代码只接受 BF16 或 FP32 循环状态：FP16 默认回退到 Triton，显式设置 `VLLM_GDN_DECODE_KERNEL=cuda` 则会报错。[内核和正确性测试](https://api.github.com/repos/vllm-project/vllm/pulls/69065) · [分派条件和实际差异](https://api.github.com/repos/vllm-project/vllm/pulls/69065/files?per_page=100) · [合并前的分派源码](https://raw.githubusercontent.com/vllm-project/vllm/2f170a0fed20fd84dfcf6da2a3a8188a32f67e4e/vllm/model_executor/layers/mamba/gdn/qwen_gdn_linear_attn.py)

另一次端到端解码对照在 4×GB300 上运行 Qwen3.8-Flash-Next-FP8，使用 DEP4、MTP3 和 FP16 状态。测试先缓存 30,720 个前缀 token，再输入 1 个、生成 1,024 个。**每个引擎 32 个请求**时，作者用缓存命中的平均 TPOT 乘以平均接受长度，折算每个 decode step 从 16.92–16.98 ms 降至 16.07–16.11 ms。这个值覆盖缓存命中后的解码，未计入冷预填充。作者另报的 1.3–1.6 倍是微内核计时，不能直接换算成在线吞吐增幅。窗内默认分支提交和合并 PR 各 35 项；官方博客最新所见的 Mini 技术文章已在上期报道。[服务负载与计时](https://api.github.com/repos/vllm-project/vllm/pulls/69065) · [提交记录](https://api.github.com/repos/vllm-project/vllm/commits?page=1&per_page=100&since=2026-11-20T22%3A20%3A00Z&until=2026-11-21T22%3A20%3A00Z) · [官方博客](https://vllm.ai/blog)

## SGLang

11 月 21 日合入的 #39071 在 ROCm 上直接把 packed QKV 中 Q、K 切片的实际步长交给融合归一化内核，原地更新，省去先整理为连续二维张量的拷贝。空批次直接返回；视觉分支在 TP 大于 1 时保留跨全部头的归一化。JIT 不可用还有回退路径。[步长传递与路径选择](https://api.github.com/repos/sgl-project/sglang/pulls/39071/files?per_page=100)

PR 说明在本期截止后有过更新。以下是取证时读到的作者结果，合并时间则由窗内记录确认。MI355X 的 BF16 图重放测试显式设置了 `SGLANG_USE_AITER=1`。基线先拷贝 Q/K，再分别为 Q 和 K 启动一次 AITER RMSNorm；换用融合内核后，12 个形状的逐项耗时之和从 640.5 降到 182.7 微秒。另在 MI325X 上，用 Qwen3-30B-A3B、TP1、随机 1,024 入/128 出、关闭 radix cache 做三对交替离线运行，吞吐中位变化为 +3.11%；无需 QK norm 的 Mistral-7B 对照为 −0.21%。两组硬件、负载和指标都不同，在线 P99 尚待实测。窗内默认分支提交和合并 PR 各 96 项；已读官方目录没有可核定的新文。[作者的分平台数据](https://api.github.com/repos/sgl-project/sglang/pulls/39071) · [窗内合并列表](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Asgl-project%2Fsglang+is%3Apr+merged%3A2026-11-20T22%3A20%3A00Z..2026-11-21T22%3A20%3A00Z&sort=updated) · [官方博客](https://www.sglang.io/blog)

## DeepInfer

当窗默认分支提交为 0，全仓合并 PR 为 0，release 列表为空。官方 Open Infra 文章目录最新顶级月份为 2025 年 5 月，结合仓库 README、提交与 PR 检查，本窗没有找到可定为新文章的内容。README 介绍的开源离线推理能力可作背景，本期没有据此新增引擎事件。[默认分支提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100&since=2026-11-20T22%3A20%3A00Z&until=2026-11-21T22%3A20%3A00Z) · [全仓合并列表](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Adeepseek-ai%2FDeepInfer+is%3Apr+merged%3A2026-11-20T22%3A20%3A00Z..2026-11-21T22%3A20%3A00Z&sort=updated) · [发布列表](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?page=1&per_page=5) · [Open Infra 目录](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md) · [官方 README](https://raw.githubusercontent.com/deepseek-ai/DeepInfer/HEAD/README.md)
