# 制造业具身智能训练：换回训练指令，多少回合能碰到方块

一套策略在评估中连续 50 次没有碰到方块，问题可能出在送给策略的第一句话。对在 ALOHA 双臂移交数据上训练的语言条件策略，环境原先发的是 `AlohaTransferCube-v0`。训练示例里的文本则要求右臂拿起方块，再交给左臂。比较检查点前，应该先确认它收到的是哪一种输入。[LeRobot #5390 的复现](https://api.github.com/repos/huggingface/lerobot/pulls/5390) · [环境与默认指令的代码差异](https://api.github.com/repos/huggingface/lerobot/pulls/5390/files?page=1&per_page=100)

## 从任务 ID 到策略读到的文本

11 月 19 日合入 LeRobot main 的 #5390（`6707af9e`）为 ALOHA、PushT 增加了可覆盖的指令字段。默认文本取自参考数据集并预先写入 `_REFERENCE_INSTRUCTIONS`。运行时按任务 ID 查表，把结果设为环境的 `task_description`；也可以显式指定与自己的训练数据匹配的文本。这个流程不在每个回合读取 `tasks.parquet`。对于忽略语言提示的 ACT 和 Diffusion 策略，换指令不产生同一种输入变化。[配置映射和环境传参](https://api.github.com/repos/huggingface/lerobot/pulls/5390/files?page=1&per_page=100)

## 接触与完成要分两列

对照在 M1 Pro、MPS 上运行 ALOHA 模拟器。使用同一 SmolVLA 检查点、种子 1000、批量 10，每组 50 回合。研究者在同一版代码中显式传旧 gym ID 重现旧输入。旧文本下，接触与成功均为 0/50。改用数据集指令后，32/50 回合出现接触，2/50 完成移交，成功率的 95% 区间为 1%–13%。仅看最终成功会漏掉“已能碰到，但通常交接失败”这个诊断。这里换的是评估输入，未重新训练策略。[相同种子与检查点的两组观测](https://api.github.com/repos/huggingface/lerobot/pulls/5390)

![ALOHA 仿真每组 50 回合；旧任务 ID 时接触和完成均为 0，参考数据集指令时接触 32、完成 2。](assets/aloha-evaluation.png)

PushT 在本次改动中有配置和测试，以上成功数只对应 ALOHA。若要将这套评估方法用于装配工位，可先保存每次评估实际送入的任务文本，把接触、稳定抓取、移交完成分别标记，再在目标相机和实机上测节拍及失败类型。现有仿真没有提供工厂实机的成功率或周期。
