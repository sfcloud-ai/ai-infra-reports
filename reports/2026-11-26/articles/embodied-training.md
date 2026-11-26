# 制造业具身智能训练：LeRobot 修复双 GPU 训练中样本权重器读不到配置的问题

**72 小时回看。** LeRobot #5499 于北京时间 11 月 25 日 01:04 合入，早于本期 24 小时窗口的起点。作者在两张 GPU 上用 pi05 训练策略，开启 RA-BC 样本加权后，任务在构造权重器时就报错，未能进入预期的训练流程。[LeRobot #5499 的故障报告和合入记录](https://github.com/huggingface/lerobot/pull/5499)

## 权重器拿到的是哪一个对象

样本权重器通过 `policy.config` 获取策略配置。单设备上可以直接读到这个属性；在多设备训练中，`accelerator.prepare` 返回分布式数据并行（DDP）包装对象。原调用把包装对象传给权重器，读取配置时触发属性错误。

改动只位于构造权重器的调用点：先用 `accelerator.unwrap_model(policy)` 取得底层策略，再交给 `make_sample_weighter`。执行分布式训练的策略对象仍保留包装。对于从一张卡扩到两张卡的示教训练任务，这区分了两件事：权重器从哪里取得配置，以及梯度在什么路径上同步。[训练入口的实际改动](https://api.github.com/repos/huggingface/lerobot/pulls/5499/files?page=1&per_page=100)

## 作者验证到了哪一步

作者报告在双 GPU 启动器里应用相同改动后，原来的 pi05 加权训练得以运行。PR 没有新增多进程回归测试，也没有给出示教数据集对照、机器人任务成功率或生产节拍。评估自己的训练作业时，可先在相同策略及权重配置下核对双卡能否进入训练循环，再另外衡量加权后的策略表现。[作者的双卡验证及测试范围](https://github.com/huggingface/lerobot/pull/5499)
