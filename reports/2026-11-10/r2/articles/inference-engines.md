# 推理引擎每日变动｜页回收、主机表去重与导入页晋升

vLLM 本期合入 CPU PLE 表去重和 HiSparse 导入页晋升；SGLang 将 PP 完成事件直接接到本 rank 的 forward。三项变化都影响内存预算或物理页何时可安全复用。下文时间统一按北京时间，合入 main 与进入正式发布包分别表述。

![内存优化分属主机副本、GPU与host搬运及物理页生命周期三层；原创机制简图](assets/memory-lifecycle.png)

## vLLM

### CPU PLE 表：先消掉卸载后重复的主机内存

[vLLM #60390](https://github.com/vllm-project/vllm/pull/60390) 于 11 月 10 日 00:16 合入 main。PR 虽然早在 10 月建立，新进展是收缩范围后的实现终于合入。

Qwen4Exp 原来会让各 DP rank 分别保留 CPU-offload 的 PLE 表。现在，开启 dp_shared_memory 且关闭 embedding_across_dp 时，在同一个 engine 的 node-local DP group 内，各 rank 映射同一份 /dev/shm 表，只有 leader 加载权重，再由组内同步保证可读；查询仍走 pinned UVA 路径。embedding_across_dp 将词表行分给不同 DP rank，不适用此处的相同表去重。共享内存不足、映射失败或 CUDA 注册失败时，整组退回每 rank 私有表，避免只有一部分 rank 共享。

作者在 4×GB300、Qwen3.8-Flash-Next FP8、DP4+EP 上报告，服务占用的主机内存由 307.8 GiB 降至 100.1 GiB。节省量大于三份 48 GiB 表，原文认为这与私有 pinned allocation 的粒度有关。吞吐和 TPOT 的单次测试差异均在 1.4% 内，因此主要收益是内存去重，而非明显加速。

范围必须说清：这次只共享同一 engine 内同节点的 DP 副本。独立 prefill 与 decode engine 仍各留一份；早期跨独立进程的文件共享模式已从本 PR 移除。实现针对 NVIDIA，以上数值也不能当作 H100/H200 实测。

对权重卸载与超配容量规划，host RAM、pinned memory 和副本数同样要计入预算。把数据从 GPU 搬到 CPU，并不会自动消除重复占用。

### HiSparse：导入页晋升也要核算首 token 代价

[vLLM #65888](https://github.com/vllm-project/vllm/pull/65888) 于 11 月 10 日 06:39 合入 main。它保留现有 NIXL 导入路径：P/D 导入的 KV 仍先落在 HiSparse host tier。导入完成后，如果 GPU 池在 transition watermark 以上还有空闲块，就将导入页晋升为 GPU resident pages，并把每步的 host-to-device 拷贝批处理。

这避免为同一目标再修改 NIXL。补丁也覆盖取消边界：请求 abort 后，排队的拷贝仍可能写目标页，因此源页和目标页要等传输完成后才能回收。

作者在两节点、每节点 TP4 的 GB300 上测试 GLM-5.3-NVFP4，采用 1P1D 和 MultiConnector[NIXL, HiSparse]。64K 多轮、并发 8 的一组结果中，ITL p50 从 11.36 ms 降到 10.40 ms，但 TTFT p50 从 1469 ms 增到 1954 ms；NIXL 传输字节量保持原来的 1 倍。

这组取舍比单独说“decode 更快”更有参考价值。导入后多做一次晋升，可以减少后续访问 host 的成本，也可能增加进入 decode 前的等待。是否划算，要同时看长会话长度、首 token 目标、GPU 余量和拷贝成本。尚无对应 H100/H200 实测。

两项均已合入 main；已读 release 数据不足以证明它们已经进入稳定安装包。验证时应分别检查同一 engine 的 DP 内存去重，以及长会话 P/D 导入的 TTFT、ITL 和 abort 回收边界，不能把两项结果直接叠加。

外置 KV connector 的访问能力声明仍处于 open PR，接口已演进为 KVCacheAccess flags，详见[模型服务与 GPU 超配](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/r2/model-serving-gpu/)。本期 vLLM 提交列表仍缺北京时间 11 月 9 日 10:19–12:48 的早段分页，其他部分 PR 详情也未核验；本篇只对已取得正文与 diff 的事项作结论。

## SGLang

### PP 收到输出，也要等本地 forward 完成

[SGLang #49386](https://github.com/sgl-project/sglang/pull/49386) 于 11 月 10 日 09:07 合入 main。这是昨日 #48852 延迟释放机制的一项后续完善：判断物理页能否回到空闲列表，必须以本 rank 对该 microbatch 的访问是否结束为准。

补丁把收到输出和跳过输出两条路径的完成事件收敛到同一个 helper。记录事件之前，先等待该 rank 的 forward_done。收到结果的 D2H 路径在 copy stream 上等待；跳过输出的路径使用侧流，不给 scheduler 当前流增加依赖。这样，处理结果时同步的事件就直接覆盖本地 forward，而不再只依靠其他 stage 的收发顺序间接建立关系。

新增测试检查 received 与 skipped 两类结果的完成事件都排在本地 forward 后。官方测试评论报告 H100 的 PP、HiCache 和 sampling 定向测试，以及 H20 的 P/D 分离测试完成。这些是指定组合的定向测试，不代表所有组合的 CI 验收。

对统一 KV 池和超配调度，这个变化的价值很具体：释放可以先进入逻辑账本，真正重新分配物理页之前，仍要确认每个访问者已经结束。它不是新增容量或吞吐提升的证据。

### 待合入：streaming session 的缓存身份边界

[SGLang #49419](https://github.com/sgl-project/sglang/pull/49419) 于 11 月 10 日 08:50 提出，复核时仍 open。作者报告，同一 streaming session 跨 turn 改变 extra_key、cache_salt 或 LoRA 身份后再 abort，可能将同一物理 slot 放进两个缓存 namespace，继而发生错误复用或重复释放。

补丁在 session slot 上保存 namespace，拒绝不同 namespace 借用原 row；若借出后身份改变，abort 只释放未保护的 tail，不把原前缀重新插到新 key 下。当前证据是补丁与 CPU 回归测试，尚无端到端 GPU/生产复现，不能据此断言某个现有部署已经出现跨租户泄露。

它提示的是审查方法：缓存隔离不只检查 lookup key，还要沿 session 借页、abort、checkpoint、驱逐和回收一路检查身份是否保留。

混合模型 recurrent-state 淘汰的 open 提案与 Kimi K3.1 官方并行方案，统一放在[模型服务与 GPU 超配](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/r2/model-serving-gpu/)中分析，不重复计为新事件。SGLang 本期已读覆盖原始 24 小时窗口的 94 条提交；仍有其他重点详情读取缺口，不能据此宣称所有代码变动均已核查。

## DeepInfer

本期已读[发布列表](https://github.com/deepseek-ai/DeepInfer/releases)、[PR 列表](https://github.com/deepseek-ai/DeepInfer/pulls)、提交记录、官方 README 与[部署 Q&A](https://github.com/deepseek-ai/DeepInfer/blob/main/doc/inference_deployment_qa.md)。查询窗口内的 release 与 commit 列表为空，所见 PR 未选出新的高相关部署事项；Q&A 已在此前报道，本期不重复。

这只说明上述入口的筛选结果，不证明所有开发活动都无变化，也不代表 DeepInfer 已具备完整在线服务或 Hopper 兼容性。部署判断仍要逐项核对官方支持矩阵，不能因为同属 NVIDIA 就推断 H100/H200 可用。

## 时间与覆盖范围

原始新闻窗口为北京时间 11 月 9 日 10:19 至 11 月 10 日 10:19；本篇三个合入事件和 streaming-session 提案均在窗口内。#49386 是昨日 #48852 延迟释放报道的实质增量，不把原机制再算一次。详情核验在原始截止后补齐，状态以所链接 PR 的本期复核快照为准。
