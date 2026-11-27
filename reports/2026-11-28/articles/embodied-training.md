# 制造业具身智能训练：DemoFoundry 改变仿真轨迹的视觉观测后怎样验证

## 72 小时回看：同样的轨迹，不同的视觉观测

DemoFoundry v1 首发于北京时间 11 月 26 日 00:37:10，列入本期 72 小时回看。作者设置五种数据条件，每个任务、每种策略各做 30 次实机试验。只用 DemoFoundry 和只用原仿真数据时，每个任务均使用 50 条轨迹，两组仅视觉观测不同。[72 小时检索](https://export.arxiv.org/api/query?max_results=20&search_query=cat%3Acs.RO+AND+%28all%3A%22robot+learning%22+OR+all%3A%22robot+policy%22%29+AND+submittedDate%3A%5B202611242220+TO+202611272220%5D&sortBy=submittedDate&sortOrder=descending&start=0) · [论文 v1，第 4.3 节](https://arxiv.org/html/2611.34671v1)

作者报告，与只用原仿真数据相比，只用 DemoFoundry 时，Diffusion Policy 的平均成功率高 34.4 个百分点，π0.5 高 32.2 个百分点。附表 S6 在改变照明的设置下记录了 18/30 对 2/30。2/30 对应的是仿真加域随机化（Simulation + DR）。这些数据衡量实验室任务上的成功率，未给出产线节拍和长期运行结果。[实机实验与附录](https://arxiv.org/html/2611.34671v1)

## 24 小时主窗查到什么

限定 `cs.RO` 及 “robot learning” 或 “robot policy” 的 arXiv 查询，主窗返回零条。LeRobot 已关闭 PR 列表首页的 100 条里，#5513、#5509、#4462 在主窗内合入。本期核到了列表和作者说明，尚缺这三条的端到端训练证据。[主窗 arXiv 查询](https://export.arxiv.org/api/query?max_results=20&search_query=cat%3Acs.RO+AND+%28all%3A%22robot+learning%22+OR+all%3A%22robot+policy%22%29+AND+submittedDate%3A%5B202611262220+TO+202611272220%5D&sortBy=submittedDate&sortOrder=descending&start=0) · [LeRobot 原始列表](https://api.github.com/repos/huggingface/lerobot/pulls?direction=desc&page=1&per_page=100&sort=updated&state=closed)
