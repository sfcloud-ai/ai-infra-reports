# 制造业具身智能训练：LeRobot 怎样避免把动作损失和文本损失记成同一个数

混合动作示范和语言指令训练策略时，一个 worker 可能只看到动作监督，报告 flow loss 为 2；另一个只看到文本监督，报告 text loss 为 8。旧版 LeRobot 按指标位置归并，两项可能都显示成 5。训练人员看到的异常来自日志归并。两边上报的指标数量不同时，集合通信还可能收到长度不同的张量。[问题与复现](https://github.com/huggingface/lerobot/pull/5460)

北京时间 11 月 24 日 15:14，LeRobot 合入 #5460。每个分布式日志窗口增加一次对象收集，交换指标名称、数值之和与观测次数，自动注册的策略指标再按名称和实际观测数求平均。某个 worker 独有的指标也能按原名出现在其他 worker 的日志里。调用方自行注册的指标仍按原设置取最大值、求和、平均或仅本地记录。需要跨 rank 归约的自定义指标，各 rank 仍须给出一致的名称和归约方式。[实现及回归测试](https://patch-diff.githubusercontent.com/raw/huggingface/lerobot/pull/5460.diff)

作者用两个实际 Gloo 进程验证。两个 worker 上报互不相同的指标时，两端都看到正确的 2 和 8。两端以相反顺序提交同名指标时，仍得到 flow 为 3、text 为 8。早期补丁另有双 H100、NCCL 的使用反馈；合并版在多机 NCCL 或大量动态指标下的日志耗时仍待测。[双进程验证记录](https://github.com/huggingface/lerobot/pull/5460)

这项修复让团队能按监督类型排查异常。补丁涉及日志工具和测试，原件未报告策略梯度变化、抓取成功率或产线节拍。复核自己的训练任务时，可以同时记录每个窗口的观测数和新增集合通信的用时。[补丁范围](https://github.com/huggingface/lerobot/pull/5460)
