# 模型与架构：DeepSeek 定宽验证如何复用一块 K

DeepSeek-V4.1-Flash 做固定宽度的目标模型验证时，同一请求里，相邻查询行可能读取同一块 K。逐行加载和解包会重复做工。SGLang #49068 将解包后的 BF16 K 分块留给本请求组的多行查询使用。每一行仍遵守自己的因果范围，舍入顺序也保留。宽度不齐或带屏蔽的情形走原路径。这里复用的是验证内核的临时分块，不能由此推出长期 KV 占用下降。11 月 19 日改动合入 main（`e4353c97`），BF16 K 复用默认关闭。[SGLang #49068](https://api.github.com/repos/sgl-project/sglang/pulls/49068) · [四个文件的改动](https://api.github.com/repos/sgl-project/sglang/pulls/49068/files?page=1&per_page=100)

## 同一批请求里，首 token 和后续 token 走向相反

实验取自分支 `91afc4f`。同机 8 张 H20-3e，预填充和解码各用 4 张；DSpark 块大小 5、预填充分块 8,192、并发 24。两组均完成 256 个请求，每个请求包含 61,440 个共享前缀 token、4,096 个请求专属 token，并输出 500 个 token。对照同时将 `K_REUSE` 和 `BF16_K_REUSE` 两个开关从 0 改为 1。[实验分支、启动参数及 A/B 表](https://api.github.com/repos/sgl-project/sglang/pulls/49068)

| 同一 A/B 的平均量 | 基线 | 同开两项 |
| --- | ---: | ---: |
| 首 token 等待（TTFT） | 1,812.87 ms | 2,009.64 ms |
| 每个后续输出 token 耗时（TPOT） | 5.91 ms | 5.40 ms |
| 端到端时延 | 4,760.91 ms | 4,705.99 ms |

首 token 等待增加 10.85%，TPOT 降低 8.54%，输出吞吐仅增加 0.63%。有首响约束的交互服务，应先看第一行；长输出任务还要结合后两行。复现单项贡献，需要在同一提交、拓扑和负载上分别切换两个开关，另测尾延迟。该对照既没有测多租户显存，也不能代替整套预填充/解码分离优化的效果。[原始指标与开关](https://api.github.com/repos/sgl-project/sglang/pulls/49068)

## 模型发布渠道的覆盖范围

截至北京时间 11 月 20 日 06:20 的 24 小时，智谱、DeepSeek、Qwen 的 Hugging Face 官方作者目录分别读到 154、106、469 项，其中均未见窗口内创建或最后修改的记录。Qwen 官方英文目录返回 41 个不同文章路径，最新可见 Qwen4-Max 署期 11 月 16 日。三家的 ModelScope 分发记录没有查全，不能从这些目录推出所有渠道均无新发布。LMSYS 的 H20-3e 文章缺少权威的精确首发时点，Humming 文章缺完整正文；本页的性能数据取自已合入的 SGLang PR。[智谱模型目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [DeepSeek 模型目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [Qwen 模型目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [Qwen 官方英文文章目录数据](https://qwen.ai/api/v2/article/retrieval?language=en-US&type=qwen_ai) · [LMSYS 的 H20-3e 文章](https://www.lmsys.org/blog/2026-11-19-deepseek-v41-h20/)
