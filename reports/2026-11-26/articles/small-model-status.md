# 前沿小模型：四个官方目录均未见本期修改的模型记录

北京时间 11 月 25 日 06:20 至 26 日 06:20，所查四个 Hugging Face 官方目录页都没有修改时间落入窗口的记录。判断依据是接口返回的排序和时间边界：四页均按 `lastModified` 递减，已越过窗口下界或抵达列表末尾。下面保留各自的查询范围和最新日期，便于核对。

| 官方账户与检索范围 | 本页条数 | 本页最新修改日期（UTC） |
| --- | ---: | --- |
| HuggingFaceTB 账户 | 84 | 11 月 13 日 |
| Microsoft 账户，检索 Phi | 51 | 8 月 31 日 |
| Google 账户，检索 Gemma | 100 | 11 月 3 日 |
| Qwen 账户 | 100 | 11 月 20 日 |

HuggingFaceTB 页首的 SmolVLM-500M-Instruct 和 SmolVLM-256M-Instruct 都在 11 月 13 日修改；Qwen 页首的 Qwen2-VL-2B-Instruct 则在 11 月 20 日修改。它们说明目录里确实有小模型，也说明为什么这些已有型号没有被列为本期新事件。[HuggingFaceTB 官方返回](https://huggingface.co/api/models?author=HuggingFaceTB&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [Qwen 官方返回](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)

Microsoft 与 Google 的两项检索分别限定于 Phi 和 Gemma，另外两个账户也只覆盖已读取的官方目录。目录修改日期不能确定首次开放下载的时间，亦不提供精度、延迟或显存数据。本期材料不足以得出新权重发布或同等质量下服务成本下降的结论。[Microsoft 的 Phi 查询](https://huggingface.co/api/models?author=microsoft&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&search=Phi&sort=lastModified) · [Google 的 Gemma 查询](https://huggingface.co/api/models?author=google&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&search=gemma&sort=lastModified)
