多轮对话会把上一轮回答的 token 带回下一轮。对于循环状态模型，可重用的内容包括处理到某个前缀时的状态。若最后一个带哈希的状态还停在提示附近，后续请求就要重算更多输出。vLLM #67053 于 11 月 18 日合入 main（`52767604`），调整了 Mamba align 在稀疏保留模式下处理解码边界的时机。

| 时点 | 状态的去向 |
| --- | --- |
| 解码跨过块边界 | align 已写出边界状态。管理器暂留最近一次跨界的那一块。 |
| 又跨过下一边界 | 上一块在未登记哈希的状态下释放；新边界接替其位置。 |
| 请求结束或因抢占而释放 | 只给最后保留且可登记的边界状态记录前缀哈希；再次遇到该前缀时才可能复用。 |

这一变化适用于 `prefix_cache_retention_interval=0` 或正间隔的稀疏设置。密集设置本已给每个解码边界登记哈希。以**每请求、每个 Mamba 组**为单位，稳态解码持块数由 1 变为 2；align 的容量规划原已为跨界时的源块和目标块预留两块。现有峰值规划相同，稳态实际占用却会改变。容量表里应把这两个量分开。

多模块 MTP 在边界附近结束时可能缺可登记的前视哈希；混合滑窗模型仍受自身可复用边界约束。这次调整也未把每次跨界状态接到外部卸载。要衡量收益，应固定模型、块大小、保留间隔及多轮提示，比较下一轮实际命中位置、重算 token 与首 token 延时。现有材料没有给出同机速度对照。

**官方目录覆盖到哪里。** Qwen 官方英文接口返回 41 篇有正文的独立文章，其中日期最晚的是北京时间 11 月 16 日 10:00，早于本期窗口。智谱中文研究目录和 Z.ai 发布记录均可读，可见记录包括 8 月 26 日的 GLM-5.3-Flash。两家的其他渠道仍可能有独立更新。

本轮还读取了 GLM、DeepSeek 和 Qwen 在 Hugging Face 的公开模型目录，查阅其返回的创建时间和最后修改时间。这些是会随仓库更新而变化的目录字段，不能单独证明权重首发日期。ModelScope 的记录未覆盖到截止时刻，无法据此判断三家同期的全部权重发布。

## 原始来源

- [vLLM #67053：最新设计、适用模式与内存边界](https://api.github.com/repos/vllm-project/vllm/pulls/67053)
- [状态管理和测试差异](https://api.github.com/repos/vllm-project/vllm/pulls/67053/files?page=1&per_page=12)
- [智谱官方研究目录](https://www.zhipuai.cn/zh/research)
- [Z.ai 模型发布记录](https://docs.z.ai/release-notes/new-released.md)
- [Qwen 官方英文文章目录及正文](https://qwen.ai/api/v2/article/retrieval?language=en-US&type=qwen_ai)
- [GLM 公开模型目录与创建、修改时间](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)
- [DeepSeek 公开模型目录与创建、修改时间](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)
- [Qwen 公开模型目录与创建、修改时间](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)
