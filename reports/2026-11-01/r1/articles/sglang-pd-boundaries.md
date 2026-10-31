# SGLang 的 PD 升级要同时检查协议与乱序请求

研究截止：2026-10-31 21:23 UTC。文中事件时间均为 UTC。

### 注册帧调整要求 prefill 与 decode 同版

[#47638](https://github.com/sgl-project/sglang/pull/47638) 于 **2026-10-31 15:37:49 UTC** 合并，提交 `5eb70183472d56326920e70a4dde5cfbabe6f376`。它调整 **decode → prefill** 注册消息，将 `aux_item_lens` 从消息尾部的可选帧，移到 `aux_ptrs` 后，并改为始终发送；功能关闭时发送空帧，接收端解析成 `None`。位置协议因此不再因功能开关而改变后续帧索引，但新旧布局本身不兼容。

**作者明确要求 prefill 与 decode 使用相同 SGLang 版本；包含与不包含此改动的构建不能混用。**这是升级计划约束，不是仅在启用 customized-info transfer 时才需要留意的性能选项。[来源：PR Compatibility](https://github.com/sgl-project/sglang/pull/47638)

### 迟到的请求不能把已完成 chunk 变回待处理

[#47652](https://github.com/sgl-project/sglang/pull/47652) 于 **2026-10-31 17:55:57 UTC** 合并，提交 `e624174f0734ef605fad45edffa4603e4ae62d80`。在 prefill TP 大于 decode TP 时，一个 decode rank 的 chunk 会对应多个 prefill writer。`STAGING_REQ` 与 `CHUNK_READY` 走不同 socket，跨 socket 没有到达顺序保证。

旧路径在 chunk 完成 scatter 后，把槽位重置成可用状态。随后才到达的重复 `STAGING_REQ` 被当作新请求，再分配一个永远不会 scatter 的槽位；由于 staging buffer 是环形结构，这个槽位还会阻塞后续 room，直到超时。新路径使用 `CHUNK_SCATTERED` 标记已完成状态，并直接忽略该 chunk 的迟到请求。修复位于 Mooncake 与 NIXL 共用 handler。[来源：PR 根因与改动](https://github.com/sgl-project/sglang/pull/47652)

作者在相关测试中观察到过 **200 个请求中 17 个挂起、其中 12 个等待 300 秒后超时**，并指出同样的主线代码此前也通过过该测试，因此这是间歇竞态，不能写成每次都会触发。新增单测验证 scatter 后的迟到请求不再调用分配器；这不等于已经证明所有 PD 压力场景均无停顿。[来源：PR 测试说明](https://github.com/sgl-project/sglang/pull/47652)

**建议：**将“跨版本 PD 对等端不得互联”作为升级门槛，按同版兼容组规划切流与回退；验证启动初期 burst、prefix/radix cache 命中及 prefill TP 大于 decode TP 的组合，关注 ring 占用是否回收和后续请求是否被阻塞。不要把一个已合并补丁当成混版滚动升级的授权。
