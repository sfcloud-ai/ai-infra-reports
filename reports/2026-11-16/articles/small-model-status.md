小模型部署中，权重没有变，输入协议也可能变。普通字符串消息如果被模板当成图文块列表遍历，文本会丢失；这种错误需要修复，但不能包装成模型能力刷新或新 SOTA。

本期以 **11 月 16 日 07:20（北京时间）**为截止，检查 HuggingFaceTB、Microsoft、Google 官方模型索引，并续读 SmolVLM-256M 模型卡、提交记录及前后模板，以及 FrogNano 的实际模型卡。

### SmolVLM-256M：新增的是输入分支

**11 月 13 日 08:37 UTC** 的 `d039ab0d4b9311b617e8ffec1d06c8464364aeb3` 在 `chat_template.json` 中增加 `content is string` 分支，直接输出字符串；图文块列表仍走原有逻辑。前后文件已逐字核对。它与11月14日晨报已报道的500M版本属于同类输入契约问题，本期不把它再包装成新模型性能新闻。

当前256M模型卡描述的是图像与文本输入、文本输出的小模型，不支持图像生成；卡中的“单图低于1GB显存”也不是本次模板修复产生的新测量。部署时应分别固定权重、tokenizer和template版本，以纯字符串、图文块列表、多轮对话做编码金样对照，再测业务任务质量与资源占用。

### 其他入口的实际结果

Microsoft 列表中 FrogNano-4B-2609 的最新变动为11月12日；相关许可元数据变动已在昨日晨报处理。本次读到的卡仍将用途限定为代码 agent，不能直接迁移为具身控制或通用多模态能力。Google 当前列表最新条目为11月3日，已在本期七日窗口外。

SGLang 的 Inkling 2 Small 官方文章也已读取：**594B总参数、17B激活参数**不等于小权重模型；其中固定接受长度模拟的decode测量不能作为端到端在线成本。该事件已在历史中，本期不重复列为新进展。

本次已核查范围没有选出足以支持新的质量—成本结论的小模型事件；这不表示整个领域没有更新。保留这份具体核查结果，避免用权重名称、索引更新时间或营销称号填充栏目。

原始来源：[SmolVLM-256M模型卡](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct)；[新模板](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/raw/d039ab0d4b9311b617e8ffec1d06c8464364aeb3/chat_template.json)；[旧模板](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/raw/7e3e67edbbed1bf9888184d9df282b700a323964/chat_template.json)；[FrogNano模型卡](https://huggingface.co/microsoft/FrogNano-4B-2609)；[Google官方模型索引](https://huggingface.co/api/models?author=google&direction=-1&full=true&limit=20&sort=lastModified)；[SGLang Inkling官方全文](https://www.sglang.io/blog/inkling-2-small-day0-support)。
