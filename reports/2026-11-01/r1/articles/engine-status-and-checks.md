# DeepInfer 持续跟踪 不补凑新闻

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

## 推理引擎每日变动

### vLLM

已核查本轮 24 小时发布、PR 和提交记录，有合格主线变动；详见本期 logprobs 显存、工具解析与 direct reload 三篇子文章，不重复展开。

### SGLang

已核查本轮 24 小时发布、PR 及所选变更提交，有合格主线变动；详见本期持久缓冲与 PD 边界两篇子文章，不重复展开。

### DeepInfer

本轮核查中，DeepInfer 主线过去 **72 小时没有新 commit**；已知 main 为 `553741557a57df44a46fb3ab72b6aafeaf945337`，时间 **2026-10-25 11:59:27 UTC**，releases 列表为空。当前跟踪边界仍是离线 **SM100 与 Ascend 950**；社区 H100 线索不写成官方已支持。

本条只记录持续跟踪状态，不作为新发布或支持范围扩展新闻。[固定 SHA 的官方 README](https://github.com/deepseek-ai/DeepInfer/blob/553741557a57df44a46fb3ab72b6aafeaf945337/README.md) · [主线提交记录](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?per_page=10) · [releases 列表](https://api.github.com/repos/deepseek-ai/DeepInfer/releases?per_page=10)

## 今天可以安排的验证顺序

可按以下风险顺序安排验证。

1. **先确认真实需求。**是否使用全词表 prompt logprobs、Qwen3 工具解析、DeepSeek MegaMoE、PD 分离或 RL 权重更新？不在相应路径上，就不要为追新引入额外变更。
2. **先守正确性与兼容性。**PD 两端锁定同版；direct reload 保持谨慎；记录模型、backend、draft 和配置，而不是只记框架版本。
3. **再测资源账。**分开记录持久缓冲、临时输出、执行工作集和 KV pool，特别检查 warmup 与第一次 forward。
4. **最后测服务行为。**工具输出退化时的健康检查，PD 乱序与启动 burst 下的完成率，以及失败恢复后的输出正确性，都比单次 tokens/s 更贴近本期风险。


## 版本状态与证据口径

- 本文六项 PR 均为 **已合并到主线，尚未进入本轮核查到的最新正式 release**；不要把 merged 写成 released。
- 本轮核查到的最新 release：**vLLM v0.32.0，2026-10-18 06:50:48 UTC**；**SGLang v0.5.22，2026-10-19 UTC**。本文不将这之后合并的改动记为已发布功能；发布前仍需再次检查 release 状态。[vLLM releases](https://github.com/vllm-project/vllm/releases) · [SGLang releases](https://github.com/sgl-project/sglang/releases)
- 文中测试数值来自相应 PR 的作者报告；覆盖范围与影响选型的限制已随条目说明。
- 选题已与 **2026-10-24 至 2026-10-31** 的已发晨报正文去重。
- **Prompts 固定版本：**`3a0bd94f07cbfe0679766779eceb6fbf0086b4f1`。

**一句话收束：**减少临时峰值、提前计入持久成本，都值得跟进；但版本互通、异常输出和失败后能否继续服务，仍需要独立的上线边界。
