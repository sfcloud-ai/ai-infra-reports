**这是一项补充核验。**11 月 10 日晨报曾把 DeepSeek-V4.1-Flash-1017 模板作为晚于截止时间的线索记录，当时未入选新闻；本篇补充核对实际文件的输入语义和兼容边界，不把模板加入当作今日新发布。原提交时间为 **11 月 10 日 02:22 UTC**，属于本期七日扩展窗口。

### 已存在的模板与陈旧说明

提交 `08c8657f02291e11b6f6b63e0e16014f8e748518` 中实际存在 `chat_template.jinja`，相关 HF #11 已显示 merged；同一版本 README 仍声称没有 Jinja 模板。部署时应固定实际文件和 revision，不能只按 README 判断输入路径。

模板接受 `thinking` / `enable_thinking`：`none` 在没有显式覆盖时关闭思考；`minimal/low` 映射为 50，`medium/high/xhigh` 为 75，`max` 为 100。工具参数要求对象形式，传字符串会被拒绝。应用层看似相同的聊天请求，若模板或参数表示不同，送给模型的输入可能不同。

### 对引擎和缓存意味着什么

这次不是新权重、MoE 拓扑或 KV 压缩方案。值得验证的是消息到 token 的协议：固定 tokenizer/template revision，对多轮、工具调用与思考强度做编码金样对照，再验证引擎实际接受的输入。前缀缓存也应以真正编码后的输入和模型版本为依据，不能因为显示文本相同就推定可复用。

当前文件仍有 `dict()` 与链式比较；讨论中提出的 llama.cpp / transformers.js 兼容改法，不能冒充当前文件已经实现。这里没有新的硬件吞吐或质量对比，不据此承诺性能收益。

### 本期来源范围

本期读取了 DeepSeek 的实际模板、README 与官方入口，以及 Qwen 官方模型列表和技术文章内容；GLM 则沿今日官方模型列表追溯并读完了 [GLM-5.3-Flash 官方文章](https://z.ai/blog/glm-5.3-flash)及页面直接引用的正文模块。文章原日期为 **8 月 26 日**，不列为本期新消息。博客列表仍不可用：这里完成的是该模型文章的追溯核查，**不声称取得全站完整目录，也不据此断言本窗口没有其他新文章**。

原始来源：[原始来源 1](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/08c8657f02291e11b6f6b63e0e16014f8e748518/chat_template.jinja)；[原始来源 2](https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash-1017/commits/main)；[原始来源 3](https://huggingface.co/api/models/deepseek-ai/DeepSeek-V4.1-Flash-1017/discussions/11)；[原始来源 4](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017/raw/08c8657f02291e11b6f6b63e0e16014f8e748518/README.md)。
