# 前沿小模型：所查官方源未选出合格新条目

本板块不计入新闻数量。本次检查 HuggingFaceTB、Google、Microsoft 和 Thinking Machines 官方模型列表，并读取 Inkling2 Small 官方发布说明及模型卡；没有将名称中的“Small”直接等同于轻量、可自托管或低成本。

## 已查范围与取舍

所查 SmolLM 相关最新记录为10月29日，Gemma相关记录为11月3日，均在本次最多一周窗口之外。Microsoft最新列表包含图模型等与本板块交付目标不直接相符的维护，未据列表更新时间推断为新的小型生成模型发布。

Thinking Machines 的 Inkling2 Small 官方发布页明确给出11月5日日期，模型卡描述5940亿总参数、每token约170亿激活参数。激活参数只反映每次计算调用的部分参数，不代表只需储存170亿权重。官方说明当时通过 Tinker 提供服务，并称后续开放权重；本次所查官方 Hugging Face 列表未发现 Inkling2 的开放权重。因此不把它写成已可下载、可复现的小模型，也不据低位格式推算未经验证的显卡数量或服务成本。

对算力销售和模型交付，下一步需要验证开放权重、完整实现、目标硬件、任务质量、端到端延迟及并发成本，而不是凭模型名或单项基准承诺收益。

## 覆盖边界

上述结论只覆盖实际检查的官方源，不是全网小模型检索穷尽证明。没有找到合格条目与没有检查到全部来源是两回事；本期不以候选不足编凑新闻。

## 原始来源

- [HuggingFaceTB 官方模型](https://huggingface.co/HuggingFaceTB)
- [Google 官方模型](https://huggingface.co/google)
- [Microsoft 官方模型](https://huggingface.co/microsoft)
- [Inkling2 Small 官方发布说明](https://thinkingmachines.ai/news/inkling-2-small/)
- [Inkling2 Small 官方模型卡](https://thinkingmachines.ai/model-card/inkling-2-small/)
- [Thinking Machines 官方模型列表](https://huggingface.co/thinkingmachines)
