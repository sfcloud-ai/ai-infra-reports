# 模型服务与 GPU 超配｜LMCache 把认证落实到 gRPC 请求入口

2026年11月8日01:17:52 UTC，[LMCache #5770](https://github.com/LMCache/LMCache/pull/5770) 合并为 [a9db748507898234ffe8a2185d512e0a3719f554](https://github.com/LMCache/LMCache/commit/a9db748507898234ffe8a2185d512e0a3719f554)，为同步和异步 gRPC 服务增加 API key 认证。对缓存服务交付而言，新增的是“谁可以调用数据接口”的可验收边界；显存容量、跨模型缓存身份和租户配额仍是另几项独立问题。

## 实际问题：HTTP 受保护，不代表缓存 RPC 也受保护

推理进程通过远程调用向独立缓存进程查询、存取 KV。如果只给管理 HTTP 接口配密钥，实际 gRPC 缓存入口仍可能接受未授权调用。新路径复用已有统一密钥加载与验证组件，在客户端 metadata（RPC附带的字段）注入 Bearer 凭证，在服务端 interceptor（进入业务处理前的拦截器）检查。

无密钥或错误密钥会得到 UNAUTHENTICATED。拦截器保留 unary 和 streaming 的调用类型，但拒绝路径不配置 protobuf 反序列化器，因此连畸形请求也先被拒绝，业务 handler 不执行。同步与 aio 异步模式各有对应拦截器；客户端替换已有 authorization 字段，避免双重凭证含糊。

## 兼容性边界比“已支持认证”更重要

配置可由服务器密钥文件及已有环境来源加载；没有配置任何 key 时仍保持无认证兼容行为，不是升级后默认安全。native gRPC 前端不支持 Python 拦截器，配置 key 时在绑定端口前失败，要求选择 sync/aio，避免静默跳过认证。

默认 ZMQ 路径仍只保护既有 HTTP 端点；传入 API key 会警告并忽略，ZMQ 请求认证由另一项工作处理。普通 insecure gRPC 不加密 token，本变更未实现 TLS/mTLS；应由可信网络、加密隧道或正确 TLS 终止保护传输。API key 认证也不等于按租户的缓存对象授权与资源隔离，不能替代各模型独立的权重/缓存身份、配额和内存预算。

## 已有验证说明能支持什么

PR 给出同步/aio 的真实 TCP RPC 测试，覆盖正确/缺失/错误凭证、轮换中的两个key、streaming、未认证时 handler 零调用、畸形 protobuf 与关闭认证兼容；近期 CPU 回归为165通过、4跳过，跳过的是需 pygrpc-native 的路径。

GPU 端到端证据明确绑定较早的 03dc7884 提交，并非合并头重跑：单 H200、驱动580.178.04、PyTorch2.13.0+cu130、vLLM 0.31.1rc1.dev136+g705e124c0、Qwen3-0.6B 固定模型版本，关闭 vLLM prefix cache，两次1521输入token/16输出token请求，LMCache命中由0到1280且输出相同。缺失/错误key时推理进程不能就绪并明确报认证错误。该结果验证功能链路，不是吞吐或延迟benchmark，不能承诺认证开销可忽略。

对交付的直接价值是把缓存RPC准入变成可检查条件。升级须核镜像实际含合并提交，在目标传输模式验证负例拒绝、正确key的冷/热请求、流式行为及加密终止，并分别检查管理HTTP和缓存RPC，不只看健康检查成功。本次仅确认合并，未确认稳定包覆盖或目标生产实例已启用。

来源：[固定认证实现](https://github.com/LMCache/LMCache/blob/a9db748507898234ffe8a2185d512e0a3719f554/lmcache/v1/multiprocess/transport/grpc_impl/auth.py)、[PR 的测试条件和记录](https://github.com/LMCache/LMCache/pull/5770)。


![LMCache认证边界：依据合入实现的原创简化图](assets/lmcache-auth.png)


# 模型服务与 GPU 超配｜FlashOffloading：容量增加必须同时算回载等待

[FlashOffloading 论文 v1](https://arxiv.org/html/2611.07542v1) 发表于2026年11月5日06:50:05 UTC，本期由7日扩展窗口纳入。可以把它理解为：完整历史放在主机内存，设备只留下本轮需要的部分，但搬回来的等待也必须计入服务延迟。这个前提适用于论文的原生稀疏注意力模型，不是任意注意力模型都能照搬。方案将完整KV保存在主机DRAM，用小得多的设备缓存保留当前需要的状态；不同模型的权重和KV仍各自独立，不是跨模型共享，也没有解决多租户抢占或隔离。

## 分阶段改变搬运粒度

Prefill（处理输入）计算较多，按完整层回载：第一层常驻，另三个层缓冲区轮换，回载下一层、计算当前层和写回上一层并行。只有所有消费者（包括 Decode 远端读取）和写回都结束后才能复用缓冲区，不能为省显存覆盖仍在使用的数据。

Decode（逐步生成）计算窗口短，不能每步搬回整层。主机保存全历史，设备保留热点KV与完整indexer状态。token→slot逆索引直接指出某token是否已在设备；LIM内核将命中判断合入top-k选择，合并MTP多路缺失集合，再生成淘汰/回载计划。CopySFA将缺失KV回载与稀疏注意力计算融合，利用命中部分的计算覆盖传输。增量是减少“查缺失”和“搬缺失”的暴露延迟，并非提出一个通用的缓存层。

## 数字必须连同代价阅读

论文端到端平台为4服务器、32张Ascend910C卡（64 die，每die 64GB），GLM-5.2-w4a8c16，MTP3，vLLM/vLLM-Ascend 0.30修改版。P节点DP2/TP16/EP32，D节点DP16/TP2/EP32；突发并发，90% prefix命中，输出8192token。

64K输入时，相对仅P侧卸载，P+D卸载把D侧每rank batch从4增至12，输出吞吐3787→6358 token/s（约1.68倍），但平均TPOT从16.9→30.2ms。128K为1928→3692 token/s、TPOT16.6→26.0ms；1M虽可运行，TPOT为34.1ms。不能将摘要概括成“所有配置严格满足30ms”，也不能把含缓存输入的吞吐写成输出吞吐。结果不直接适用于H100/H200，更不能用于型号待核实的Pro5500容量报价。

Prefill收益也部分来自调参：释放KV空间后将max-num-batched-tokens从16384提高至131072，激活占用相应增加。论文同chunk对照显示卸载反而增加TTFT，不能将容量换取的大batch收益说成回载没有成本。

## 已有实现与接入门槛

[官方实现指南](https://github.com/vllm-project/vllm-ascend/blob/releases/v0.30.0/docs/source/user_guide/feature_guide/layerwise_and_sparse_kv_cache_offloading.md) 已包含组合路径，支持GLM-5.1/5.2、DeepSeek-V3.2；仅P/D分离部署，非通用同机服务。Prefill依赖Memcache与eager模式，组合路径使用SfaRemoteD2HConnector；P侧TP需大于等于且整除D侧TP。主KV要求BF16，不支持C8/TQ4；indexer INT8是另一项设置。Decode不支持CP，与PreemptOffloadConnector互斥，950PR/950DT的稀疏Decode路径也未支持。

本次读取的release分支树包含相关层卸载、LIM、CopySFA与测试，设计/使用文档字节已与同一树核对。它证明存在可追溯实现，不证明环境依赖已经装好或复现完整性能。主机DRAM、MemFabric路径、热点容量与DP间负载不均都会影响暴露等待。对H100/H200服务的可迁移启发是按阶段划分回载粒度和生命周期；采用前应先与现有CPU卸载、亲和路由和足够主机RAM的基线比较，再测目标模型/SLO，不能直接移植Ascend专用内核。


![FlashOffloading机制：依据论文与实现的原创简化图](assets/flashoffloading.png)
