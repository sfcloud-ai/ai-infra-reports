本篇把 **vLLM、SGLang、DeepInfer** 放在同一个入口。代码以 **11 月 15 日 07:20 北京时间**为截点；博客与代码分别检查，已报道的 EPD、统一内存、Inkling 等内容没有再次计为新进展。

### vLLM：纯 TP 的两个微批交叠通信和计算

**11 月 14 日 19:22 UTC** 合入的 #63483（`5e51c0ca1041168de7aa9e096982aebaeebabd38`）面向 **MRV2、单 DP rank、无 EP 的 TP** 路径。两个微批各有通信器，TP all-reduce 在通信 stream 执行，并让出执行机会给另一个微批的计算。

拆分步骤使用 eager，视觉编码器在拆分之外；MRV1 明确拒绝该模式。它解决通信等待的重叠机会，代价包括拆分路径失去 CUDA Graph，不能默认所有模型与 LoRA/PP 配置都适用。

PR 在携带该修改的 **M3 serving 分支、MI355X TP4、MXFP4、3600 秒 agentic trace** 上给出一组结果：并发 64 时，总 tokens/s/GPU 从 **53,692 到 59,281**，P90 交互速度从 **23.6 到 30.8 tok/s/user**。总 token **包含输入**，不能称输出吞吐；并发 32 的吞吐略降，说明收益取决于负载。这不是 H100/H200 实测，也不是纯主线所有配置的保证。

部署前应先用 profiler 判断通信占比，在相同并发、输入输出分布和延迟要求下比较，再决定是否接受 eager 路径的代价。

### SGLang：把 Qwen-VL 预处理临时显存分块

**11 月 14 日 12:43 UTC** 合入 #50007（`6932682eb2ea859a468f5e50377e9d8ed774eef9`）。估算为**源像素 × 18B + 目标像素 × 24B**，按 512MiB 预算分块，输出转 CPU 后合并；单图超预算或块 OOM 时用 CPU，空闲缓存超过 1GiB 时释放。

在 **RTX A6000 48GB、Transformers 5.19、torch 2.14、随机 RGB 输入**上，48 张 3024×4032 图片的单次预处理峰值从 **10,577MiB 降到 442MiB**，并以 `torch.equal` 检查输出一致。**512MiB 是估算预算，不是严格峰值上限**：48 张 4000×6000 的结果为 642MiB。

未缓存路径只新增 OOM 后 CPU 回退，未分块，原峰值没有下降。变化针对图像突发产生的临时峰值，不是 KV 容量扩大；H100/H800 没有同条件结果，也没有端到端在线延迟保证。验证时应同时测预处理峰值、CPU 回退频率与整请求尾延迟。

### DeepInfer：限定已检查的范围

本期读取七日默认分支提交查询、release 列表及官方技术入口：前两项返回空列表，open-infra-index 对应已读内容仍为旧资料。这支持“本次已检查范围没有新增合格项”，不能扩大为所有分支、所有渠道都没有进展。DeepInfer 与 FlashInfer 是不同项目。

vLLM、SGLang 博客列表及相关全文均已另行读取。与既往相同事件的文章按历史去重，SWE agent 沙箱内容没有冒充制造业机器人训练成果；代码有更新不替代博客检查，博客有文章也不自动构成本期新事件。

原始来源：[原始来源 1](https://api.github.com/repos/vllm-project/vllm/pulls/63483)；[原始来源 2](https://api.github.com/repos/vllm-project/vllm/commits/5e51c0ca1041168de7aa9e096982aebaeebabd38)；[原始来源 1](https://api.github.com/repos/sgl-project/sglang/pulls/50007)；[原始来源 2](https://api.github.com/repos/sgl-project/sglang/commits/6932682eb2ea859a468f5e50377e9d8ed774eef9)。

DeepInfer 实际核查来源：[核查入口 1](https://raw.githubusercontent.com/deepseek-ai/open-infra-index/main/README.md)；[核查入口 2](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?per_page=100&since=2026-11-07T23%3A20%3A00Z)；[核查入口 3](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?per_page=5)。
