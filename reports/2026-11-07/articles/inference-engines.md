# 推理引擎每日变动｜休眠状态与页面回收

本期研究截止北京时间 2026 年 11 月 7 日 07:26:51。先检查近 24–72 小时，必要时扩展至 168 小时；扩窗条目标明原始日期。

本页的 forward 指模型前向计算，stream 是 GPU 工作队列。CPU 主存与 GPU 的 HBM 显存需分别预算；TTFT 是首字等待时间，TPOT 是相邻输出 token 的耗时，P99 指最慢约 1% 请求的延迟边界。以下两项均为主线合并，未把代码合并等同为稳定版发布或性能验收。

## vLLM：Level 2 只丢弃会重写的参数，其他加载期状态原地址恢复

**事件与状态。** [#66010](https://github.com/vllm-project/vllm/pull/66010) 于2026年11月6日20:34:00 UTC合并，commit为 [f8b1164](https://github.com/vllm-project/vllm/commit/f8b116409c4cdf02cee4bb7eca8e6bb9780c2e35)。当前最新release条目v0.33.0rc3发布于11月2日，稳定版仍为v0.32.0，不能把该修复写成稳定版已有。

**原先把整个分配池当成同一种生命周期。** weights池包住整个模型构建过程，所以除参数外，还容纳通信指针表、权重加载闭包里的排列索引、量化方法属性中的缓存。Level 2原先整体丢弃这个池，再逐项抢救named_buffers；没有注册成buffer的结构仍会消失。权重更新只改参数，未必重建这些结构，因而可能唤醒成功却在第一次forward非法访存，或持续生成错误结果。

**新机制按实际可重建对象决定丢弃。** worker把随后更新会重写的参数storage地址交给分配器。只有一个allocation的全部live block都在这份集合中，才丢弃整块；只要混入其他状态，就备份整个allocation到CPU，在wake时恢复到原地址。显式保留的参数不进入可丢集合。Level 1语义不变，KV内容仍会丢弃。它改善的是每个模型自身的休眠/恢复边界，不提供跨模型权重或KV共享。

**可核对的验证与资源代价。** DeepSeek-V4.1-Flash在GB200、TP4、direct磁盘重载三轮的实例，冷启动及首轮、第三轮GSM8K分别为0.9052、0.9060、0.9037，160个专家张量均与真实冷启动一致。GB300的NCCL更新还使用固定token logprob oracle检查。相应DeepSeek-V4.1案例每rank主机备份由0.97增至2.35GiB，释放80.35GiB GPU内存。这里的收益是恢复正确性，不能把释放量写成额外可用吞吐，也不能把GB200/GB300数据外推为H100/H200在线服务结果。

**部署判断。** 多模型轮换应为每个独立模型同时留出CPU备份、唤醒峰值HBM、独立权重和重新生成KV的预算。没有写回且未显式保留的参数仍可能被丢弃；从权重派生的张量只是保住旧值，仍须在post-load刷新。外部SleepModeBackend插件也要适配suspend的参数由level变为discardable地址集合。下一步应在H100/H200本机验证连续多轮唤醒、固定token logprob、任务质量、CPU备份驻留和唤醒期间P99延迟，而不是只检查GPU显存是否下降。Pro5500型号待核实，不能据此承诺适配。

与[LMCache 的跨进程 KV 映射适配](/ai-infra-reports/2026-11-07/r1/model-serving-gpu/)是不同问题：本条保住模型加载期的非参数运行结构，后者处理其他进程对KV物理页的引用。

![vLLM sleep 中参数与构建状态的区分](assets/vllm-sleep-state.png)

## SGLang：旧forward读完之前，等待的是页面的新写者

**事件与状态。** [#48496](https://github.com/sgl-project/sglang/pull/48496) 于2026年11月6日20:55:20 UTC合并，commit为 [adeec96](https://github.com/sgl-project/sglang/commit/adeec96c4ca6a83271a6df5e6c10d9f8428371d2)，承接同日[#48450](https://github.com/sgl-project/sglang/pull/48450)的正确性修复。稳定版v0.5.23发布于11月2日，尚不包含这两步变化。

**虚拟编号释放后，在途计算仍可能读取原物理页。** 开启统一内存与lazy compaction时，请求抢占或radix淘汰会释放虚拟ID，但在途forward已经准备好的attention页表仍指向原物理页。仅保证v2p/p2v元数据更新顺序，不能保证attention已经读完。页面如果立刻被下一次分配清零，旧forward会读到被覆盖的KV。

**从全流等待改为写者依赖。** #48450先让当前调度stream等待forward-done事件，修正早回收问题，但排在后面的HiCache索引准备、decode主机恢复等也可能被拖住。#48496把释放页与旧forward的完成事件暂存，完成后才转入普通空闲链表。容量紧张时可以提前交出这些页，但只能在reuse fence之后重写：分配清零放在forward stream上；紧急搬移先完成主机索引读取再等待；不受CUDA stream约束的RDMA写入，则通过推迟decode目的地址发布来约束。未完成释放页也纳入可排空容量账，避免各rank依据局部完成时序错误扩张watermark。

**价值及限制。** 正确性条件从“映射已更新”落实为“最后的旧读者完成后，新的写者才能覆盖”。适用场景是KV容量压力、retraction、淘汰与HiCache/PD重叠，不是跨模型显存共享。该变化限CUDA统一内存lazy bands，CPU bands和eager compaction不走同一路径。PR未给出速度测量，压力下仍有forward-stream清零及搬移等待，因此只能说减少不相关等待的机制已经合并，不能写成已证实吞吐提升或H100/H200固定收益。

**值得验收的负载。** 在持续forward期间强制淘汰和重用物理页，叠加HiCache回填与PD传输，验证旧读者不读到新数据、RDMA目的地址不会过早发布；同时测TTFT/TPOT的P99和forward间GPU空洞。只跑正常容量、无在途读者的单元测试不足以覆盖这个边界。

![SGLang 回收页的新写者等待旧 forward](assets/sglang-reuse-fence.png)

## 博客与代码覆盖记录

截止2026-11-06T23:26:51Z，vLLM与SGLang分别读取近24h的99、87条提交，以及各自最新6条release。未把拼写、纯CI、无行为重构凑成新闻。

vLLM官方博客已读11月6日Zero Mismatch异步RL、11月4日Kinference与Kimi K3.1 Pro正文及原始Markdown。RL 的机制与限制见[模型与新架构](/ai-infra-reports/2026-11-07/r1/model-architecture-status/)，有09:00:00+0000精确发布时间；另两篇只有日期，不用Git提交时间替代。SGLang.io博客索引与11月4日Kimi正文已读；其中明确区分preview镜像与正式release，并给出H200 DP attention在高并发收益、低并发退化的条件。LMSYS补充索引已读，11月2日HiCache和11月4日XM-Sparse两篇仅作为发现线索，尚未完成正文核验。


## DeepInfer：已核查，未选入新的实质发布
本次独立读取 deepseek-ai/DeepInfer 的提交、release 列表、最近更新的 30 个 PR、README 和部署 Q&A。主线最新提交仍是 2026-11-03 07:31:40 UTC 的 Q&A v0.2，已在 11 月 4 日报道；release 列表为空。近期可见前缀截断、fork 缓存长度声明、评测结束原因等未合并提案，不能写成主线已支持或稳定版修复，本期不以这些提案凑数。

当前官方 README 的范围仍是 DeepSeek-V4.1-Flash 离线推理，列出的硬件是 NVIDIA SM100 和 Huawei Ascend 950；完整 KV 缓存系统、E/P/D 分离服务及跨 DP 负载均衡仍不包含在本次开源范围。因此不能把 DeepInfer 当成已可直接替换 vLLM/SGLang 的通用在线服务，也不能据此承诺 H100/H200 或 Pro5500（型号待核实）支持。

来源：https://api.github.com/repos/deepseek-ai/DeepInfer/commits?per_page=30
https://api.github.com/repos/deepseek-ai/DeepInfer/releases?per_page=10
https://api.github.com/repos/deepseek-ai/DeepInfer/pulls?state=all&sort=updated&direction=desc&per_page=30
https://github.com/deepseek-ai/DeepInfer/blob/a679bb86ce36e883a98a97733492b686e5b9a08e/README.md
