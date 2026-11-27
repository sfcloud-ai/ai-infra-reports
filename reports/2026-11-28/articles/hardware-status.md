# 硬件与算力平台：GB10 的低 M MXFP8 MoE 路径为何只留给单 token

## GB10 按 token 数分流

SGLang #53557 在 11 月 27 日 21:59 合入。SM121 上，MXFP8 的低 M 分支只在单 token 时继续使用，超过 1 token 走一般路径。独立的低 M routing 与 NVFP4 路径保留。SM120 沿用现有条件。[PR](https://github.com/sgl-project/sglang/pull/53557) · [分支判断](https://api.github.com/repos/sgl-project/sglang/pulls/53557/files?page=1&per_page=100)

作者在 GB10 DGX Spark（计算能力 12.1，48 个 SM）上以 CUDA graph 测了 4 个 L2 冷态 MoE 层，按每层计时。按 PR 的对照，低 M MXFP8 在 8 至 64 token 时比 CUTLASS grouped GEMM 慢约 4% 至 5%。这些按层计时结果限定在该卡型和该 token 区间。整模时延或其他 GPU 的路径收益仍需对应实测。[作者基准](https://github.com/sgl-project/sglang/pull/53557)

## Intel 原文说明了哪些平台条件

LMSYS 上的 Intel 技术文章注明 11 月 27 日，原件未给出精确时刻与时区。本期把它作为平台状态材料。文中指出 Xeon AMX 的收益依赖矩阵形状和 batch 大小。Xe2 路径让专家权重以压缩形态驻留，在计算内核里转换所需的权重块。将编码器、预填充和解码分离部署时，还需计入额外的 embedding 和 KV 传输以及 worker 协调。[Intel 技术原文](https://www.lmsys.org/blog/2026-11-27-sglang-intel/)
