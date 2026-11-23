# 制造业具身智能训练：LeRobot 如何对齐机器人与策略的关节顺序

**72 小时回溯。** 北京时间 11 月 21 日 02:59:07，LeRobot 将 #5446 合入主线。作者举出的需求来自 SONIC G1：机器人提供的关节次序可能不同于策略输入的次序。处理器为指定观测和动作沿最后一轴取索引，并同步更新特征形状。索引可以重排全部关节，也可从 29 项中选 15 项。[原始 PR](https://github.com/huggingface/lerobot/pull/5446) · [代码和测试差异](https://github.com/huggingface/lerobot/pull/5446/files)

归一化统计仍按机器人关节次序保存。以 SONIC G1 的完整置换为例，先按机器人顺序归一化输入，再重排给策略；策略输出经过逆置换恢复机器人顺序，然后反归一化。从 29 项中选取 15 项只保留被选的关节，单靠这 15 项无法还原其余 14 个关节。随附测试覆盖索引结果、特征形状及配置保存和读回。这个改动解决训练与执行接口之间的关节映射，材料没有给出重训质量、实机成功率或工厂实验。[处理步骤和测试](https://github.com/huggingface/lerobot/pull/5446/files)

### 主窗核查与论文覆盖

本期先核对了两条可能直接影响策略训练和复现的代码线。北京时间 11 月 22 日 06:20 至 23 日 06:20，NVIDIA Isaac-GR00T 和 Physical Intelligence openpi 的默认分支提交列表均为空。同期 LeRobot 全仓合并 PR 的检索也返回 0 项。这三个数字分别对应两条默认分支和一份合并 PR 列表。[LeRobot 合并 PR 列表](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Ahuggingface%2Flerobot+is%3Apr+merged%3A2026-11-21T22%3A20%3A00Z..2026-11-22T22%3A20%3A00Z&sort=updated) · [Isaac-GR00T 提交记录](https://api.github.com/repos/NVIDIA/Isaac-GR00T/commits?page=1&per_page=30&since=2026-11-21T22%3A20%3A00Z&until=2026-11-22T22%3A20%3A00Z) · [openpi 提交记录](https://api.github.com/repos/Physical-Intelligence/openpi/commits?page=1&per_page=30&since=2026-11-21T22%3A20%3A00Z&until=2026-11-22T22%3A20%3A00Z)

同一窗口的 arXiv 查询限定在 cs.RO 或 cs.LG，按提交时间筛选，并在摘要中匹配机器人操作、机器人策略、视觉语言动作或双臂操作等英文词组。接口成功响应，返回总数 0。其他关键词、项目或尚未进入这个检索范围的成果仍可能存在。[当期论文查询](https://export.arxiv.org/api/query?max_results=15&search_query=%28%28cat%3Acs.RO+OR+cat%3Acs.LG%29+AND+%28abs%3A%22robot+manipulation%22+OR+abs%3A%22robot+policy%22+OR+abs%3A%22vision-language-action%22+OR+abs%3A%22bimanual+manipulation%22%29%29+AND+submittedDate%3A%5B202611212220+TO+202611222220%5D&sortBy=submittedDate&sortOrder=descending&start=0)

同样的具身关键词扩大到 72 小时后，arXiv 返回 HTTP 429（Rate exceeded.），响应未给出 Retry-After，因而没有可报告的回溯篇数。24 小时的零结果适用于成功的限定查询，不能延伸为三天内没有论文。[72 小时具身论文查询](https://export.arxiv.org/api/query?max_results=15&search_query=%28%28cat%3Acs.RO+OR+cat%3Acs.LG%29+AND+%28abs%3A%22robot+manipulation%22+OR+abs%3A%22robot+policy%22+OR+abs%3A%22vision-language-action%22+OR+abs%3A%22bimanual+manipulation%22%29%29+AND+submittedDate%3A%5B202611192220+TO+202611222220%5D&sortBy=submittedDate&sortOrder=descending&start=0)

同期回溯还遇到两条已报事项。11 月 21 日已报道 #5420 的动作与 padding 掩码错行修复及 132 项 CPU 测试，11 月 22 日已报道 #5416 的 NAT VLA 策略。本轮未取得可单独报道的新增结果。[掩码修复](https://github.com/huggingface/lerobot/pull/5420) · [NAT VLA](https://github.com/huggingface/lerobot/pull/5416)
