机器人策略训练中，activation checkpoint 会在反向传播时重新执行部分前向计算。如果 MoE 路由的数值上下文改变，即使张量形状一样，也可能选中不同 expert。前向 loss 正常，并不能证明梯度沿着同一计算路径返回。

LeRobot **11 月 16 日 17:47 UTC** 合入 **#5328**，提交 `7910c20a7583`，修复 Praxis 训练和控制状态的几个相邻问题。

### 从 loss 到 checkpoint 重算

Praxis 前向 router 使用 **float32、关闭 TF32**，而 `lerobot-train` 的宿主上下文可能开启 TF32。补丁在 loss tensor 上挂接 hook，令反向传播和 checkpoint 重算重新进入 Praxis 数值上下文，并在完成后排队退出、恢复原标志。

**前向固定路由精度 → 得到 loss → 反向 hook 恢复相同精度 → checkpoint 重算 → 梯度回传 → 恢复宿主设置**。区别不在张量形状，而在路由决策能否复现；只比较前向 loss 或 shape 会漏掉这个问题。

### 动作窗口与保存状态也要一致

`predict_action_chunk` 可能返回 **21 个真实动作、补齐到 24 个**。下一帧使用的上下文应保留真实的第 0–20 项，不能机械截取最后 21 项变成第 3–23 项、把 padding 带入历史。此次修复不改变 `select_action` 的对应路径。

另外，合并 checkpoint 时保留基础配置原本的 device，而不是把加载时 CPU 上下文写成模型配置；双臂原始 gripper 动作不再被强制裁到 `[0,1]`，单臂路径仍保持自己的裁剪规则。这些属于训练/控制契约，不能从一个机器人配置推定所有执行器量纲相同。

### 证据达到单步训练，没有达到工厂成功率

测试记录为 **H100、PyTorch 2.15/cu132、Transformers 5.22.1，147 passed、2 skipped**。真实 `praxis-1-droid` 的一次 **LoRA + 最后 MoE router**训练步占用约 **63.3 GiB**；前向 loss 一致，反向则比较了 `highest` 与启用 TF32 的 `high` 数值行为。

这足以说明为何需要修复训练数值上下文，尚不能推出长程收敛、更高任务成功率或制造现场收益。落地前应固定数据与动作归一化，验证多步梯度/路由稳定、padding 不进入控制历史、checkpoint 重载一致，再在目标机器人和安全边界下评测抓取或装配任务。本期对 GR00T、LeRobot、OpenPI 的入口分别核查；软件 agent 的训练内容没有混作工业机器人实验。

原始来源：[原始来源 1](https://api.github.com/repos/huggingface/lerobot/pulls/5328)；[原始来源 2](https://api.github.com/repos/huggingface/lerobot/commits/7910c20a7583)。
