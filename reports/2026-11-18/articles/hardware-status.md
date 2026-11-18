# 硬件与算力平台：SGLang-Neuron 预览版如何选择 Trainium

拿到一台 Trainium 机器，首先要确定准备跑的是 LLM 解码还是扩散模型。SGLang-Neuron v0.1.0 的支持矩阵按工作负载划分：LLM 的异步运行时面向 Trn3，列出的扩散模型运行在 Trn2。版本标签于 **11 月 12 日 21:38:32 UTC** 发布，距本期截止点 120 小时 41 分 28 秒，属于 168 小时扩窗材料。项目博客和 release 描述的是同一次发布。

上层沿用 SGLang 服务栈，设备侧使用 TorchNeuron、NKI 和按形状编译的执行路径。选机只是第一步：还要核对宿主驱动是否匹配 Neuron SDK 2.33.0、镜像是否匹配模型，以及编译产物是否覆盖预期形状。Kimi-K3 的硬件前提是 Trn3 UltraServer。该平台至少由两台经交换机互联的 trn3.48xlarge 组成。可按 v0.1.0 复现的长上下文 DSPARK 示例使用三台：一台执行 prefill，一个 decode 服务跨另外两台。其他拓扑、上下文长度或批量需要单独验证。

| 部署问题 | 已知条件 | 决策前应取得的证据 |
| --- | --- | --- |
| LLM 在线推理 | Trn3，异步运行时 | 用目标上下文和并发验证预编译形状、延迟与显存余量 |
| 扩散模型 | Trn2，限发行说明列出的模型 | 固定模型、输入形状、镜像与驱动，确认编译和执行均可重复 |
| 成熟度与成本 | 产品阶段为 Public Preview，GitHub 标签的 prerelease 字段为 false | 样例缺同负载的成本和 GPU 对照，选型仍需测量 |

**另一种硬件瓶颈出现在 CPU 沙箱。** LMSYS 的 11 月 13 日文章只有日期级署期，可作为平台选型的对照。实验两侧用同一模型和 8×H200 做推理，每个 CPU 插槽运行 176 个后台任务，Vera、Turin 两侧各观察五步、160 个 episode。在这个配置下，Turin 的平均 episode 耗时比 Vera 长 12%，Turin/Vera 的 90% 区间为 1.04–1.22。episode 包含等待模型与沙箱执行；即使沙箱更快，较长的模型等待仍会限制整步收益。五步不足以分辨小幅训练步差异，文中的 33% 是假设推理加速八倍后的推算。

这两份材料回答的是不同的采购问题。先用 Neuron 的发布矩阵筛出能运行目标模型的设备；遇到含工具调用或沙箱的训练负载，再分别记录模型等待、CPU 执行、episode 与整步耗时。现有数据不足以给出 Trainium 对 H100/H200 的通用性价比，也没有等质量训练耗时对照。

## 原始来源

- [SGLang-Neuron 版本与支持矩阵](https://api.github.com/repos/sgl-project/sglang-neuron/releases/tags/v0.1.0)
- [LMSYS 部署示例](https://www.lmsys.org/blog/2026-11-12-sglang-neuron-v0.1.0/)
- [Vera/Turin 沙箱对照](https://www.lmsys.org/blog/2026-11-13-miles-vera-sandboxes/)
