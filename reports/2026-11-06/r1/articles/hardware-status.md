# 重点硬件｜规格复核与新进展筛选

本轮没有新增可以直接指导 H100/H200 升级或扩容的合格硬件事件。已读取 NVIDIA H100、H200 产品正文、RTX PRO 5500 产品正文和 CUDA Compute Capability 表；这些是静态支持资料，不按今天的新发布计数。昨天已报 CUDA 13.5 的 Hopper MPS/GEMM 修复，本期不重复。

Pro5500 继续保留用户原称，具体所指型号待核实。NVIDIA 既有官方页面列出 RTX PRO 5500 Blackwell Workstation Edition；该页面已在历史报告使用，本次只是复核，不是首次发现或首次补齐。页面规格为 84GB GDDR7 ECC、1398GB/s、PCIe Gen5 x16，CUDA GPU 表为 CC12.0。不能未经确认就认定用户的 Pro5500 一定对应这个 SKU，更不能据此承诺具体驱动、内核、RDMA 或引擎支持。MIG 的隔离划分也不等于显存超配。[产品页](https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-5500/) · [CUDA 计算能力表](https://developer.nvidia.com/cuda/gpus)

**有检索但排除的当日文章。** NVIDIA 在 2026-11-05 16:00 UTC 发表了 [Five Ways NVIDIA Co-Design Maximizes the Value of Every Byte in the AI Factory](https://developer.nvidia.com/blog/five-ways-nvidia-co-design-maximizes-the-value-of-every-byte-in-the-ai-factory/)。检索工具两次无法打开正文，但随后从原官方 URL 下载并读取完整正文成功，不属于最终来源不可读。文章把量化、Wide-EP、Dynamo 分层 KV、Vera 主机内存及 CMX 存储串成系统解释；其主要代际结果涉及 GB300/Rubin，不能外推 H100/H200。H100 上引用的 VAST/WEKA 传输结果和 Qwen 长提示恢复案例缺少在该文内完整展开的同负载端到端对照，也未证明它们是本窗口新实验，因此不作为今日新硬件收益入选。本文排除原因是新颖性/可迁移证据不足，不是网络失败，也不是证明相关技术没有变化。

本次 LMCache release API 和 ServerBench commit API 返回 HTTP 403，因此本栏不声称完成它们的完整发布/提交覆盖。ServerBench 论文正文和公开仓库 README 可读，已足够核实本次入选论文的机制、实验和现有复现入口。KVGuard 项目页尝试返回 503，不影响已读取的论文正文，但其官方代码可用状态仍未确认。推理引擎三家每日变动见对应板块，不从本栏空项推断它们没有更新。

**静态参照：** H100/H200 的具体 SXM/NVL 应分别记账；H200 官方规格为 141GB、4.8TB/s，不能把 H100 不同 SKU 统一当成相同 80GB/带宽。单模型论文只写“H100 80GB”时，必须保留其未说明 SXM/PCIe 的边界。[H100](https://www.nvidia.com/en-us/data-center/h100/) · [H200](https://www.nvidia.com/en-us/data-center/h200/)
