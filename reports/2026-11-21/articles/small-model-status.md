# 前沿小模型：为 20 GB 检查点做预算，还要算进什么

面向单机选模型时，下载包约 20 GB 能回答的是“磁盘上先要放下什么”。要判断服务是否值得上线，还需看目标任务成绩，再测相同输入长度和并发数下完整进程的内存与延迟。本页保留当窗小模型巡检，并用架构页已经收录的 Inkling 2 Mini 作为同一个部署案例。

## 本次查到哪些记录

窗口为北京时间 11 月 20 日 06:20 至 21 日 06:20。HuggingFaceTB 的 Smol 相关目录、Google 的 Gemma 目录、Microsoft 的 Phi 目录，都按最后修改时间读取前 50 项。三份返回集中的最新修改日期分别为 11 月 13 日、11 月 3 日和 8 月 31 日。另按提交时间、学科和“小型/端侧语言模型”等摘要词检索 arXiv，返回零项。这一结论限于上述返回集和查询条件。[Smol 目录](https://huggingface.co/api/models?author=HuggingFaceTB&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&sort=lastModified) · [Gemma 目录](https://huggingface.co/api/models?author=google&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&search=gemma&sort=lastModified) · [Phi 目录](https://huggingface.co/api/models?author=microsoft&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&search=Phi&sort=lastModified) · [论文检索条件](https://export.arxiv.org/api/query?max_results=15&search_query=%28%28cat%3Acs.CL+OR+cat%3Acs.LG+OR+cat%3Acs.CV%29+AND+%28abs%3A%22small+language+model%22+OR+abs%3A%22small+language+models%22+OR+abs%3A%22on-device+language%22+OR+abs%3A%22compact+language+model%22+OR+abs%3A%22sub-billion%22%29%29+AND+submittedDate%3A%5B202611192220+TO+202611202220%5D&sortBy=submittedDate&sortOrder=descending&start=0)

## 质量分数与吞吐上界各有分母

发布方列出 Mini 的 DeepSWE v1.1 **48.2%**、Vals Index v2.2 **46.5%**。选型时应保留任务、工具和评测环境，再与同设置基线比较。发布方性能图中用到的 614 GB/s、BF16、batch 1 是估算带宽上界的假设。固定检查点的路由专家权重按层采用两种精度：第 0–19 层的路由专家权重使用 NVFP4，第 20–23 层的路由专家权重使用 MXFP8。整个检查点的分发文件约 20 GB。文件大小、理论速度和实测服务吞吐不能互换。[发布公告与理论带宽图注](https://thinkingmachines.ai/news/inkling-2-mini/) · [发布方评测资料](https://thinkingmachines.ai/model-card/inkling-2-mini/) · [固定版本模型卡](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/README.md) · [精度与实现说明](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/c29cac02828531bb410100ca4e4b92acd0006080/_posts/2026-11-20-inkling2-mini.md)

## 哪张表可以用来估算缓存

vLLM 在**独立的可变循环研究检查点**上做过一次受控对照：一张 GB200、TP1、4K 上下文、只测前向。三轮时，独立 KV 与共享 KV 的容量分别是 175K 和 194K token，batch 1 的解码步分别为 3.85 和 3.86 ms。共享 KV 后各轮卷积状态仍然独立。架构页的正式固定版拒绝这个共享开关。拿固定版做部署预算，应从权重、视觉编码、每实例 KV 和卷积状态、工作区以及启用时的草稿模型逐项实测；再用自己的任务对照质量、首 token 等待和 P99。原材料没有固定版双租户的在线成本实测。[研究检查点的 A/B 表](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/c29cac02828531bb410100ca4e4b92acd0006080/_posts/2026-11-20-inkling2-mini.md) · [正式版配置](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/config.json)
