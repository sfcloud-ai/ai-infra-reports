本期以 **11 月 15 日 07:20 北京时间**为截点，先查过去 24 小时，再扩展到七日，读取小模型官方入口、模型卡及候选差异。当前核查范围内没有选出可新增报道的模型能力进展；以下说明实际取舍，不以旧消息补位。

### 三类容易误报的更新

**SmolVLM 500M** 的模板修复已在 11 月 14 日晨报报道，本期不重复计为新模型。**Gemma** 官方入口中相关最新内容日期为 11 月 3 日，超出本期七日窗口。**FrogNano 4B** 模型卡虽显示 11 月更新，但实际 README 差异只是 frontmatter 的 `mit` 改为 `apache-2.0`，正文此前已经写 Apache 2.0；不能据此宣称新权重、新能力或一次已核实的许可政策变更。

此外，已报的 Inkling2 Small 是 **594B 总参数、17B 激活参数**。名称含 Small 或单 token 激活量较低，不代表常驻权重成本就是同量级的小模型；本期没有把它重新归为轻量模型新闻。

### 对部署判断的价值

选择小模型时，应分别固定总权重、激活参数、精度、上下文和输入模态，再比较同一任务的质量、可接受错误、延迟、吞吐与显存。`lastModified`、卡片标签或模板修复，只有在明确影响这些条件时才构成对应的部署增量。

本期没有新增可支持 SOTA、性能领先或 H100/H200 成本优势的比较，因此不画排名和速度图。后续值得补的是同任务质量门槛下的实际成本，而不是按模型名字或更新时间做选型。

实际核查来源：[来源 1](https://huggingface.co/api/models?author=HuggingFaceTB&direction=-1&full=true&limit=20&sort=lastModified)；[来源 2](https://huggingface.co/api/models?author=microsoft&direction=-1&full=true&limit=20&sort=lastModified)；[来源 3](https://huggingface.co/api/models?author=google&direction=-1&full=true&limit=20&sort=lastModified)；[来源 4](https://huggingface.co/microsoft/FrogNano-4B-2609/raw/1844d06083df631f634e417938b3b8feda5f9f48/README.md)；[来源 5](https://huggingface.co/api/models/microsoft/FrogNano-4B-2609/commits/main)；[来源 6](https://huggingface.co/microsoft/FrogNano-4B-2609/raw/b90468c11a913c1916b4542b4b7a530ec42024a4/README.md)；[来源 7](https://vllm.ai/blog/2026-11-12-inkling2-small)。
