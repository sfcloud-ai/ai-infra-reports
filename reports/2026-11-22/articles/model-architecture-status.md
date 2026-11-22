# 模型与架构：Inkling 2 Mini 合入 vLLM，三遍循环各存一份状态

上期记录了 Inkling 2 Mini 的固定版检查点。北京时间 11 月 22 日，vLLM 主线合入 #69028，加入这款循环 MoE 模型的实现。部署时，模型权重和各遍计算留下的运行状态要分别计入显存。[上游合并及复核](https://api.github.com/repos/vllm-project/vllm/pulls/69028) · [此前固定版本的模型卡](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/README.md)

## 为什么要保存三遍状态

固定版 Mini 的每个 token 都要经过同一组核心层三遍。三遍共享核心权重。从第二遍开始，门控会把上一遍的消息带进当前计算。各遍的注意力历史和卷积状态要分别保存。vLLM 把每遍的注意力缓存表示为额外缓存层，沿用现有 KV 管理和前缀缓存。[循环、状态和缓存的实现](https://api.github.com/repos/vllm-project/vllm/pulls/69028/files?per_page=100)

![固定版 Mini 共享核心权重，各遍分别写入 KV 与卷积状态](assets/inkling-state.png)

## 部署时怎样确认支持

本期查到的稳定版发布早于此次合入。使用固定版 Mini 前，可先检查部署版本是否包含这次模型适配。相关的 GB10 矩阵乘微内核优化记录在另一个 PR 中。[上游合并及复核](https://api.github.com/repos/vllm-project/vllm/pulls/69028) · [稳定版记录](https://api.github.com/repos/vllm-project/vllm/releases/latest) · [GB10 后续优化](https://api.github.com/repos/vllm-project/vllm/pulls/69021)

本期查过智谱、DeepSeek 和 Qwen 的 ModelScope 组织清单。智谱博客返回 404。已读官网研究目录和更新记录未覆盖全部文章，架构方向保留这一缺口。[智谱研究目录](https://www.zhipuai.cn/zh/research) · [官方更新记录](https://docs.z.ai/release-notes/new-released.md)
