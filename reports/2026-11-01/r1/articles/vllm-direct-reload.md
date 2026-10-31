# vLLM direct reload 已合并但不宜默认开启

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

[#64336](https://github.com/vllm-project/vllm/pull/64336) 于 **2026-10-31 06:50:27 UTC** 合并，提交 `b5755c3ba5d4f751445be39c8ad8a50d9a8f93c1`。`VLLM_RELOAD_MODE=direct` 将 checkpoint tensors 原地写入 live model，再运行 post-load processing；**默认值仍为 `layerwise`**。

这里应先读限制，而不是先读成功测试：

- 从 `begin` 到成功 `finish` 之间，张量持有 checkpoint-layout bytes，模型不应执行；PR 没有提供回滚。
- 作者明确说明，当前没有阻止 pending 或 failed direct update 的模型继续运行。在其披露的 `update_weights` chunk 失败路径中，worker 会恢复服务，却让已变换布局的张量仍持有 checkpoint-layout bytes，产生静默错误，直到下一次完整更新修复。这不是仅影响重试或错误检测的问题。
- 对需要改变布局或非幂等 post-load 处理的模块，更新必须交付全部 checkpoint tensors；该完整性约束在本 PR 中尚未检查。
- 仍有地址、派生张量和 backend 相关的后续工作；此前的端到端大模型验证不是在这次改动之后重跑的结果。[来源：PR Delivery contract、Known limitations 与 Tests](https://github.com/vllm-project/vllm/pull/64336)

**建议：**继续保留 `layerwise` 默认路径。若确有 RL 权重同步需求，再为 direct 模式设计失败时摘流、完整更新恢复、输出正确性和所用量化 backend 的专项验证。先建立“错误布局不得服务”的边界，再评估原地更新的成本收益。
