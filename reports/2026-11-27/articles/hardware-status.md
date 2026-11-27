# 硬件与算力平台：H100 文件回载与 GB300 缓冲实验各测了什么

## 两组数值对应两套平台

| 测试 | 平台与条件 | 作者报告的结果 |
| --- | --- | --- |
| 文件 KV 回载 | 8 张 H100，Meta-Llama-3.1-8B，共享文件系统，inference-perf | 使用 GDS 回载时，inference-perf 吞吐超过对照两倍，口径未核定 |
| 稀疏索引缓冲 | 两台各四张 GB300，Kimi K3.1 Pro，TP8/DCP8 | 每 rank CUDA graph pool 从 9.10 GiB 降至 6.91 GiB，KV 缓存块数从 3551 增至 3762 |

H100 实验采用分层写入和 GDS 读回，保存的原文未写明吞吐单位，图表未单独复核。GB300 数据来自旧补丁对照，两组各启动一次，分别使用不同节点对。当前 PR head 未重跑 GPU，未测吞吐。报告范围限于这两套平台与配置，H200、其他卡型和不同文件系统的表现需要各自测量。[H100 实验](https://github.com/vllm-project/vllm/pull/66805) · [GB300 实验](https://github.com/vllm-project/vllm/pull/70178)

## 本期硬件来源的边界

本期读到了 NVIDIA 技术博客首页，可据此定位硬件和平台文章。首页本身不足以核定具体文章的窗口归属、测试基线或发布状态。本页状态记录只对应这次首页读取，表内数值由两项 vLLM 原 PR 支持。[NVIDIA 技术博客首页](https://developer.nvidia.com/blog/)
