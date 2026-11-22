# 硬件与算力平台：四张 RTX 3090 上，解码提速，冷预填充几乎持平

一套四卡工作站既要处理聊天，也要读长文档。升级后回答是否生成得更快，和读完一篇长文档要多久，可以在同一台机器上得到不同答案。11 月 21 日，Merlin Engine 发布提交记录了 3.0.2.2 的四卡对照，旧版是 3.0.2.1。两份测试卡给出了各自的请求长度和计时口径。[版本提交](https://api.github.com/repos/halt95/merlin-engine/commits/5522dd91266d42b628ba2ffab801b364ed5e384c) · [3.0.2.1 基线卡](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-12/Qwen3.8-27B-BENCH-CARD.md) · [3.0.2.2 测量卡](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-21/Qwen3.8-27B-BENCH-CARD.md)

| 客户端测量 | 3.0.2.1 | 3.0.2.2 | 怎么读 |
| --- | --- | --- | --- |
| 4,046 token 输入、thinking on，单流解码 | 262.0 tok/s | 315.5 tok/s | 三个有效请求的中位数，约高 20.4% |
| 同一解码行的首 token 时间 | 1.06 s | 1.06 s | 测试卡报告第一次请求的 TTFT |
| 261,888 token 冷预填充 | 2,115 tok/s | 2,118 tok/s | 每个深度一次请求 |
| 同一长输入的首 token 时间 | 123.8 s | 123.6 s | 仍需约两分钟 |

旧版卡的 3.0.2.1 数字取自 11 月 10 日构建的 `0.33.0+merlin.c56eeed392`。发布 wheel 有三个引擎文件与它不同，涉及本模型未启用的预填充调度。作者仅另做了一次输出抽查：温度 0、同一提示、单会话下，两份构建生成的 256 个 token ID 相同；表中的性能基线来自较早构建。[基线构建与一致性抽查](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-12/Qwen3.8-27B-BENCH-CARD.md)

## 测试条件决定数字能用在哪里

两版运行在同一台 4×RTX 3090 主机上，每卡限功耗 220 W，使用 PCIe Gen4、定制 P2P 驱动 610.43.02，没有 NVLink。模型为 Qwen3.8-27B，W4A16、FP8 KV、TP4、MTP K=4，启用 RecoverSSM。新版把四卡 P2P 解码设置设为默认。首 token 之前主要在处理输入，后续解码则反复跨卡协作；这组数据能把两段用户等待分开，无法单独定量每项设置的贡献。[配置和分项结果](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-21/Qwen3.8-27B-BENCH-CARD.md)

新版卡的一部分单卡、双卡行沿用了旧测。八路并发另按八条流同时活跃的重叠时段统计，不宜和单路一整次请求的速率直接换算。作者未公开原始流或启动日志。复测宜从同一引擎、驱动、拓扑和原始请求长度开始，再在目标卡上更换一个条件；H100、H200 和型号待核实的 Pro5500 均没有这份同配置实测。[基线采样说明](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-12/Qwen3.8-27B-BENCH-CARD.md) · [新卡的统计范围](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-21/Qwen3.8-27B-BENCH-CARD.md)
