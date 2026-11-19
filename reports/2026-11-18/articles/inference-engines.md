# 推理引擎每日变动：解码队列、推测验证与异构缓存布局

同样表现为“解码慢”，原因可能完全不同：请求可能卡在等待释放的页上，也可能为很难被接受的推测 token 付出验证成本。另一类问题出现在移植后端时，主缓存与索引器缓存的数据布局根本不同。下面分别看 vLLM、SGLang、DeepInfer 的具体代码路径。事件日期按 UTC。

## vLLM：长前缀不必撑大滑窗草稿缓存

11 月 17 日合并的 #64109（`8c9e6f91`）改变了滑窗草稿缓存的分配。规划器保留 DFlash/DSpark 滑窗草稿管理器时，只给尾段分配物理 KV 块。此时缓存管理器按真实请求末端判断前缀命中，并在外部加载时只给尾段分配。连接器沿用已有的跳空块逻辑。完整机制与容量边界见本期《模型服务与 GPU 超配》。这一改动在本期只计为一个事件；复现应固定合并提交，并在准入、命中、传输三个阶段记录实际分配。

## SGLang：先让已在途的传输完成

#50712 于 11 月 17 日 21:43:54 合并（`372b35034dbf3855044eb9a52a7fa7477c39cc1b`）。旧实现看到待恢复队列非空就提前返回，已经传完、尚未被接收的请求继续占页和解码预留，等待中的请求也就腾不出空间。补丁在暂缓新预分配的同时，继续轮询解码侧的传输队列，使已完成的传输可以被消费。

作者在 GB200 上用 Qwen3-0.6B、一个 prefill 实例和一个 decode 实例、Mooncake TCP 各做一轮对照。旧服务健康检查持续返回 200，请求却在 360 秒内未完成；补丁侧请求完成。这个结果支持进展性修复。监控应一起看请求是否完成、被撤回请求数和预留页能否回收。RDMA、TP 大于 1 以及长期吞吐没有同组数据。

另一项 #46190 于 11 月 17 日 21:24:30 合并（`4b9f9043faee0eb8824c47aaaaeee8f29c5af35e`）。DFlash2 用选择器每一行的最大概率估计接受率，再让 DSpark 规划器按请求决定验证长度。cap-accept 验完整块后限制接受数量；compact 则先打包，再按 token 数量所在的档位回放 CUDA 图。若最短方案仍落入同一档图，小批次可以省掉预算计算。

作者在旧分支上用 GB300、Qwen3.8-27B 和 DFlash2 block-8 比较了解码吞吐。这里的解码 token/s 取每请求首个 token 之后的生成速率，再乘配置的并发数。首 token 等待时间另计。两张表的 compact 列都叠加了 #46189 的 packed GDN 验证，静态列是各自的对照。单独使用 #46190 时，这个 GDN 模型会拒绝启动 compact。TP1 的运行请求上限设为 128，并发恰为 128 时，由静态的 8,141 升至 compact 的 9,622 token/s。作者指出，把上限设在实测并发处会抬高读数，对 compact 的影响略大。TP4 的上限为 512，并发 16 时则由 6,754 降至 6,167 token/s，下降 8.7%。更新到上游版本后没有重跑 GPU。

输出另用 T=0、并发 1 的 cap-accept 检查。预算固定为整块时，12 个提示均与静态验证逐 token 相同；预算收紧到 50% 时只有 4 个完全相同。部署时应在实际并发、图档及支持变长打包的后端上分别测量吞吐、延迟和输出。这个自适应路径不支持 attention DP。

另读到 11 月 12 日署期的 SGLang Inkling 文章。文中的 594B 总参数与 17B 激活参数是两种口径；GB300/VR200 各四卡、8K 输入及 1K 输出场景中的 3.5 token/步是模拟值。这项补读限定了该文能支持的事实；不能据此声称测得真实模型的接受长度。

## DeepInfer：在审提案拆开主 KV 和索引器记录

#288 于 11 月 17 日 06:59:12 创建，截至本期截止仍为 open。Ascend A2/W4A8 提案为两条状态路径规定不同布局。主/SWA 的 int8 记录每 token 656 字节，由 512 字节量化值、128 字节 BF16 RoPE 和 16 字节 scale 组成；索引器每条 132 字节，由 128 字节量化值和 4 字节 scale 组成。主缓存的 BF16 兜底为 1,152 字节，int8 页要求 block size 是 16 的倍数。

作者环境为 8×910B3、CANN 9.2.0、Python 3.12、torch_npu 2.13.0.rc1。对这份涉及 111 个文件的提案，本期只采用与上述布局直接相关的 diff。主线说明列的是 SM100/Ascend 950 的离线路径，当前开源实现缺完整 KV 系统、分离部署和负载均衡。讨论上线前，先验证固定 PR head 的数值对齐、图回退和页边界，再核对 MTP 与视觉语言任务。A5、GPU 以及 H100/H200 均没有这组真机结果。

## 同期合入的五项补查

这些提交都出现在原日期窗口保存的默认分支清单中。11 月 19 日补读了各自的 PR、文件差异和合并提交。

| 变更 | 适用范围与工程含义 |
| --- | --- |
| [vLLM #61051](https://github.com/vllm-project/vllm/pull/61051) | CUDA 路径使用 Triton 直接搬运连续字节段，省去批量收集源块的临时显存。这条路径要求源块和目标块的编号没有交集，遇到链式拷贝会触发断言。CPU 和 XPU 等其他设备沿用索引拷贝。作者在 GB200、CUDA 13.0 上验证。 |
| [vLLM #67966](https://github.com/vllm-project/vllm/pull/67966) | 在可扩展 KV 缓存的启动路径，缩容会解除部分块的映射。此次修复在容量预热前清零块表里的陈旧索引。故障最初出现在使用 ROCm AITER 的 MI355X 上，触发测试为 EAGLE 最大长度测试。 |
| [SGLang #44447](https://github.com/sgl-project/sglang/pull/44447) | Qwen3.8-Flash-Next 在共享 CP/TP 的 prefill 组内分片全注意力 KV 页时，需要启用 `--enable-kv-cache-sharding`，并使 decode 侧的 attention TP 宽度与共享组匹配。decode 从多个 prefill rank 接收 KV，辅助状态由匹配的 rank 发送，涉及 Mooncake 和 NIXL。PR 未提供同条件测速。 |
| [SGLang #50771](https://github.com/sgl-project/sglang/pull/50771) | NVIDIA Mega-MoE 在模型权重就位后停止 DeepGEMM 的 MLOPart 辅助进程，再估算 KV 容量。程序最多等 5 秒让相关 MPS 进程退出；超时会记录告警并继续启动，此时残余显存占用仍可能影响估算。 |
| [SGLang #50895](https://github.com/sgl-project/sglang/pull/50895) | 分离部署的 decode 侧把仍在运行请求的首个 token 和第一次 decode 输出一起发出。GB300 上 DeepSeek-V4.1/MTP 的多轮负载中，作者报告 p90 TPOT 降低约 3%–6%；首 token 会等待一次 decode，吞吐在运行噪声范围内。 |

**检索口径。** 原研究截止于 11 月 17 日 22:20 UTC。此前 24 小时的原始默认分支清单含 vLLM 91 条、SGLang 100 条提交。11 月 19 日按明确起止时间补查 GitHub 的公开 PR：vLLM 有 191 项在窗内创建、91 项合并，SGLang 分别为 199 项和 105 项；同一 PR 可以同时出现于两个集合。过去 24 小时的更新排序另受截止后编辑影响，不能把回查时看到的排序还原成当日快照。SGLang 当时的官方目录和随后保存的 Inkling 正文均署 11 月 12 日。[SGLang 官方博客](https://www.sglang.io/blog)

按保留的事件时间戳逐项核对，窗口内有活动的 PR 至少包括 vLLM 865 个和 SGLang 749 个。其余 349 个 vLLM 候选和 326 个 SGLang 候选缺少能落在窗口内的时间证据。其中 16 个 SGLang PR 出现在历史搜索结果里，但返回的更新时间已过截止点，已从确认数中扣除。DeepInfer 官方技术文章仍缺完整窗口目录。

## 原始来源

- [vLLM #64109](https://api.github.com/repos/vllm-project/vllm/pulls/64109)
- [SGLang #50712 服务 A/B](https://api.github.com/repos/sgl-project/sglang/pulls/50712)
- [队列修复的合并代码](https://api.github.com/repos/sgl-project/sglang/commits/372b35034dbf3855044eb9a52a7fa7477c39cc1b)
- [SGLang #46190 实验条件](https://api.github.com/repos/sgl-project/sglang/pulls/46190)
- [自适应验证合并代码](https://api.github.com/repos/sgl-project/sglang/commits/4b9f9043faee0eb8824c47aaaaeee8f29c5af35e)
- [本期读取的 DeepInfer PR 列表](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls?direction=desc&page=1&per_page=20&sort=updated&state=all)给出 [#288](https://github.com/deepseek-ai/DeepInfer/pull/288) 的 base `a679bb86ce36e883a98a97733492b686e5b9a08e` 和 head `02c3ba2cc6fdc4199ced0caab2f8f24b912883f5`。可用[这两个提交的固定比较](https://api.github.com/repos/deepseek-ai/DeepInfer/compare/a679bb86ce36e883a98a97733492b686e5b9a08e...02c3ba2cc6fdc4199ced0caab2f8f24b912883f5)复现本期代码范围。该比较地址由原列表提供的官方模板和两个 SHA 生成。
- [DeepInfer #288 diff](https://github.com/deepseek-ai/DeepInfer/pull/288.diff)
- [SGLang Inkling 正文](https://www.sglang.io/blog/inkling-2-small-day0-support)
