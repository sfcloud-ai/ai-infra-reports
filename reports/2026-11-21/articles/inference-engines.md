# 推理引擎每日变动：视频扩散推理何时才该写入历史 KV

本窗的引擎变动涉及三种寿命不同的数据：vLLM 的同模型只读表、循环模型各轮的状态，以及 SGLang 单次视频生成请求里的临时和历史 KV。部署前先确认对象由谁持有、何时写入、何时释放。

## vLLM

#67539 将 Engram 表按行分散在一个引擎组内；同组预填充与解码会争用网卡，实测和隔离边界见模型服务页。#69039 调整固定 Inkling 2 Mini 的长上下文配方，TP1 单卡启动与 TP4 检索正确性见架构页。两项均合入 main。官方仓库窗口内按编号去重的已合入 PR 有 122 条，默认分支提交有 122 条；最新可见稳定版 v0.34.0 发布于 11 月 16 日，早于这两次合入。vLLM 的 Mini 技术文章与同一模型归档。[Engram PR](https://api.github.com/repos/vllm-project/vllm/pulls/67539) · [长上下文配方](https://api.github.com/repos/vllm-project/vllm/pulls/69039) · [稳定版](https://api.github.com/repos/vllm-project/vllm/releases/latest) · [技术文章](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/c29cac02828531bb410100ca4e4b92acd0006080/_posts/2026-11-20-inkling2-mini.md)

## SGLang

生成双臂操作仿真视频时，同一帧会经历多步去噪。若每步都把文本、历史和本帧的 KV 重新拼接，就会反复分配临时张量。#47889 于 11 月 20 日合入 main（`7e9028a4`），让 Cosmos3 Nano Sim-Bimanual 在**同一请求内**按层复用缓冲，只有完成去噪的帧才写入历史。完整历史模式预分配容量并检查上限；滑窗模式保留开头的锚点和近期帧，36 层轮用一份单层临时缓冲，本实验占 48.125 MiB，并用逐层 CUDA event 协调移动顺序。[SGLang #47889](https://api.github.com/repos/sgl-project/sglang/pulls/47889) · [缓冲和顺序控制的变更](https://api.github.com/repos/sgl-project/sglang/pulls/47889/files?per_page=100)

| 历史模式 | 完整生成时间，旧 → 新 | 峰值已分配显存，旧 → 新 |
| --- | --- | --- |
| 完整历史，上限 901 帧 | 52.266 → 42.886 秒 | 43.346 → 37.631 GiB |
| 64 帧滑窗、8 个锚点 | 39.785 → 36.471 秒 | 33.460 → 32.694 GiB |

测试用一张 RTX PRO 6000 Blackwell Server Edition，生成 640×352、30 FPS 的 901 帧视频，BF16、四步采样。两边均用 NVENC，时间含 MP4 编码和写盘；峰值指 PyTorch 已分配显存，不含分配器保留的空闲缓存。每种配置使用新进程，完整热身一次，目标请求实测一次。两种历史模式的 BF16 潜变量和全部 901 帧解码 RGB 均与各自旧实现逐位相同。要用于其他分辨率或多路仿真，应重测缓存容量和编码占比。这次结果没有衡量实机双臂任务成功率。[对照条件、精度与速度表](https://api.github.com/repos/sgl-project/sglang/pulls/47889)

SGLang 本窗已合入 PR 118 条、默认分支提交 111 条。最新可见稳定版 v0.5.23 发布于 11 月 2 日；官方博客目录最新可见文章署 11 月 12 日。另核 LMSYS 的 H20-3e 文章，同篇站点提交在本窗下界之前，本窗未核实到新的技术内容。[稳定版](https://api.github.com/repos/sgl-project/sglang/releases/latest) · [SGLang 博客](https://www.sglang.io/blog) · [LMSYS 站点提交史](https://api.github.com/repos/lm-sys/lm-sys.github.io/commits?per_page=100&since=2026-11-18T00%3A00%3A00Z&until=2026-11-19T22%3A46%3A00Z)

## DeepInfer

窗口内的全仓已合入 PR 和默认分支提交流均读至末页，各返回零项；官方 releases 列表也为空。Open Infra 技术索引已读，部分旧条目只给出年月，已读内容中没有可定为本窗的新文章。前一期 nv-dev 的 #291 和 #294 仍归前一期，本日没有另计为发布。[合入 PR 查询](https://api.github.com/search/issues?order=desc&page=1&per_page=100&q=repo%3Adeepseek-ai%2FDeepInfer+is%3Apr+merged%3A2026-11-19T22%3A20%3A00Z..2026-11-20T22%3A20%3A00Z&sort=updated) · [默认分支提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100&since=2026-11-19T22%3A20%3A00Z&until=2026-11-20T22%3A20%3A00Z) · [发布清单](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?page=1&per_page=5) · [官方技术索引](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md)
