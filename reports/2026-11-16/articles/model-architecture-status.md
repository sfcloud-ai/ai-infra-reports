长上下文不仅占用 KV，还会放大中间激活。张量并行时，如果某些按 token 行独立执行的 GR/PLE 操作在每张卡上保留完整行，显存与计算会重复；但切分位置、归约方式和 padding 必须与后续注意力及 MoE 路径一致。

SGLang **11 月 15 日 13:45 UTC** 合入 #43048，提交 `e4c3f001d6bc8cb43e778b6b27d562af550db8c9`。对象是 **Qwen4Exp 实验引擎路径**，实测模型为 **Qwen3.8-Flash-Next-FP8**。不能据名字写成 Qwen4-Max 官方权重已在本地得到支持。

### 切分、恢复与归约

启用 `--enable-layernorm-sp` 后，prefill/EXTEND 的 GR 与 PLE 激活按 token 行在 TP 组切分；GDN/attention 恢复完整 token 行计算，再对 TP 部分输出做 SUM reduce-scatter。MoE 是否归约取决于输出是否已经完整；最终补丁还保留 **DeepEP/MegaMoE 的本地行路径**，不能统一概括为“所有 MoE 先 all-gather”。

PLE **先补齐到物理 CUDA Graph bucket，再切分**。例如 5624 个有效 token、bucket 8192、TP4，四张卡的物理行是 2048、2048、1528+520 padding、2048 padding；这与各卡先均分有效 token 再独立补齐不同，后者会把 padding 插入有效序列中间，扰乱短卷积状态。

### 实测与启用条件

作者在 **4×H20、TP4/EP4、chunked prefill 8192、FlashInfer 线性注意力**下，对开关 OFF/ON 重复重启并固定 warmup。32K、batch1 的 TTFT 下降 **17.72–18.36%**，每 GPU 峰值内存约下降 **1 GiB**；这些数字限于该配置，不能外推到 H100/H200。decode 不走此优化，batch1 的 TPOT 基本不变。

约束包括 **TP>1、EP=TP、PP=1、禁用 DP attention 与推测解码、attention CP=1**。主线合入不等于所有组合或稳定版本已覆盖；本期未复跑上游性能测试。复现应先验证拓扑拒绝、TP 部分输出归约、完整输出不重复求和及 PLE 行布局，再比较相同长上下文负载。

### 官方模型与博客检查

本期分别读取 GLM、DeepSeek、Qwen 官方模型索引，以及 DeepSeek 动态、Qwen 当前文章接口。GLM 则沿当日官方模型索引追溯，并读完 [GLM-5.3-Flash 官方文章](https://z.ai/blog/glm-5.3-flash)直接引用的正文模块，原日期为 **8 月 26 日**，不列为本期新消息。博客列表仍返回404：这里完成的是该模型文章的追溯核查，**不声称取得全站完整目录，也不据此断言本窗口没有其他新文章**。Qwen 接口返回的40篇正文中最新列示9月20日，这只是该入口的实际结果，不能据此否认其他渠道的更新。

原始来源：[原始来源 1](https://api.github.com/repos/sgl-project/sglang/pulls/43048)；[原始来源 2](https://api.github.com/repos/sgl-project/sglang/commits/e4c3f001d6bc8cb43e778b6b27d562af550db8c9)；[GLM 官方博客](https://z.ai/blog)；[Qwen 官方文章入口](https://qwen.ai/research)。
