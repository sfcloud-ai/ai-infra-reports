# 重点硬件｜先排查 Hopper 的 MPS GEMM 正确性

## CUDA 13.5 修复特定 MPS 限额下的错误结果

MPS 让多个进程共享同一张 NVIDIA GPU；GEMM 是神经网络大量使用的矩阵乘法。共享策略改变了执行资源，底层计算正确性也应跟着验证。

CUDA 13.5 于 **2026-11-04 18:46:07 UTC** 发布官方介绍（北京时间 11 月 5 日 02:46:07，HTML `datePublished` 与 `article:published_time` 一致）。对 H100/H200 部署最直接的变化不是 Rubin 性能，而是 cuBLAS 的一个 **Hopper 正确性修复**。[官方发布](https://developer.nvidia.com/blog/nvidia-cuda-13-5-brings-nvidia-vera-rubin-ga-support/)

官方 release notes §3.1.1 列出：MPS client 使用 `CUDA_MPS_ACTIVE_THREAD_PERCENTAGE < 100` 时，FP16、BF16、FP8 GEMM 可能得到错误结果；受影响范围限定为 `CUBLASLT_ALGO_CONFIG_ID = 66` 且 cluster 使用至少 4 个 CTA 的算法配置。问题自 CUDA 12.6 Update 2 / cuBLAS 12.6.3 引入，13.5 列为已修复。[cuBLAS 13.5 修复条目 6862950](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/)

**判断：**使用 MPS 给模型切算力时，吞吐和不 OOM 不足以证明安全，必须验证实际 GEMM 路径的正确性。这个问题不意味着所有 Hopper 推理都会错误，也不能从“模型在 CUDA 上运行”推定命中：推理栈可能走自定义 kernel，并未使用这一 cuBLASLt 算法。建议盘点容器实际加载的 cuBLAS 版本、MPS 限额和算法选择，针对真实矩阵形状做限额开启/关闭及修复版本的差分测试；不要只检查宿主机 `nvcc` 版本。

升级也要分开理解两条规则：CUDA 13.x 旧应用的 minor-version compatibility 可覆盖 ≥580 驱动；**CUDA 13.5 新功能和新平台要求能支持它们的 R620 或更新驱动**。二者不是同一个可用性承诺，升级前还须核对引擎 wheel、编译缓存和相关 kernel 的版本矩阵。[驱动兼容表与说明，§2.2](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/)

![Hopper MPS 特定 GEMM 问题的核查路径，原创简化图](assets/hopper-mps-check.png)

## MPS 资源借用不是透明显存卸载

同次官方发布增加 MPS v3 的加权时间片、SM 分区借贷、cgroup namespace 路由和内存计数轮询回退。时间片百分比控制的是每次运行多久，**不保证相同比例的 GPU 利用率**；可借出的 SM 需来自无附着 client 的可分享分区，不能把“模型进程空闲但仍连接”直接当成可借资源。[MPS v3 接口](https://docs.nvidia.com/deploy/mps/latest/mpsv3-interface.html)

与超配直接相关的边界在内存分区文档中更清楚：Linux cgroup v2、CUDA 13.4+、非 MIG 设备是基础条件。硬上限阻止分配；超过软上限只是候选，真实内存压力到来时 MPS 会终止超软限的 client/cgroup，再让申请方重试，**不是把权重或 KV 自动、安全地卸载到 CPU**。13.5 的 polling 选项补救通知不可靠，但增加每次驱逐决策的读取开销。MIG 不支持这一内存分区路径，managed/UVM 内存也有单独的计数限制。[内存分区与驱逐](https://docs.nvidia.com/deploy/mps/latest/mpsv3-memory-partitioning.html)

因此应把“正确性修复”与“新共享策略试验”分开验收。后者需要定义被终止请求如何恢复、每个模型独立的权重与状态预算、cgroup 退出时软限预留如何清理，并测试压力下的 OOM 与尾延迟。当前资料没有给出这些新策略在 H100/H200 多模型在线负载上的收益或 SLO，不能写成开启后即可安全提高超配率。

## Pro5500 型号仍待核对（静态资料复核）

11 月 1 日晨报已经确认存在对应 NVIDIA 官方页；本轮重新读取其[具体产品页](https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-5500/)和[桌面专业 GPU 官方目录](https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/)，两处都列出 **RTX PRO 5500 Blackwell Workstation Edition**：84GB GDDR7 ECC、1398GB/s、PCIe Gen5 x16，产品页说明最多两个 MIG 实例。

这是既有型号资料的复核，不是一条新增进展。**日常简称 Pro5500 是否指这一具体 SKU，仍需核对完整型号**，因此不能仅凭简称套用规格或承诺软件兼容。产品页没有可核实的发布时刻，不能将本次首次读到写成 11 月 5 日新发布，更不能把它的显存/带宽套到 H100/H200。MIG 是硬件分区，不是额外显存容量或透明超配。

H100/H200 的[官方 H100 页](https://www.nvidia.com/en-us/data-center/h100/)与[H200 页](https://www.nvidia.com/en-us/data-center/h200/)已核查，只作为静态规格和架构依据，不单独凑新闻。LeanSparse 的 4×H100 实验见模型服务栏；本轮没有将它的收益外推至 H200 或 Pro5500。
