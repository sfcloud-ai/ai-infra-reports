# 硬件与算力平台：H100 上的 MXFP8 路径为何影响 DeepSeek‑V4.1 的权重加载

北京时间 11 月 24 日 04:02，#69446 合入主线（`822bbd5`）。vLLM #69446 处理 H100（SM90）在 TP1 下的 MXFP8 线性层选择。原问题报告在 8×H100、TP1/DP8/EP8 上看到每卡权重加载内存从 47.67 升到 60.21 GiB。补丁在 SM90、TP1 且由系统自动选择 MXFP8 后端时保留平台原有的 MXFP8 内核，避免默认保留 BF16 权重和打包 FP8 副本。TP2 及以上、显式指定后端和其他架构沿用各自路径。[实现差异](https://github.com/vllm-project/vllm/pull/69446/files) [问题报告](https://github.com/vllm-project/vllm/issues/68647) · [补丁作者说明](https://github.com/vllm-project/vllm/pull/69446)

作者的复现保留稠密层形状，使用 dummy 权重，把路由专家从 384 缩到 8，并关闭 Engram。普通 dummy 权重的 UE8M0 缩放因子是随机值，会让 `pack_for_gemv` 拒绝打包。作者在测试中先用 `scales.fill_(120)` 把缩放因子统一设为 120，旧版自动路径才生成用于 GEMV 的 FP8 权重副本。在这个设置下，H100 TP1 的加载内存由旧版的 28.37 GiB 降至补丁后的 17.52 GiB，实测差值为 10.85 GiB。作者对原八卡配置的估算是计入 MTP 和 Engram 后每卡节省约 12.4 GiB。部署时要验证这个数，应在原八卡配置上用完整权重重测，并分别记录加载占用与推理时的峰值。[复现配置和测量表](https://github.com/vllm-project/vllm/pull/69446)
