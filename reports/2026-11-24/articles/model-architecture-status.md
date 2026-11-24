# 模型与架构：GLM‑5.4 把已有层再走一遍，KV 缓存要记住什么

北京时间 **11 月 23 日 18:27:11**，Z.ai 官方账号介绍 GLM‑5.4，称它是团队首个 Loop Transformer：复用 GLM‑5 基座中已有的层做更深的计算，并加入视觉能力，面向视频、游戏、3D 着色器和 CAD 等编码场景。这个时间来自官方帖子，落在北京时间 11 月 23 日 06:20 至 24 日 06:20 的主窗内。技术博客的上线时刻尚未取得。[官方公告帖](https://x.com/Zai_org/status/2124811995912286352) · [Z.ai 技术文章](https://z.ai/blog/glm-5.4)

## 28 层 × 2 为什么影响缓存

官方技术文章将循环部分描述为 **28 层 × 2**。第二遍复用第一遍的稀疏注意力索引，读取第一遍按该索引选出的 KV，同时保留第二遍在滑动窗口内新生成的 KV。只有窗口内的位置才可能同时有两种表示。例如，第 100 个 token 若仍在窗口内，又被第一遍的稀疏注意力选中，第二遍就可以读到对应这个位置的两种 KV。实际怎样分配和存放这些缓存，以及本地推理需要多少显存，仍待实现与测量确认。[官方技术文章](https://z.ai/blog/glm-5.4)

![当第 100 个 token 仍在滑动窗口内且被第一遍选中时，第二遍可同时读取第一遍选中的 KV 与第二遍窗口内的新 KV。](assets/glm-loop-kv.png)

接入推理引擎时，可以先用短序列核对预填充和逐步解码在两遍计算中各自读取的缓存，再测长序列下的状态占用。跨服务的权重共享是另一个问题：同一模型内部复用层参数，并不能证明两个服务进程已经共享权重或 KV。现有材料尚不足以给出本地引擎适配、GPU 隔离、多租户显存峰值或吞吐的实测结论。[官方技术文章](https://z.ai/blog/glm-5.4)

## 托管入口、通用 API 和本地权重

| 使用方式 | 已核实的范围 |
| --- | --- |
| 托管入口 | ZCode FAQ 列出 Lite、Pro、Max 和 Team，并说明其产品范围内的 1M 上下文。 |
| 通用开发者 API | 官方帖子称将在安全评估后开放。现有材料没有给出通用 API 的可用模型 ID、开放时间或额度。 |
| 本地权重 | 官方表示计划开放权重。本次读取的 zai-org Hugging Face 目录有 154 项，其中没有 GLM‑5.4 同名条目，尚无固定权重修订、分片和许可可供部署核验。 |

在托管入口测试自己的工作负载是当前可做的验证。评估本地超配则仍需取得权重和运行实现，先核正确性，再在明确的硬件、上下文与并发条件下量显存、延迟和吞吐。FAQ 的 1M 说明不能代替这些测量。[ZCode FAQ](https://zcode.z.ai/en/docs/qa) · [官方公告帖](https://x.com/Zai_org/status/2124811995912286352) · [zai-org 模型目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)

## 这次查到了哪些发布渠道

智谱的官方账号公告、技术文章和 ZCode FAQ 分别支撑发布时间、循环机制和托管范围。智谱研究时间线、API 发布说明和 ModelScope 入口在取件时连接中断。模型目录的 154 项只能说明这次在 Hugging Face 看到了什么。[官方账号](https://x.com/Zai_org) · [官方模型目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)

在 DeepSeek 的 106 项和 Qwen 的 469 项 Hugging Face 目录记录中，未见本次 24 小时窗口内创建或修改的条目。DeepSeek 新闻和 Qwen 英文文章入口连接中断，其他项目发布与权重渠道也未查全，因此这两个目录不足以判断两家当天的全部发布。[DeepSeek 模型目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [Qwen 模型目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)
