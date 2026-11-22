# 制造业具身智能训练：LeRobot 合入 NAT VLA，MuJoCo 重训复核抬升效果

北京时间 11 月 22 日，LeRobot 合入 NAT VLA 策略，独立项目 sim2real-vla 更新了 MuJoCo 重训记录。前者介绍策略如何生成供控制器执行的动作，后者记录策略在仿真中能否完成抬升。

## LeRobot 合入了什么

LeRobot #5416 加入基于 LFM2-VL 的 `nat_vla`。策略生成动作 token，NAT 分词器将它们解码成供控制器执行的动作。[合并说明与实验](https://api.github.com/repos/huggingface/lerobot/pulls/5416) · [策略、分词器和测试代码](https://api.github.com/repos/huggingface/lerobot/pulls/5416/files?per_page=100)

合入时，默认 NAT VLA 预训练权重和动作分词器尚未在 Hugging Face Hub 公开。[合入时的权重与分词器说明](https://api.github.com/repos/huggingface/lerobot/pulls/5416)

## MuJoCo 怎样检查重训后的策略

sim2real-vla 用归档配置重新训练离散策略。这一次重训在第 1,000 步的验证集主损失与原训练接近，但在 MuJoCo 仿真的闭环评估中，训练分布和留出集的抬升成功率都下降了。评估重训能否保留操作能力时，可以直接查两个切分的任务结果。[实验记录的提交](https://api.github.com/repos/OJ102/sim2real-vla/commits/2ad8e59935f536a1a4751304398cd16024496c2e) · [固定版本的任务与切分](https://raw.githubusercontent.com/OJ102/sim2real-vla/45f56372b3198ee11d41d84fc1bfc2e84a14b705/README.md)
