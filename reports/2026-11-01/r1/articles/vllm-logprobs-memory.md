# vLLM 将分块 logprobs 的重复结果驻留移出峰值

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

**事件：**[#64841](https://github.com/vllm-project/vllm/pull/64841) 于 **2026-10-31 18:48:17 UTC** 合并，合并提交为 `42258ca4afe8d3cee728a2d7cf52091f3ace15ff`。

### 改了什么

Model Runner V2 的 `compute_prompt_logprobs_with_chunking` 原先保留各个 chunk 的结果，最后再 `torch.cat`，在拼接时产生第二份完整输出。新路径在首个 chunk 后预分配最终输出，后续 chunk 直接写入对应区域。同时，输出 token id 从 int64 改为 int32：与 fp32 score 合计，每项从 **12 bytes 降至 8 bytes**。单个 chunk 的 prompt（不超过 1024 tokens）仍直接返回结果，不增加最终输出复制，只有 id 类型转换。[来源：PR 说明](https://github.com/vllm-project/vllm/pull/64841)

作者给出的典型规模是 **2048-token prompt、约 152k 词表、全词表 prompt logprobs**：峰值从约 **7 GiB**，改为约 **2.3 GiB 的输出加一个 chunk 的工作集**。这里的 2.3 GiB 不是整个请求、模型或 GPU 的总显存。动机案例是 18 GB MIG slice 上的定容 warmup，被约 7.5 GiB 的临时开销挤掉了 KV cache 空间。[来源：PR 说明](https://github.com/vllm-project/vllm/pull/64841)

### 证据与边界

- 作者报告在单 GPU GB200 上，列出的 logprobs 测试子集 **14 passed、7 skipped**；新增测试比较分块与不分块的 ids、logprobs 和 ranks。**未提供 H100 或 H200 数据。**
- CPU worker 中对应函数没有改动。
- **跨 scheduler step** 的同一 prompt，仍会把各 step 结果保留在设备上，直到最后一步再拼接；本 PR 没有消除这部分驻留。
[来源：PR 验证与限制](https://github.com/vllm-project/vllm/pull/64841)

**工程判断：**显存预算应单列“完整输出及其生成工作集”，而不是只看权重和 KV。若业务只请求少量 top-k logprobs，不能直接套用全词表案例的绝对收益。

**建议：**如果实际服务使用 Model Runner V2 与大词表 prompt logprobs，优先对比分块边界、全词表与 top-k、抢占恢复以及跨 step 长 prompt；分别记录 warmup 峰值、请求峰值和最终 KV 容量，而非只看空闲显存截图。
