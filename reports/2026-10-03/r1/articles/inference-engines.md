历史归档：原期次 2026-10-03，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

一次请求已经返回错误，远端 prefill 或网卡却可能仍向它的 KV 页写入。如果分配器立即把这些页交给下一请求，晚到的写入就可能污染新数据。真正需要证明的是所有写入者已经退出，而不只是用户已经看见失败。

SGLang 0.5.21 汇集了此前合入的失败清理修复。#41023 为具备相应能力的 Mooncake、NIXL 路径默认延迟释放，等待已通知的 prefill ranks 返回排空 ACK，或进入超时回退；Mori 与 fake 路径不具有同样的实现。默认 30 秒超时是协议中的回退条件，不是任意故障下的安全证明。[发布版本](https://github.com/sgl-project/sglang/releases/tag/v0.5.21)、[默认延迟释放](https://github.com/sgl-project/sglang/pull/41023)

另两项修复补齐了不同阶段：#40645 将 ACK 目的地保留到写入排空，处理提前排空与 late abort；#41404 扩展到 prefill fault、transport error 和 HiCache restore failure，包括 metadata 部分发布之后的失败。它们提供的是生命周期正确性证据，没有声明普遍吞吐提升。[ACK 生命周期](https://github.com/sgl-project/sglang/pull/40645)、[扩展失败路径](https://github.com/sgl-project/sglang/pull/41404)

验收时应故意延迟远端写入，记录请求代次、物理页、metadata slot 与每个 rank 的确认。API 结束、传输结束、资源可复用应是三个独立可观测状态。隔离中的字节数、最老资源年龄、欠缺 ACK 的 rank 与超时次数，能帮助区分正常排空和真正泄漏。

这是对已经存在的引擎回收能力做针对性补强，不能据此推断其他引擎或内存池完全缺少安全生命周期。部署只在实际采用对应 PD 传输路径时直接相关；单个正常请求通过，不能替代取消、节点故障和恢复中再失败的测试。
