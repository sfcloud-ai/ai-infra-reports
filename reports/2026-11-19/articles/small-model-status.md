11 月 18 日，Reson8 在 Hugging Face 公布 Rumble-2-Flash 的 Apache-2.0 开放权重。公告原稿在 14:39 UTC 合入，位于本期窗口。这次可取得权重和模型卡，团队也提供托管 API。两条使用路径的计费和性能要分别评估。

这款约 5 亿参数的语音识别模型采用 Qwen3-ASR 架构，可用 Transformers 或 vLLM 运行。训练时，学生先自行转写音频，较大的教师模型再逐词元提供反馈；GOLD 对齐两种分词器划分不同的文本片段。0.5B 是发布方标注的模型参数规模。

在模型卡的 Open ASR Leaderboard v1.16.1 测试中，H200 上的 vLLM 英语赛道平均词错误率为 6.60%。作者另报九种语言的平均错误率为 6.96%，其中中文按字符计算。满批量的大数据集上，作者报告的吞吐超过 7,000 倍实时；单条语音的等待、解码延时和端侧内存需要按目标设备另测。对呼叫中心场景，可对照同一套 AppTek 评分脚本：302 小时、14 种英语口音的录音中，该模型的词错误率为 7.86%，Qwen3-ASR 0.6B 为 8.70%。

## 其他来源的检查范围

本期检查从 **11 月 17 日 22:20 到 11 月 18 日 22:20（UTC）**。本页列出三份模型目录的最近活动，以及两项按提交时间过滤的论文查询。arXiv 在这段时间内公告的论文可以更早提交，其公告清单仍待核实。

| 公开模型入口 | 本次读取范围 | 返回首项的记录和最后修改日（UTC） |
| --- | --- | --- |
| Google 的 Gemma 匹配项 | 按最后修改时间倒序，最多 10 项，实得 10 项 | gemma-4-E4B-it，11 月 3 日 |
| HuggingFaceTB 的模型 | 同一排序，实得 10 项 | SmolVLM-500M-Instruct，11 月 13 日 |
| Microsoft 的 Phi 匹配项 | 同一排序，实得 10 项 | Phi-4-reasoning-vision-15B，8 月 31 日 |

三个列表各自最近的修改都早于窗口起点。仓库的最后修改时间只能定位这条记录的活动，不能用作模型首发时间。列表还受组织、关键词与返回条数限制。

论文方面，第一项在同一 UTC 提交窗口内，以标题匹配小语言模型、小视觉语言模型、端侧或紧凑语言模型等英文短语。第二项在 cs.CL 或 cs.LG 的摘要里匹配小模型、端侧、sub-billion 等词。两项都限定最多返回 8 条，原始响应各自给出的总结果数均为 0。换用不同词汇、分类、发布时间或预印本渠道，得到的是另一项检索。

## 原始来源

- [Reson8 的开放权重公告与评测](https://huggingface.co/blog/rumble-2-flash)
- [公告原稿及合入时间](https://github.com/huggingface/blog/pull/3608)
- [模型卡、运行方式与 H200 评测表](https://huggingface.co/Reson8/Rumble-2-Flash)

- [Google Gemma 公开模型列表及精确过滤条件](https://huggingface.co/api/models?author=google&direction=-1&limit=10&search=gemma&sort=lastModified)
- [HuggingFaceTB 公开模型列表](https://huggingface.co/api/models?author=HuggingFaceTB&direction=-1&limit=10&sort=lastModified)
- [Microsoft Phi 公开模型列表及精确过滤条件](https://huggingface.co/api/models?author=microsoft&direction=-1&limit=10&search=phi&sort=lastModified)
- [arXiv 标题查询及 UTC 提交窗口](https://export.arxiv.org/api/query?max_results=8&search_query=%28ti%3A%22small+language+model%22+OR+ti%3A%22small+vision+language+model%22+OR+ti%3A%22on-device+language+model%22+OR+ti%3A%22compact+language+model%22%29+AND+submittedDate%3A%5B202611172220+TO+202611182220%5D&sortBy=submittedDate&sortOrder=descending&start=0)
- [arXiv 类别、摘要和提交日期查询](https://export.arxiv.org/api/query?max_results=8&search_query=%28cat%3Acs.CL+OR+cat%3Acs.LG%29+AND+%28abs%3A%22small+language+models%22+OR+abs%3A%22small+language+model%22+OR+abs%3A%22on-device+language+model%22+OR+abs%3A%22sub-billion%22+OR+abs%3A%22compact+language+model%22%29+AND+submittedDate%3A%5B202611172220+TO+202611182220%5D&sortBy=submittedDate&sortOrder=descending&start=0)
