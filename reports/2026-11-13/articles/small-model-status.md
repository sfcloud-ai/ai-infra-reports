# 前沿小模型：不把17B激活误当小权重

**本栏为覆盖状态，不计作新闻。** 本期所读[Qwen](https://huggingface.co/api/models?author=Qwen&direction=-1&limit=5&sort=lastModified)、[DeepSeek](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&limit=5&sort=lastModified)和[GLM](https://huggingface.co/api/models?author=zai-org&direction=-1&limit=5&sort=lastModified)官方模型目录不足以完成小模型的任务质量、基线和交付成本核验。列表修改时间不是新模型发布证据，也不等于质量提升。

[主文](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-13/model-serving-gpu/)中的Inkling 2 Small虽然名称含Small、激活参数为17B，但总参数为594B。本期不把它列为小权重模型，也不从激活规模推断单卡可部署。

GLM所读前5项的最新修改早于一周窗口；这一结果仅限所读列表。Qwen和DeepSeek仍缺模型卡正文及diff。本期没有足以入选的前沿小模型条目，原因包括候选证据不足和覆盖不完整，而非完整检索后确认没有新进展。
