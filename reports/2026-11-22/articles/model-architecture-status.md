# 模型与架构：Inkling 2 Mini 合入 vLLM，三遍循环各存一份状态

昨天的晨报记录了固定版 Inkling 2 Mini 检查点。11 月 21 日新增的是 vLLM 主线合并 #69028，涉及 54 个文件。此前记录的模型卡口径为总参数 26.4B、单遍激活 3.4B，计入循环后每 token 有效权重激活约 5.4B。约 20 GB 是混合 NVFP4/MXFP8 检查点文件大小，实际服务还要给运行状态留空间。[上游合并及复核](https://api.github.com/repos/vllm-project/vllm/pulls/69028) · [此前固定版本的模型卡](https://huggingface.co/thinkingmachines/Inkling-2-Mini/raw/1fb4134b9a74f9681054f4ef82e4bf1f458a2337/README.md)

## 为什么要保存三遍状态

每个 token 三次经过第 6–17 层。每遍从前段产生的注意力残差状态开始，后续遍通过门控读入上一遍的消息。核心计算可以共用参数，但一遍生成的注意力历史和卷积状态有自己的时间顺序。实现把各遍的注意力缓存呈现为额外的缓存层，复用引擎的 KV 管理和前缀缓存，再分别维护各遍卷积状态。固定三遍 Mini 与可调遍数的研究模型应分别核对，后者可以选择共享 KV 的配置，卷积状态仍要分遍。[循环、状态和缓存的实现](https://api.github.com/repos/vllm-project/vllm/pulls/69028/files?per_page=100)

![固定版 Mini 共享核心权重，各遍分别写入 KV 与卷积状态](assets/inkling-state.png)

在 GB200 上，作者用 TP1、DSpark、温度 0 做了 200 道 GSM8K 题，得到 97.0%，平均接受长度 3.58。先前实现是 97.5%，相差一道题。另一个 #69021 测的是 GB10 上 hidden 4608 的矩阵乘微内核，从 210 降到 141 微秒；Mini 的 hidden 是 2304，不能据此给 Mini 的整段服务标加速比。本期核到的 vLLM 最新稳定版 v0.34.0 发布早于此次合并。[GB200 复核](https://api.github.com/repos/vllm-project/vllm/pulls/69028) · [GB10 后续优化](https://api.github.com/repos/vllm-project/vllm/pulls/69021) · [稳定版记录](https://api.github.com/repos/vllm-project/vllm/releases/latest)

## 超配验证要检查什么

先确认资源分配器能识别目标设备与拓扑，再用固定检查点、量化打包和相同 rank 布局，比较单实例原生与受管分配器的输出、逐遍 KV 和卷积状态。前缀命中、扩缩回收和图重放都要覆盖。同模型双实例还要测共享权重的所有者退出后另一个实例能否继续，以及两租户混合长短请求时的峰值、吞吐和 P99。不同模型独立计算权重。现有 GB200 复核尚不能回答 H100、H200 的同卡双实例表现，Pro5500 的准确型号也待核实。[原生缓存与设备适配范围](https://api.github.com/repos/vllm-project/vllm/pulls/69028/files?per_page=100)

本期已核对智谱、DeepSeek、Qwen 在 ModelScope 的组织清单，按更新时间倒序检查到七天下界。智谱博客返回 404，已读官网研究目录和更新记录不足以覆盖全部文章，因此保留架构方向缺口。[智谱研究目录](https://www.zhipuai.cn/zh/research) · [官方更新记录](https://docs.z.ai/release-notes/new-released.md)
