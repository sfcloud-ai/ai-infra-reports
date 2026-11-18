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

**代码与文章的检索范围。** 在截至 11 月 17 日 22:20 UTC 的 24 小时内，默认分支按 committer.date 可见的提交数为 vLLM 91、SGLang 100。两仓的 PR 列表分别只读取按更新时间排列的前 20 项，不能由提交数推出所有 PR、后续回退或博客均已核完。DeepInfer 官方技术文章的全窗目录仍缺。四类跨仓发现也只记录了本期 24 小时范围，不能替代扩窗文章的检索记录。

## 原始来源

- [vLLM #64109](https://api.github.com/repos/vllm-project/vllm/pulls/64109)
- [SGLang #50712 服务 A/B](https://api.github.com/repos/sgl-project/sglang/pulls/50712)
- [队列修复的合并代码](https://api.github.com/repos/sgl-project/sglang/commits/372b35034dbf3855044eb9a52a7fa7477c39cc1b)
- [SGLang #46190 实验条件](https://api.github.com/repos/sgl-project/sglang/pulls/46190)
- [自适应验证合并代码](https://api.github.com/repos/sgl-project/sglang/commits/4b9f9043faee0eb8824c47aaaaeee8f29c5af35e)
- [本期读取的 DeepInfer PR 列表](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls?direction=desc&page=1&per_page=20&sort=updated&state=all)给出 [#288](https://github.com/deepseek-ai/DeepInfer/pull/288) 的 base `a679bb86ce36e883a98a97733492b686e5b9a08e` 和 head `02c3ba2cc6fdc4199ced0caab2f8f24b912883f5`。可用[这两个提交的固定比较](https://api.github.com/repos/deepseek-ai/DeepInfer/compare/a679bb86ce36e883a98a97733492b686e5b9a08e...02c3ba2cc6fdc4199ced0caab2f8f24b912883f5)复现本期代码范围。该比较地址由原列表提供的官方模板和两个 SHA 生成。
- [DeepInfer #288 diff](https://github.com/deepseek-ai/DeepInfer/pull/288.diff)
- [SGLang Inkling 正文](https://www.sglang.io/blog/inkling-2-small-day0-support)
