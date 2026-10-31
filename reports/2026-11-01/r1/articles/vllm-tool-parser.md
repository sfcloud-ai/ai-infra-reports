# vLLM 降低工具解析对健康检查的影响

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

**事件：**[#64675](https://github.com/vllm-project/vllm/pull/64675) 于 **2026-10-31 01:51:14 UTC** 合并，合并提交为 `c7a683bde5909bf2862d5d4500239dd1e3bd44bc`。

### 问题不在 GPU

流式 Qwen3 XML 工具调用如果不断重复已经闭合的参数，旧路径每次转换都会重新扫描历史参数。输出越长，单次解析越重，最终挤占 API server 的事件循环，连 `/health` 都可能无法及时响应。新实现为已闭合参数建立缓存，能够从上次完成的位置继续解析；文本不满足缓存前缀时，再从头解析。[来源：PR 根因与改动](https://github.com/vllm-project/vllm/pull/64675)

作者的新测试中，401 个闭合参数在旧路径产生 **2,051,331 次匹配**，新路径总共匹配 **401 次**。在重复两参数的特定负载下，64K 输出字符处每个 4-token engine step 的端点处理成本，由约 **6.4 ms 降至 92 μs**。[来源：PR 验证](https://github.com/vllm-project/vllm/pull/64675)

### H200 实测说明的是可靠性风险

作者使用 **Qwen3-Coder-30B-A3B-Instruct、单 H200、Model Runner V2、无 speculative decoding**，通过测试 logits processor 强制生成相同的参数循环；模型、引擎、解析器和 HTTP server 为真实运行组件。256K 字符场景中：

- 旧路径 API server 总体 CPU busy 约 **90%**，产生 **16 次、每次 10 秒的 `/health` 超时**；流中后段达到 100% busy。
- PR 路径总体 busy 约 **7%**，`/health` **p99 为 0.90 ms**，没有该类超时。
- 两者流式参数输出一致。普通、未强制参数循环的一次 `Write` 请求，没有展示出同等级收益。[来源：PR 的 Server run](https://github.com/vllm-project/vllm/pull/64675)

该强制循环案例不能代表自然业务分布，却揭示了明确风险：**GPU 继续产出 token 时，CPU 上的输出处理仍能把服务判活拖垮。**

### 不要把修复理解为解析成本已经有界

该变更覆盖使用 Qwen3 converter 的解析器；`MiMoParser` 的独立 converter 没有改变，也没有新增配置或 API。大量不同参数仍要序列化既有参数，重复参数名下的长 value 仍有整段转换成本。作者同时说明，相关 parser CI job 当时处于禁用状态；报告的验证不能等同于整套 CI 全绿。[来源：PR 范围与验证限制](https://github.com/vllm-project/vllm/pull/64675)

**建议：**把重复闭合参数、重复名长 value、多流并发列入工具调用回归集，同时观察输出等价性、API server CPU、事件循环延迟和健康检查。不要仅靠把 liveness timeout 调大来掩盖无界历史扫描。
