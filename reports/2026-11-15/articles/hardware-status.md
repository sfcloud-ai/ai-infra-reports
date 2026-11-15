AI 与科学计算共用 GPU 时，单看低精度 Tensor Core 峰值无法判断 FP64 工作负载是否受益。NVIDIA **11 月 13 日 22:13 UTC** 的 cuBLAS 技术文介绍 CUDA Toolkit **13.4.2** 的新路径：在满足精度条件时，用整数 Tensor Core 完成高精度矩阵乘的主要计算，再重构结果。

### 算法如何转换计算

Ozaki-II 把共享指数下的整数表示分解到互素模数，在各模数上执行整数 GEMM，再通过中国剩余定理重构。复数 **2M** 路径把通常的四次实矩阵乘减少为两次；两种机制分别针对表示与复数计算成本。

自动动态精度（ADP）根据精度需求选择路径；需求超出预算或矩阵形状不合适时，可以回退原生 FP64。它不是无条件把任意双精度程序变成整数程序，也不能忽略重构和调度开销。

### 两个 3.9 倍不是同一实验

文章给出 **GB200 上大形状 DGEMM 相对原生 FP64 最高 3.9 倍**，另有 **BerkeleyGW、Si998、32 GPU、53 位路径的端到端 3.9 倍**。前者是矩阵乘比较，后者包含具体应用路径，不能互相替代，更不能写成 LLM 推理加速。

对共享算力平台，价值在于把实际精度要求和矩阵形状加入资源选型。小矩阵、不同 GPU、不同容错要求需要重新比较原生 FP64 与仿真路径。文中的 GB200、RTX PRO 6000 Blackwell SE 等配置不能外推到 H100/H200；**Pro5500（型号待核实）**仍不能据此承诺兼容或收益。

下一步应以应用的误差阈值、实际形状分布和端到端时间验证，而不是用 Tensor Core 峰值或单个 GEMM 倍率替代应用结论。

原始来源：[原始来源 1](https://developer.nvidia.com/blog/faster-scientific-simulations-with-new-fp64-algorithms-in-nvidia-cublas/)；[原始来源 2](https://developer.nvidia.com/blog/feed/)；[原始来源 3](https://www.nvidia.com/en-us/data-center/h100/)；[原始来源 4](https://www.nvidia.com/en-us/data-center/h200/)。
