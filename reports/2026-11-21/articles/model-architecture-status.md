# 模型与架构：Inkling 2 Mini 三轮共用权重，为什么仍要分开存状态

如果同一组层会执行三次，推理服务究竟该加载几份权重，又该分配几份缓存？Thinking Machines 于 11 月 20 日发布多模态 MoE 模型 Inkling 2 Mini，开放 Apache-2.0 权重。Hugging Face 的 `upload model` 提交 `1fb4134b` 记于 22:02:14 UTC，这是本期截止前的固定版本。vLLM 文章自署当日 09:00 UTC，文章源码于 20:18:15 UTC 提交。三者分别记录作者标注时间、源码提交和权重上传。22:55:20 的后续提交仅在配置顶层补写 `dtype`，已在窗口之外。[固定模型卡](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/README.md) · [权重提交史](https://huggingface.co/api/models/thinkingmachines/Inkling-2-Mini/commits/main) · [固定技术文章](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/c29cac02828531bb410100ca4e4b92acd0006080/_posts/2026-11-20-inkling2-mini.md) · [文章提交史](https://api.github.com/repos/vllm-project/vllm-project.github.io/commits?path=_posts%2F2026-11-20-inkling2-mini.md&per_page=5)

## 24 个物理层承担 48 次层计算

模型卡给出 26.4B 总参数和 3.4B 激活参数；将循环中重复使用的权重也计入，每个 token 对应 5.4B 的有效权重激活量。按配置的零基编号，第 6–17 层构成循环核心，执行三遍。每一遍都从前段输出出发，通过门控消息获得前一遍的信息。三遍共用中间层权重，但各自保留 KV 和卷积状态。vLLM 将额外轮次登记成单独的缓存层，使前缀缓存可以按各轮追踪状态。全模型有 24 个注意力头、8 个 KV 头，混合滑窗、全注意力与短卷积；容量估算需要逐类核算。[截止前配置](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/config.json) · [循环与缓存实现](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/c29cac02828531bb410100ca4e4b92acd0006080/_posts/2026-11-20-inkling2-mini.md)

![固定版中间 12 层执行三轮。三轮读取同一套核心权重，各自保留 KV 与卷积状态；可选共享 KV 属于另一研究检查点。](assets/inkling-state.png)

## vLLM 能启动哪种配置

vLLM #69039 于 11 月 20 日合入 main（`b13eb01d`）。单张 GB200、TP1、DSpark 启动记录将最大序列长度设为 1,048,576，报告 156 GiB 可用 KV 空间和 1,898,616 token 的总缓存容量。长上下文 needle 正确性评测的 **550/550** 使用 **TP4**。两份证据分别回答“服务能否按此上限启动”和“该并行配置能否完成这组测试”。H100 80 GB 在这份配方中仍为 262,144 上限；H200 141 GB 虽列入配方适用范围，材料未给它单独的同负载实测。[启动与正确性测试](https://api.github.com/repos/vllm-project/vllm/pulls/69039) · [配方差异](https://api.github.com/repos/vllm-project/vllm/pulls/69039/files?per_page=100)

模型卡列有 SGLang 支持入口；本期取得的 SGLang 博文讨论的是另一个模型 Inkling 2 Small，缺少可归到固定 Mini 版本的独立实现测量。DeepInfer 的本窗代码和官方技术索引也没有给出该检查点的支持证据。部署可先用固定 revision 和精度确认设备分配与隔离，再分别核实同模型多进程的权重映射、每实例各轮缓存的生命周期和回收；最后在同卡双实例上测显存峰值、输出一致性及 P99。当前证据只覆盖模型内部循环复用权重，跨进程共享和受管缓存都需另行验证。[模型卡的软件支持](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/README.md) · [SGLang 博客目录](https://www.sglang.io/blog) · [DeepSeek Open Infra 索引](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/HEAD/README.md)

智谱、DeepSeek、Qwen 的官方 Hugging Face 目录和发布材料已核对。Qwen 本窗出现的五个 README 修订指向既有仓库；已查材料未证实三家在 30–80B 或 200–500B 总参档有新模型发布。三家的 ModelScope 官方分发清单尚未查全。[智谱目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [DeepSeek 目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt) · [Qwen 目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=1000&sort=createdAt)
