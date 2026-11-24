# 前沿小模型：2.35B 的 Audar 在 RTX 3080 跑通转写，英语片段仍需单独测

部署语音模型要先回答两个问题：服务能否加载现有权重，以及它能否按要求转写。北京时间 11 月 23 日 23:01，vLLM 合入 #69226，修复 Audar-ASR-V1-Turbo 所用的一种旧配置写法。作者模型库可定位到同一 BF16 快照 `371428bea4`，仓库记录的最近修改日期为 8 月 20 日。本期的变化是引擎兼容性。[合入 PR](https://github.com/vllm-project/vllm/pull/69226) · [作者的固定模型版本](https://huggingface.co/api/models/audarai/Audar-ASR-V1-Turbo/revision/371428bea487c7aec82b27dc21f8d4324002e98e?blobs=true)

固定模型卡列出音频编码器约 0.32B、语言模型解码器约 2.03B，总计 2,349,217,408 个参数。根目录 BF16 权重文件为 4,698,521,568 字节（约 4.38 GiB）。这是文件大小，推理还要为激活值和运行状态留出显存。[固定模型卡](https://huggingface.co/audarai/Audar-ASR-V1-Turbo/raw/371428bea487c7aec82b27dc21f8d4324002e98e/README.md) · [固定权重清单](https://huggingface.co/api/models/audarai/Audar-ASR-V1-Turbo/revision/371428bea487c7aec82b27dc21f8d4324002e98e?blobs=true)

旧快照在语音模型的文本子配置使用 `qwen3_asr_text`，原生加载器无法识别。修复在原始嵌套 Qwen3‑ASR 配置分支中，统一将文本子配置的 `model_type` 写为 `qwen3`。PR 作者在同一张 RTX 3080 上用相同的 vLLM 命令和参数测试，双方均未启用模型仓库自带的执行代码。基线在初始化时报告子配置类型未知；应用补丁后，服务就绪，两次转写请求均返回 HTTP 200。[启动记录](https://github.com/vllm-project/vllm/pull/69226) · [代码和测试差异](https://patch-diff.githubusercontent.com/raw/vllm-project/vllm/pull/69226.diff) · [固定配置](https://huggingface.co/audarai/Audar-ASR-V1-Turbo/raw/371428bea487c7aec82b27dc21f8d4324002e98e/config.json)

一段公开英语音频指定 `language=en` 后仍返回阿拉伯语。这个样例足以说明语言行为值得复测，不能用两次 HTTP 200 来给转写质量打分。模型卡另报六个阿拉伯语 ASR 测试集的平均词错率（WER）23.17%、平均字符错率（CER）9.20%。这组榜单成绩与补丁作者在 RTX 3080 上的两次请求来自不同实验。在自己的音频和语言条件下，仍要分别核对词错率、实时率和峰值显存。[模型卡的评测范围](https://huggingface.co/audarai/Audar-ASR-V1-Turbo/raw/371428bea487c7aec82b27dc21f8d4324002e98e/README.md) [转写示例及限制](https://github.com/vllm-project/vllm/pull/69226)

本期另查了 HuggingFaceTB、Google Gemma 和 Microsoft Phi 的模型列表，每个入口取回 50 项，所查范围没有主窗内的创建或修改记录。[三个目录之一：HuggingFaceTB](https://huggingface.co/api/models?author=HuggingFaceTB&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&sort=lastModified)
