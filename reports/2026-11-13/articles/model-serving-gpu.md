# Inkling 2 Small：通信、运行状态与专家计算一起优化

**11月12日引擎集成与实测进展。** vLLM 原始文章时间为 2026-11-12 09:00 UTC；SGLang 文章标注11月12日，未提供时区和时分秒。两篇讨论同一模型，本期合并为一条新闻，不将补充来源拆成独立进展。[vLLM 官方文章](https://vllm.ai/blog/2026-11-12-inkling2-small) · [SGLang 官方文章](https://www.sglang.io/blog/inkling-2-small-day0-support)

## 问题：生成一个词，为什么会反复搬动同一份状态？

多卡模型生成下一个 token（文本片段）时，除了矩阵乘法，还要汇总各 GPU 的计算结果、更新短卷积和残差状态、做归一化并读取 KV。KV 是历史 token 的注意力中间结果。单个步骤很短，但反复启动计算核、搬动同一份数据，仍会拖慢低并发时的响应。

Inkling 2 Small 新增 block attention residuals：以学习到的权重混合此前多个层块的输出，而非只有一条残差流。这使状态管理和层边界处理更重要。

## vLLM：合并层边界，长输入按 token 分片

vLLM 把跨卡求和汇总（all-reduce）、短卷积、残差更新、attention-residual 混合及 RMSNorm 归一化融合。通信经 NVLink multicast 完成，后续中间状态尽量留在寄存器，减少重复访存。PDL 让相邻计算核的部分工作重叠，针对的是短计算核串联带来的启动开销。

长输入预处理（prefill）不再让每张 GPU 重复处理全部 token：先 reduce-scatter 分配切片，在各卡自己的切片上融合处理，再 all-gather 汇总。文章报告，8K-token prefill step 在 TP4 和 TP8 下分别缩短22%和26%，每 GPU 释放1.3–1.9 GiB给 KV。这是原条件下的增量收益，不是所有模型或多租户环境的可售超配额度。

解码时，原 FA4 路径的 GQA 打包在该模型6:1比例下失效。专用 Gluon kernel 把6个 query head 打包到一块，KV只读一次，并处理相对位置偏置。原文给出 batch 1、100K上下文的 decode step 从15.1 ms到4.8 ms；不能将这项局部比较等同于整套服务端到端提速。

![同一模型内部的通信、状态与KV读取机制简图](assets/mechanism.png)

## SGLang：专家计算与缓存层次一起适配

SGLang 提供混合注意力的 Unified Radix Cache、统一内存池及 HiCache。HiCache 将缓存扩展到主机内存和 Mooncake 存储层。MegaMoE 将该模型的 NVFP4 和 MXFP8 专家纳入每层持久计算核；专用 relative-bias 解码核把 KV 工作拆到最多64个 CTA，并读取紧凑的偏置表。

相较 grouped-GEMM 路径，文章报告 MegaMoE 的首 token 时间下降20–27%，batch 64 的 DSpark decode time/token下降17%。这些是有指定基线的局部比较，原文没有给每项比较的全部独立实验参数；不能把缓存、通信、草拟及计算核的组合收益全部归给 MegaMoE。

## 性能必须带着负载一起看

vLLM 的整体性能表使用 TP8、两个4-GPU节点，开启 DSpark 概率草拟和前缀缓存。Agent 每轮带入约2K工具输出及前轮回答，约3K新 token，生成1024 token，reasoning开启、temperature=1.0。在每用户100 token/s约束下，32K、64K、128K、256K会话上下文对应每 GPU 输出吞吐约1070、915、700、450 token/s。原文另将单用户约630 token/s明确关联GB200、TP4及接受长度3.5；不把该单用户配置擅自填到TP8表格。

SGLang 的图则是四卡 TP4/EP4、随机8K输入/1K输出的 **decode-only** 测量，DSpark接受长度**模拟为3.5**。batch 192时，VR200为每GPU5895、每用户123 token/s；GB300为每GPU3642、每用户76 token/s。这没有计入完整请求处理，也不是测得的真实生成接受率，不能和上面的Agent负载直接排名，更不能外推到H100/H200。

## 质量、复现与交付判断

vLLM称在开启DSpark后，NIAH最长1M token、MMMU-Pro、HLE的分数与其关闭推测解码的运行一致，但正文没有列具体分值。这支持在那些测试上的一致性描述，不能扩展为所有任务无质量损失。

两文提供服务命令或部署recipe入口，SGLang列出dev镜像；本次归档未补齐对应精确release/commit及全部recipe，因此不称稳定生产版已验证。H200出现在SGLang硬件recipe列表，不等于本期已经验证其容量和性能；H100及Pro5500兼容性不作承诺。

对算力交付，建议先用实际目标硬件固定精度、并行规模、上下文、前缀命中率与目标尾延迟，再测可售并发。权重、KV、卷积和残差状态要分别计量。这里优化的是**同一模型内部状态**，没有让不同模型共享权重，也不能默认跨模型共享KV。

本期服务方向选入上述有具体机制和条件的进展；它不是独立权重超配方案，不以此承诺超配倍数。
