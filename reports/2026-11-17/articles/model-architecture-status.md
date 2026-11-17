长 prompt 在多张卡之间切分后，每张卡只处理一部分 token，但模型的一些操作仍依赖全局上下文。与此同时，CUDA Graph 要求捕获时的地址和形状可复用。把张量切小只是第一步：有效长度、状态写入和最终输出顺序都要保持一致。

SGLang **11 月 16 日 07:05 UTC** 合入 **#40333**，提交 `50fbc8af48f8`，将 DeepSeek 路径的 **interleave context parallel、breakable CUDA Graph 与 prefill/decode 分离**衔接起来。

### 分片计算，不能分丢上下文

**全局 prompt → 按 rank 组织 embeddings、positions、token IDs 和有效长度 → 对齐每 rank 的 graph bucket → 只为有效 token 更新压缩状态 → 恢复输出 token 顺序 → 去掉 padding 后计算末端 logits**。

这里 Engram 的 hash 仍取自全局 prompt 上下文，不能只拿当前分片局部 token 计算。graph bucket 的物理容量也不能当成真实 token 数：把补齐区写入压缩状态，会改变后续推理。使用 DSpark 辅助输出时，同样需要恢复顺序并清除 padding。

多模态 embeddings 先生成再做上下文切分。文字路径可以使用 breakable graph；图像路径回退到 eager context parallel，而非宣称所有模态都已 graph 化。适用范围包括 **PP=1、非 HIP**；PR 涉及 B200/H200，但本期没有取得其性能图片的可核实数字，因此不写百分比收益。

相对单纯切 KV，这项工作还处理模型运行状态与 token 布局，验证时应先比较同一 prompt 的输出、压缩状态和 Engram 行为，再比较 graph 重放及 prefill 尾延迟。主线合入说明代码状态，不等于每种拓扑都已稳定发布。

### 模型卡和官方博客实际读到了什么

GLM、DeepSeek、Qwen 的模型入口与技术文章均单独检查。**当前 GLM 官网导航列出的两篇官方文章已经读到完整正文，日期分别为 8 月 14 日和 8 月 26 日，均早于本期窗口。博客目录仍不可用，这次核查不代表全站历史目录或所有发布渠道完整覆盖。** 两篇正文没有被包装成今天的新发布。

Qwen4-Max 正文已经读取，但文章接口的 11 月 16 日日期与页面可见/OG 的 8 月 3 日日期冲突，未能确认首次发布时间，因此不作为本期新模型事件。其正文描述的 2.4T 主干、额外 328B N-gram embedding 与 71B 激活参数，也不能简写成“71B 总权重”；API 产品信息不能代替可部署权重证据。DeepSeek 的既报模板事件和窗口外权重变动按历史去重。

原始来源：[原始来源 1](https://api.github.com/repos/sgl-project/sglang/pulls/40333)；[原始来源 2](https://api.github.com/repos/sgl-project/sglang/commits/50fbc8af48f8)；[GLM 5.3 正文入口](https://z.ai/blog/glm-5.3)；[GLM 5.3 Flash 正文入口](https://z.ai/blog/glm-5.3-flash)；[Qwen4-Max 官方文章](https://qwen.ai/blog?id=qwen4-max)。
