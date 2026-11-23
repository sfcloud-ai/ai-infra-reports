# 制造业具身智能训练：LeRobot 在第二个 epoch 恢复时，读到的还是原来那些帧吗

北京时间 11 月 24 日 00:29，#5483 合入主线（`cf34255`）。检查点可以记对步数，却接着读取另一组样本。LeRobot #5483 针对 map-style 数据集：从 epoch 1 或之后的检查点恢复时，无论停在一轮的起点还是中途，采样器保存了 epoch 和起始位置，但准备数据加载器后，初始迭代计数又把采样顺序切回 epoch 0。偏移量仍然正确，对应的帧已经不同。修复在 `accelerator.prepare` 完成后，把检查点恢复出的 epoch 写回 `DataLoaderShard`。加载器和底层采样器从同一个 epoch 继续，随后按原有顺序配合恢复的偏移读帧。[实现和测试差异](https://github.com/huggingface/lerobot/pull/5483/files) [LeRobot PR](https://github.com/huggingface/lerobot/pull/5483)

作者在 CPU 上用同一小数据集做了两次训练：一组连续运行 14 步。另一组在完成第 12 步时保存检查点，此时恰好位于 epoch 1 起点，再从该检查点续跑到第 14 步。测试逐一比较续跑两步读取的帧索引与连续运行的对应结果。对会中断并继续的机器人轨迹训练，这个测试核对了数据顺序的可复现性。原件没有提供重训后的策略质量、实机任务成功率或产线结果。[测试说明](https://github.com/huggingface/lerobot/pull/5483)
