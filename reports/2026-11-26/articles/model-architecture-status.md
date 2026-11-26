# 模型与架构：GLM-5.3-Flash 的长提示何时走新的 KDA 卷积

同一批请求里，可能既有正在读取长提示的请求，也有只需生成下一个 token 的请求。11 月 26 日 05:46 合入的 vLLM #66884 为 GLM-5.3-Flash 的 KDA 短卷积增加了 Triton 路径。它将查询、键、值分别写入连续平面，保留既有卷积状态的读写约定。SM10x 上的分块预填充可以选用新实现，普通解码和推测解码沿用原实现。[vLLM #66884](https://github.com/vllm-project/vllm/pull/66884) · [内核与分流条件](https://patch-diff.githubusercontent.com/raw/vllm-project/vllm/pull/66884.diff)

## 长提示和混合批为什么要分别量

调度器在每一步参考本地头数、预填充 token 数和解码行数。预填充块较短或解码行较多时，旧卷积仍有优势。作者在 GB300 上做了端到端对照：4K、8K 输入在 TP1 时，平均首 token 时延比旧路径低 2.5% 至 4.5%；同样两种输入在 TP4 时，平均首 token 时延与旧路径相差在 1% 内。评估线上收益时，需要保留真实批次中长提示与解码请求的比例。[按并行度列出的 GB300 测量](https://github.com/vllm-project/vllm/pull/66884)

正确性测试要求新旧实现产生逐位相同的卷积状态，输出允许相差一个 BF16 的末位单位。这个约束对接手同一请求后续步骤很重要。它没有验证外部 KV 管理器、CUDA Graph 或跨实例权重共享。若用于同卡多实例部署，仍需逐实例核算卷积状态、请求缓存及工作区，并在目标硬件验证容量和隔离。[状态和输出的校验条件](https://github.com/vllm-project/vllm/pull/66884)

## 权重目录与技术公告的覆盖

GLM、DeepSeek、Qwen 的 Hugging Face 官方目录各读到按修改时间倒序的首页 100 项；各页最新记录分别为 10 月 15 日、11 月 10 日和 11 月 20 日，均早于本期窗口。GLM 和 Qwen 博客、DeepSeek 文章入口及 Z.ai 更新记录出现连接重置，另一处智谱研究页尚未读取。现有证据支持上述引擎变更，不能据此判定三个厂商的所有渠道均无新发布。[GLM 目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [DeepSeek 目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [Qwen 目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)
