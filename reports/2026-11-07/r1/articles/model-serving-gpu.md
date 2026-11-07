# 模型服务与 GPU 超配｜缓存准入和显存释放

本期研究截止北京时间 2026 年 11 月 7 日 07:26:51。先检查近 24–72 小时，必要时扩展至 168 小时；扩窗条目标明原始日期。

GPU 超配需要把独立模型的权重与运行状态分别算账。本页关注两类真实故障：多轮会话突发后缓存迟迟恢复不了，以及引擎休眠后显存并未归还。KV cache 是推理过程中保存的历史中间结果；prefill（预填充）先处理输入，decode（解码）再逐个生成输出 token。PD 分离把这两段放到不同工作进程或 GPU。

![LMCache sleep 和 wake 的物理页映射流程](assets/lmcache-vmm-sleep.png)

## LMCache：sleep先解除VMM导入映射，wake重绑新物理页

时间：2026-11-06 00:40:07 UTC，默认分支提交012965f888cccaa5102cec7a745990f60e8ca721。属于本次24小时窗口。主线代码可见，未核实稳定release版本。

**问题不是虚拟地址有没有变，而是谁仍持有物理页。** LMCache多进程模式中，服务端会导入vLLM worker的KV显存，并在自己的CUDA stream上拷贝。使用CUDA VMM时，导入端持有物理内存引用；vLLM单方面解除映射并不能保证显存归还。该提交随附文档记录过H200上的失败：136 GiB池sleep只释放2 GiB，随后wake遭遇CUDA_ERROR_OUT_OF_MEMORY。这是旧问题的观测，不是修复后释放率benchmark。

变化落在LMCache自带的LMCacheMPConnector及worker adapter。释放前，unregister_kv_caches取得注册锁，等待已跟踪的store/retrieve future连同服务端设备工作完成，再撤下transfer context、标记released，向服务端注销缓存并关闭导入映射。之后vLLM才释放物理页。wake重新映射后，即使tensor仍是原虚址，也必须创建新的transfer context、重新包装和导出，因为旧handle描述的是旧物理分配。

注册锁同时约束心跳恢复：睡眠期间server重启不能悄悄重注册即将释放的页。unregister与restore是幂等的；未恢复时误提交store/retrieve会明确报错。若wake时server已经被心跳标为不健康，restore不阻断唤醒，先按故障状态降级，待后续心跳恢复重新注册；若原先看似健康但注册超时，则抛ConnectionError并保留未注册状态，允许重试。

**要紧邻保留的边界：超时并不等于传输已安全停止。** 实现等待所有future共用mq_timeout预算；超时只记录“server may still touch the KV caches”并继续注销。注销回执超时同样记录日志，不抛出。这一版本不能被表述为任何故障下都保证DMA排空。实验性Q ring是LMCache自己分配的内存，sleep不会释放它；engine-driven模式没有GPU进口，但仍需要释放/重建共享内存staging context。配置上要使用LMCache发布的connector module path，不能仅因旧vLLM内置同名connector存在就认定获得此行为。

验证价值：独立模型轮换时，对每个模型分别核算权重、活动KV、图和量化缓冲、外部导入映射以及残留Q ring。验收应覆盖在途store/retrieve、server失联和重启、sleep/wake重复调用、同虚址新物理页、首个冷请求和后续命中；同时看实际可用显存、输出一致性、恢复延迟与P99，而不只看sleep日志。新增单元测试覆盖幂等、重注册、超时/恢复和两种传输模式，但不是完整Hopper故障注入实测或吞吐证明。

这与vLLM #66010的参数discard范围修正是两个事件：后者决定本进程哪些weights allocation可丢弃；本项清理的是另一进程持有的KV物理页引用。两者都可能影响切换，但不能合成同一个修复或互相替代。

来源：
- https://github.com/LMCache/LMCache/commit/012965f888cccaa5102cec7a745990f60e8ca721
- https://raw.githubusercontent.com/LMCache/LMCache/012965f888cccaa5102cec7a745990f60e8ca721/docs/design/integration/vllm/mp_sleep_mode.md
- https://raw.githubusercontent.com/LMCache/LMCache/012965f888cccaa5102cec7a745990f60e8ca721/lmcache/integration/vllm/vllm_multi_process_adapter.py


![Basin 硬件原型的缓存准入与借用关系](assets/basin-admission.png)

## Basin：突发后的缓存失速，需要会话级准入

时间：arXiv v1提交2026-11-02 05:13:05 UTC，属于168小时扩窗，非今日新发。

短暂流量高峰不一定会在流量回落后自行恢复。Agent会话反复访问增长的上下文：调用变慢使活跃会话留下更久，整体上下文工作集膨胀；prefix命中下降又增加prefill重算，进一步拖慢离场。Basin研究在PD分离SGLang上观察到这种反馈。它关心的是服务恢复边界，不是把更多KV塞进显存就能线性增加吞吐。

控制分三部分。网关让新会话先在外部排队，以固定会话优先级统一管理准入、prefill队列与等待decode内存的队列，避免每一轮调用重新洗牌。缓存侧借用空闲decode显存：decode保留之前PD传来的prompt页；对混合模型，还保存prompt末尾循环状态。下一轮prefill本地覆盖不足时，从decode取回缺失层状态，按层发布完成标记，在对应层执行前等待，并与后续传输重叠。decode活动需求优先，先回收借出的页再抢占运行请求；传输故障或超时回退重算。持续超载则限制准入并在条件满足时舍弃排队需求，不把无限排队伪装为容量。

**完整算法与硬件原型必须分开。** 论文完整控制器预测每个会话的峰值上下文并做预留，优先级将到达时间与预测占用结合；这部分用离线profile和预测器，在模拟器中评估。真实GPU上的原型只使用到达时间排序、当前上下文准入、decode内存借用和shedding。不能把预测峰值版本的模拟收益说成已经在H200实测。

真实对照：一台四H200节点做1P3D、两张H100 NVL做1P1D，均在SGLang、NIXL、page size 64下服务FP8 Qwen3.6-35B-A3B，40层中30层为线性注意力。工作负载是Terminal-Bench轨迹及70个SWE-bench Pro会话，保留前一调用完成后再等待tool gap的闭环关系。两者median peak context分别约40K、107K。运行2小时，tool gap放大场景为2.5小时，统计前90分钟到达会话。主突发为15至35分钟五倍到达量，另比较tool gap×3、GPU-only缓存与SWE-bench Pro。

指标不是tokens/s。Goodput是每小时完成且slowdown不超过4、至少95% decode step满足50 ms ITL SLO的会话数，首次排队等待计入slowdown；拒绝和丢弃的会话计失败。H200 1P3D四场景中，Basin达到Continuum的1.20–1.70倍、HiCache alone的2.35–3.59倍goodput。SWE-bench Pro中为126.7 sessions/h，对比Continuum 106.0、CONCUR 86.0，median首调用等待68秒。不能把这些数字改写成输出token吞吐。

同一论文也给出了反例：H100 NVL 1P1D先被decode卡住，Basin、Continuum、组合基线分别56.7、55.3、55.3 sessions/h。此时decode可借空间少，缓存保护基本没有额外吞吐收益。模拟中size-aware优先级在这一类场景仍改善SLO内完成数，但那不是该硬件原型的结果。

价值与下一步：H100/H200上先用真实多轮轨迹做“短时超载→恢复原到达率→持续观察”的验收，记录活跃会话数、上下文工作集、prefix命中、重算、首次等待、P99以及goodput。对独立模型服务，每模型权重、KV、循环状态和workspace都独立计费，借出的只应是已核实空闲的服务内缓存容量；论文没有实现不同模型任意共享KV，也没有证明多模型同卡显存超配收益。扩缩容会改变缓存失速边界，需重新profile；父子任务依赖和共享页记账也超出本文独立会话评估。

来源：
- https://arxiv.org/abs/2611.02543v1
- https://arxiv.org/html/2611.02543v1
