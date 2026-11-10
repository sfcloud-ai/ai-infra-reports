历史归档：原期次 2026-10-13，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

## GraphTok 的问题在模型计算之前

长上下文已经命中 KV 缓存，仍需先把文本转换成 token ID，才能判断缓存前缀。如果 CPU 分词占了首字延迟的大头，继续优化模型 kernel 不一定有效。GraphTok 将受支持的预分词、BPE 合并和 ID 装配放到 GPU，预备工作区并以 CUDA Graph 重放减少启动成本；短请求可以走 CPU，并发请求可组成 GPU batch。部分前处理仍在 CPU，因此它不是消灭前端 CPU 工作。[固定版本架构](https://github.com/Msiavashi/GraphTok/blob/8bd40e1e9d09cc684f2579415072db9516e36b3b/docs/ARCHITECTURE.md)

[论文 v1](https://arxiv.org/html/2610.13325v1)在 H100 NVL、121k-token 输入、P99 不超过 2 秒的 Dynamo 前端实验中，报告 GraphTok 518 req/s、gigatoken 296 req/s。但后端为模拟实现，tokenizer 前缀缓存关闭，gigatoken 跨请求缓存也被清空。这是前端承载能力，不是模型吞吐；真实单 GPU vLLM 的一组单请求对照，首字差距不足 4%。

真正的基线应是保留热缓存的快 CPU tokenizer，以及安全的增量复用。若与推理共享 GPU，还要计算分词 kernel、工作区和排队对模型尾延迟的影响。高并发只会放大需要核算的资源竞争，并不自动使 GPU 路线获胜。先拆开分词、排队、prefill 与 TTFT，再判断瓶颈能否通过 CPU 优化解决。

当期已有 CUDA/C++、Python 绑定、vLLM 插件和 Dynamo 接入材料，但 Dynamo 材料是特定版本补丁，不宜称为完全无侵入。测试依赖词表与编译目标，跳过用例不能当作覆盖通过。[构建](https://github.com/Msiavashi/GraphTok/blob/8bd40e1e9d09cc684f2579415072db9516e36b3b/docs/BUILD.md)与[接入说明](https://github.com/Msiavashi/GraphTok/blob/8bd40e1e9d09cc684f2579415072db9516e36b3b/integrations/dynamo/README.md)限定了实际维护范围。

## AlignQuant 的增量是让混合精度贴合执行布局

量化文件更小不代表 kernel 更快。AlignQuant 按 64×64 tile 对齐精度、存储与执行，在保留部分高精度权重的同时减少解包与计算的不规则性。典型权重配置混用 4-bit 与 8-bit，激活为 8-bit。[论文 v1](https://arxiv.org/html/2610.07457v1)给出的 Llama-3.2-3B、4090 表格中，生成吞吐为 180.64 token/s，BF16 为 108.05；TTFT 却由 11.79 增至 16.54 ms。由表格计算，前者约增加 67%，后者约增加 40%。

显存同样有取舍：2.71 GiB 低于 BF16 的 5.99，却高于 AWQ 的 2.12；部分质量指标也下降。结果支持“长输出场景值得评估”，不支持“首字、质量和容量同时更优”。单请求表格不能代替并发尾延迟测试，跨表负载条件也需在复现时重新确认。

[当期源码](https://github.com/HanzhiZhang-Ulrica/AlignQuant/tree/0ad8206971fbfe0e5a6c573de3bae96d572e46d7)包含校准、打包与推理入口，但当期未核实明确商业许可或现成 vLLM/SGLang 插件。应先解决许可与加载/kernel 兼容，再与调优后的成熟量化方案做同质量比较。两项的共同结论是：只在真实瓶颈上增加复杂度，用完整请求的质量、首字、尾延迟与整卡成本决定是否采用。
