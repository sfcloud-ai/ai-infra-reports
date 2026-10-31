# SGLang 先扣持久缓冲 再给 KV cache 定容

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

**事件：**[#47577](https://github.com/sgl-project/sglang/pull/47577) 于 **2026-10-31 06:59:47 UTC** 合并，合并提交为 `6e4d53fbc445fe9678062a5c95ad5e292efacb4f`。

### 它不是减少缓冲 而是修正记账时机

MegaMoE 的 symmetric buffer 原先由第一次 forward 分配，此时 KV cache 已完成定容。该缓冲持续存在于整个运行期间，却消耗原本为 activations 和 CUDA graphs 保留的 runtime slack；最大 token cap 增大时，持久成本也随之增长。

新路径在模型 post-load 变换之后、KV cache 定容之前，为已就绪的 DeepSeek `DeepseekV2MoE` MegaMoE 层分配相同缓冲，draft worker 也在自己的 KV 定容前完成这一步。forward 复用预先分配的对象，避免“预估一个、运行又建一个”。**因此 KV pool 会按缓冲成本相应缩小，而不是凭空释放这部分显存。**[来源：PR 说明](https://github.com/sgl-project/sglang/pull/47577)

### 作者的高容量配置案例

测试组合为 **DeepSeek-V4.1-Flash、GB300、DP attention 4、MegaMoE、DSpark**，cap `SGLANG_OPT_DEEPGEMM_MEGA_MOE_NUM_MAX_TOKENS_PER_RANK=65536`，`--mem-fraction-static 0.9`，并使用 4096 与 8192 tokens 的 breakable prefill graphs。作者报告：

- 旧路径在 `symm_mem.empty` 启动 OOM。
- PR 路径可以提供服务；每 GPU 持久缓冲为 **target 22.31 GiB 加 draft 11.78 GiB**。原日志标作 GB，但源码按 2³⁰ 字节换算，这里统一为 GiB。[来源：PR Verification 与 diff](https://github.com/sgl-project/sglang/pull/47577)

旧路径没有成功启动，不能据此计算速度提升。**这组 GB300 结果不外推为 H100 或 H200 的容量、性能保证。**

### 覆盖范围比 MegaMoE 这个名字更窄

PR 明确指出，其他 MegaMoE 模型路径，例如 Qwen MoE、MiniMax-M3、Kimi-K3，以及 AMD FlyDSL，仍在第一次 forward 分配。不能从 DeepSeek 这条路径的修复外推为所有 MoE 的预算问题均已解决。[来源：PR 范围](https://github.com/sgl-project/sglang/pull/47577)

**工程判断：**提高容量上限时，先问哪些通信缓冲和路由缓冲会跟着增长。持久分配如果藏在第一次执行里，静态预算比例即使不变，实际可服务容量也可能失真。

**建议：**在目标模型、draft、backend 和 cap 的真实组合下，比较定容前后缓冲日志、KV 容量及首次 forward 峰值。不要直接复制作者的 0.9 比例，也不要把 KV pool 变小误判为内存回归。

## 完整资源预算与服务边界

各模型独立计入权重与运行状态，不能默认跨模型共享权重或 KV。

![原创简化示意：完整显存预算、持久缓冲定容顺序和PD边界，非性能对比](assets/service-boundaries.png)
