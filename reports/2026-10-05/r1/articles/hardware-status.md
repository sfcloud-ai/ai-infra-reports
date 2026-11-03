历史归档：原期次 2026-10-05，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

一组内核开源，并不意味着现有模型服务只换设备名就能运行。9 月末公布的 DeepSeek Ascend 相关栈，应分开看矩阵计算、专家通信和配套算子，再把各自的硬件与软件前提对齐。

DeepGEMM Ascend 提供计算入口，DeepEP Ascend 对应 MoE 专家通信，TileKernels 补充配套算子。先锁定同一组版本，才有条件讨论模型层集成、正确性和性能；把几个项目的峰值数字相加没有可比较的分母。[DeepGEMM 固定版本](https://github.com/deepseek-ai/DeepGEMM-Ascend/blob/8491bbb4b8c02a094a2318965f50c70438a3e73c/README.md)、[DeepEP 固定版本](https://github.com/deepseek-ai/DeepEP-Ascend/blob/3b25377d04b24fc6154698ded78a2bcb2c59afff/README.md)、[TileKernels 固定版本](https://github.com/deepseek-ai/TileKernels/blob/66258df6175d2f630ffecb04c5ab66bff8a2ae6a/README.md)

当期公开证据集中在 Ascend 950/950DT。通信成绩还依赖未公开发行的 PoC HDK，不能直接推成存量昇腾或普通 PCIe 机器的收益。源码可看、依赖可安装、目标硬件能运行，是三个不同的成熟度阶段。

更有效的适配入口是先拿到确切卡型、互联域、CANN/HDK 与模型精度组合，确认依赖闭合后，再跑单算子与整模型对照。单算子通过只证明局部路径可用；服务交付还要测加载、峰值显存、错误恢复、并发与尾延迟。若没有对应硬件和依赖供给，应先保留技术跟踪，不为开源事件新增一套长期维护产品线。
