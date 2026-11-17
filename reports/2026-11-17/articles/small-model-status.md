小模型是否容易部署，不能只看激活参数和一张榜单。总权重、上下文长度、卷积状态、注意力 KV 以及具体后端，都影响实际显存和延迟；模型本身具备的功能，也未必已经被引擎完整接入。

SGLang **11 月 16 日 11:33 UTC** 合入 **#46858**，提交 `47361c57be9f`，接入 LFM3 的文本、视觉、音频和 Omni 输入，**当前输出仅为文本**。这不是语音生成服务已经上线的证据。

### 两个模型的预算不能混算

完整官方模型卡给出：**LFM3-1.7B 为约 1.73B 总参数、256K 上下文**，包含 13 个短卷积、5 个 sliding-window attention 和6个 full attention 层。**LFM3-Omni 总参数约 2.17B，模型卡支持上下文为 32K**，不能把配置字段中的 128000 直接当作公开支持上限；它是非 reasoning 模型。

这类混合结构同时需要卷积运行状态和注意力缓存，不能拿纯 Transformer 的 KV 公式覆盖全部内存。Omni 原模型的 24kHz 语音能力与本次引擎的文本输出范围是两个层次。模型采用 **LFM Open License v1.0**，部署前仍须核对其许可条件。

### 适配流程与尚未覆盖的组合

**stock Transformers 配置/processor → 多模态输入处理 → 短卷积与全局/滑窗注意力 → hybrid KV 与卷积状态管理 → 文本生成**。选择 FlashInfer 作为 prefill backend 时必须使用 paged 路径；这不是所有后端的统一要求；示例使用 `trust_remote_code`，本期未执行模型仓库代码。图像/视频解码仍有 CPU 路径，不能视为输入处理已经全部搬到 GPU。

CUDA cute 卷积覆盖所列 SM90/100/120 路径，其他情况走 torch fallback；fallback 存在不等于每种设备已经实测。推测解码和 DP attention 是明确拒绝的组合，不应在上线后才靠结果偏差发现。

### 质量与成本证据要分别看

开发 checkpoint 在 **H100、FP16、TP1** 上的 prefill/decode 检查通过，但 ROUGE 对照为 **Vision 14/16、Omni 20/22**，尚不能称完全等价。Triton 检查覆盖文本/视觉，没有覆盖音频/Omni；其他 BF16 和 H200/TP2 记录也各有范围，不能合并成全部矩阵通过。

模型卡的任务分数主要来自其注明的 vLLM BF16 配置，不能当作这个新 SGLang adapter 的结果。“约 1GB 的 4bit 权重”也不等于 256K 请求的总运行显存；“每天 36 亿 token”对应 B300、1024 并发等指定条件，不能转作低并发 H100 的承诺。

实际选型先按业务分别测指令遵循、视觉/音频输入质量，再固定量化、上下文、并发和 SLO 测峰值显存、TTFT 与输出速度。HuggingFaceTB、Microsoft、Google 以及 Liquid 的入口也已读；既报模板/许可变动和只修 banner 的记录没有再次计作新模型。

原始来源：[原始来源 1](https://api.github.com/repos/sgl-project/sglang/pulls/46858)；[原始来源 2](https://api.github.com/repos/sgl-project/sglang/commits/47361c57be9f)；[原始来源 3](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/1da06bec6a819da10b54c67e5c90972b46d81871/README.md)；[原始来源 4](https://huggingface.co/LiquidAI/LFM3-1.7B/raw/1da06bec6a819da10b54c67e5c90972b46d81871/config.json)；[原始来源 5](https://huggingface.co/LiquidAI/LFM3-Omni-2B/raw/main/README.md)；[原始来源 6](https://huggingface.co/LiquidAI/LFM3-Omni-2B/raw/main/config.json)；[LFM3-1.7B 官方模型卡](https://huggingface.co/LiquidAI/LFM3-1.7B)；[LFM3-Omni 官方模型卡](https://huggingface.co/LiquidAI/LFM3-Omni-2B)。
