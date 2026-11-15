同一模型可以同时包含全注意力、滑动窗口和循环状态层。部署多个模型时，如果把这些层都按等宽、可复用的 KV 来估算，容量预算与卸载行为都可能出错；不同模型的权重和运行状态仍须独立计算。

LMCache **11 月 14 日 04:25 UTC** 合入 #6608，主线提交 `bcafb031401d404a5dabae4853f5e23bf9e5685c`。这次变化是适配 vLLM 新的 `KVCacheGroup` 接口，恢复对各组真实语义的读取，而不是推出新的显存共享算法。

### 从组规格到缓存策略

适配层从 `kv_cache_specs` 与 `distinct_specs` 读取各层规格；流水线并行投影后，某组可能没有当前 rank 的本地层，不能假定每组都有可枚举的本地数据。滑窗与 Mamba 配置改从 `manager_config.params` 取得。

`prefix_cacheable=False` 的组按 scratch 处理，不能当作可跨请求命中的前缀缓存；每块 token 数也只有在 `dcp_sharded` 时乘 DCP 系数。把所有组都乘同一个并行系数，会把布局含义和容量混在一起。

机制关系可以概括为：**层规格 → 缓存组及并行投影 → 可复用性与块布局 → LMCache 的数据表示**。先把这条映射做对，远端缓存、卸载或池化才有正确对象可操作。

### 超配的实际价值与验证条件

多模型预算仍为各自的权重、KV/循环状态、激活、临时工作区与余量之和；本次没有让不同模型共享权重，也没有默认允许跨租户复用 KV。可复用对象与临时 scratch 应采用不同的生命周期和隔离策略。

PR 记录了固定 nightly 上的 CPU 测试，以及对新版真实组对象的导入和转换验证；**没有 vLLM main 的 GPU 端到端结果**。接入前应固定 vLLM/LMCache 版本，用混合层、PP 投影和 DCP 配置验证布局，再观察同一并驻负载下的显存峰值、命中率、TTFT 与尾延迟。本次修复不能直接折算为超配倍率或吞吐提升。

原始来源：[原始来源 1](https://api.github.com/repos/LMCache/LMCache/pulls/6608)；[原始来源 2](https://api.github.com/repos/LMCache/LMCache/commits/bcafb031401d404a5dabae4853f5e23bf9e5685c)。
