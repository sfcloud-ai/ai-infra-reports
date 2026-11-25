# 前沿小模型：约 16 亿参数的 OmniASR 接入 vLLM，单张 T4 跑通转写

如果用一张 T4 为短音频提供转写服务，先要确认模型、框架版本和注意力后端能否一起工作。北京时间 11 月 25 日 05:11:51 合入的 vLLM #69683 注册了已有模型 hf-audio/omniasr-llm-300m-v2，让引擎能自动选择 Transformers 多模态转写后端。本次进展是接入服务的路径；既有模型的识别质量仍要参照对应语言和数据集评估。

## 型号里的 300M 如何与整款模型对上

名称里的 300M 容易引起容量误判。固定版本配置包含音频模型与 Llama 文本配置。模型卡将整款模型列为 1,627,603,584 个参数；同一修订的 Hub 权重元数据列出 1,638,453,760 个 F32 张量元素。两者都支持“约 16 亿”这一量级。现有证据未解释精确计数差额，估算资源时还要区分磁盘权重类型、加载时的精度和运行时缓存。[固定版本模型卡](https://huggingface.co/hf-audio/omniasr-llm-300m-v2/raw/5f8ae505a4872fdea051017b8d15ba35adefe353/README.md) · [模型权重元数据](https://huggingface.co/api/models/hf-audio/omniasr-llm-300m-v2?blobs=true)

## T4 上验证了什么

作者在单张 T4 上使用 vLLM nightly 0.34.1rc1.dev34+gd9586ca91 加注册改动，以及包含所需实现的 Transformers main（5.24.0.dev0）。运行取 half 精度、最大长度 4,096，FlexAttention 的 M/N 块分别为 8/16。一次发往语音转写接口的请求返回了可读英文句子，响应标注音频长 6 秒。这个 6 秒是输入时长，无法据此计算推理耗时或实时率。

测试注册列出的 Transformers 最低正式版本为 5.24.1，作者说明当时 CI 在依赖升级前会跳过此项。对短语音试用，已有一套可核对的单卡配置；评估生产资源和效果，还需要目标语言的词错率或字错率、成批音频的实时率，以及并发时显存的实测值。[vLLM #69683 的注册变更和 T4 转写样例](https://github.com/vllm-project/vllm/pull/69683)

## 同窗核对的 Qwen 小模型

Qwen 官方 Hugging Face 目录按最后修改时间降序排列，首批 100 项中有 Qwen/Qwen2-VL-2B-Instruct、Qwen/Qwen3Guard-Stream-0.6B、Qwen/Qwen3-ASR-0.6B-hf。三项的最后修改日期分别为 11 月 20 日、9 月 27 日和 7 月 22 日，均早于本期窗口。这三条记录用作已有型号背景，本期收录的小模型事件是上文的 OmniASR 转写接入。[Qwen 官方模型目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)
