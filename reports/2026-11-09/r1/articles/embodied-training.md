# 制造业具身训练｜GR00T 先减少等数据，再提高 GPU 利用率

2026年11月8日17:27:10 UTC，Isaac-GR00T 主线提交 [7aa0bca50f1097f8b17f5c274c98264b72a1419f](https://github.com/NVIDIA/Isaac-GR00T/commit/7aa0bca50f1097f8b17f5c274c98264b72a1419f) 新增 fast 训练数据加载器，并设为微调默认值。这项改动优先处理训练时 GPU 等待视频数据的成本；它没有改变机器人策略，也没有给出新的工厂任务成功率。

## 实际问题：训练只用部分帧，CPU 却可能解码整段视频

例如，一段操作录像只抽取部分时间步训练。原加载器仍会解码这些 episode 的全部相机帧，并等一整个 shard（数据分片）准备好才交给训练。多卡训练还会有多个数据 worker，各自让 FFmpeg 使用全部 CPU 核心，导致线程竞争；GPU 等数据时，加卡并不能自动增加有效训练量。

新实现保留原来的分片调度、样本提取函数和 processor，改变数据准备顺序：按 episode 划分可独立加载的小块；由小线程池连续解码；样本进入约一个 shard 大小的滚动随机缓冲区；训练从缓冲区抽样，processor 在消费线程依次执行。首次只填满约四分之一缓冲区就开始供数，之后每输出一个样本增加一个样本的目标缓冲量，直到上限。

## 三个改动共同减少等待

- 只解码采样时间步及其配置的视频偏移实际访问的帧。允许 padding 时索引夹到真实 episode 长度，不直接相信可能偏长的元数据。
- 边加载边输出，取消“整片读完才能训练”的屏障。默认每 worker 两个 episode 解码线程、每个视频解码器一个 FFmpeg 线程，减少主机线程超卖。
- 缓冲区补充按已服务样本数触发，不按哪个线程先完成触发；给定 seed 的顺序可重现，异步完成时序不会随意改变取样次序。

这不是与旧加载器逐 batch 等价：样本集合保持，但不同数据集混合更充分，epoch 边界最多有约一个缓冲区的样本跨越。精确复现实验或断点续训时，应记录 loader、seed、缓冲区与线程设置；不能只记录训练 epoch 数。

## 性能证据与落地条件

[固定提交 README](https://github.com/NVIDIA/Isaac-GR00T/blob/7aa0bca50f1097f8b17f5c274c98264b72a1419f/README.md) 给出的结果是完整 BridgeV2、8×H100 上训练约快5倍。但该说明没有完整 CPU/存储、batch、精度、训练步数和策略质量对照，不能当作任意制造业数据集的5倍承诺。收益主要应在解码和输入等待明显的训练任务上验证，不是推理延迟或工厂任务成功率指标。

代码已进入主线；本次读取的 release 列表未给出包含此提交的稳定包。新增测试覆盖逐样本一致性、短于元数据的 episode、跨 epoch 重排上界、解码抖动下顺序重现和 worker 无分片时明确报错，属于可读的测试证据，不代表本次执行了这些测试。

建议用同一 checkpoint、数据子集、seed 与训练步数，对比 fast/stock 的数据等待、CPU线程、主机内存、GPU利用率、每步耗时和最终任务指标。保留 `--data_loader stock` 回退；小数据或原本计算饱和的任务未必受益。其价值是降低输入流水线造成的闲置成本，而非改变模型权重或 KV 超配机制。

来源：[实现](https://github.com/NVIDIA/Isaac-GR00T/blob/7aa0bca50f1097f8b17f5c274c98264b72a1419f/gr00t/data/dataset/fast_sharded_dataset.py)、[测试](https://github.com/NVIDIA/Isaac-GR00T/blob/7aa0bca50f1097f8b17f5c274c98264b72a1419f/tests/gr00t/data/test_fast_sharded_dataset.py)。


![GR00T数据加载：依据代码的原创简化图](assets/groot-loader.png)
