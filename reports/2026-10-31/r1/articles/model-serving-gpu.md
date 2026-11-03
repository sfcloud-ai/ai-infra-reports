历史归档：原期次 2026-10-31，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

缓存命中、多 token 草稿和模型休眠都能减少重复工作，但并不自动消除数据恢复、候选核验和运行上下文的成本。本期将 10 月 28–29 日三篇论文放在一起看：优化应针对真正留下的等待，而不是把已有能力重新包装。各项结论均保留当期研究边界。

### FlatCake：SSD 命中以后还要恢复

[FlatCake v1](https://arxiv.org/html/2610.38355v1)把小共享前缀放固定页 DRAM，长会话按 session、turn 内 layer-major 布局写 SSD；按请求所需的最慢介质排队，再合并文件偏移读取，经 GDS 进入 GPU 双缓冲并 scatter 到分页 KV。SSD 与 DRAM 是平级存储，不是 SSD 必须先回填 DRAM。

主实验为 8×B200、SGLang 0.5.19 与 Mooncake 0.3.13，重放 98,827 条公开 Claude Code trace 请求。1 QPS 时，相对 Mooncake，平均首 token 时间由 12.24 降至 7.57 秒，总 token 吞吐由 61.6K 提至 98.3K/s。吞吐含输入和输出，不是生成速度；Mooncake-GDS 对照在另一组 A100 长度扫描中，不是 B200 主实验基线。

布局、调度与读取同时变化，主负载缺逐项消融；当期也未核验到公开实现和多机服务实验。trace 长度由 hash block 数估算，不是精确 tokenizer 计数或 Claude 线上直接实测。因此应先量恢复延迟、读放大和排队，再判断现有 Mooncake/HiCache 是否真有缺口。[公开负载](https://huggingface.co/datasets/semianalysisai/cc-traces-weka-062126)

### TableTune：草稿长度必须配合真实执行路径

[TableTune v1](https://arxiv.org/html/2610.38968v1)在真实 vLLM 路径测批量与草稿长度成本，再结合在线接受率更新长度表。4×H100、两个 Qwen3-32B TP2 副本的 llm-d 实验中，高负载相对固定长度 3 吞吐提高 20%–32%，相对文档默认表提高 7%–25%，各三次运行。但对照均为投机配置，不能据此认定一定胜过关闭投机。

关键条件是 V2 为每个长度使用完整 CUDA Graph。默认 V1 改用分段图时，低负载反而损失 24%–34%；作者还观察到 nightly 长度 2→1 切换停顿，用 0/1/3 表规避。公开[代码与配置](https://github.com/asm582/tabletune)提供验证入口，但采用时要连同关闭投机基线、接受率变化和尾延迟一起测，不能直接搬表。

### PhOSv1：卸载权重后，context 仍会占显存

[PhOSv1 v1](https://arxiv.org/html/2610.39999v1)通过守护进程和 CUDA API 远程调用，让互相信任的引擎共享 context 与内核资源。单 A800、vLLM 0.19.1 下，23 个休眠模型的 context 占用由 25.67 降至 0.49 GiB，不含模型权重；16 模型平均唤醒由原生 sleep 的 4.89 降至 4.12 秒。长尾合成负载平均 TTFT 下降 87%，主要来自冷启动和排队减少，不能称为 decode 加速。

[公开实现](https://github.com/blitz-serving/PhoenixOSv1)当期不支持 CUDA Graph，共享引擎还需互信。额外进程、调用开销与故障隔离必须独立验证，各模型权重仍各自占预算。三项研究都应从现有调优强基线出发，仅在瓶颈与条件匹配时试验；论文倍数不替代完整请求质量、延迟和成本。本文未独立复现这些实验。
