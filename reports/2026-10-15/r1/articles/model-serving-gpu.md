历史归档：原期次 2026-10-15，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

## 速度上涨，是否仍完成同样的工作

换模型、硬件或训练框架后，旧配置可能能启动，却浪费大量时间在通信、重算和同步上。自动调参有价值，但更快的候选也可能少做了工作、改变精度或漏算内容。ATTUNE 值得研究的不是让 agent 多试几个参数，而是把提出候选与独立验收分开。[论文 v1](https://arxiv.org/abs/2610.17528v1)讨论的是训练吞吐优化，不是推理引擎插件。

已有人工调优和公开配方是基线。ATTUNE 先固定模型、数据、输入长度、batch、精度与卡数，再读日志、诊断瓶颈、提出配置改动，运行短测试并记录成本。获胜候选还要核对实际生效参数与短期 loss，不能由 agent 自己挑一段最好看的速度作为成绩。[当期代码与工作规约](https://github.com/amazon-science/attune/tree/b1adde2f741353574ee6794b9f3b2c31516ccd94)

## 测量程序有用，强制执行仍有缺口

公开测量脚本默认跑 14 步，统计第 4 至 13 步，按总 token 数和总耗时计算速度，并核对完整时间窗口。参数检查则关注运行后实际解析的配置，而非只比较提交文本；未知参数按可能改变数值行为处理。这两点能减少暖机、缺步和隐含配置变化造成的误报。[测量脚本](https://github.com/amazon-science/attune/blob/b1adde2f741353574ee6794b9f3b2c31516ccd94/skill/scripts/read_metrics.sh) · [参数检查](https://github.com/amazon-science/attune/blob/b1adde2f741353574ee6794b9f3b2c31516ccd94/skill/scripts/correctness/layer1.py)

但“存在检查程序”和“未经检查绝不能交付”并非一回事。公开 parity 判定组合了参数与 20 步 loss 检查，部分工作量一致性仍只是报告项；停止逻辑不独立保证最终候选已有 parity PASS。GPU-hours 脚本负责记账，也不等于任务创建前的硬预算准入。当前公开包因此不能直接视作无人值守生产控制面。[判定程序](https://github.com/amazon-science/attune/blob/b1adde2f741353574ee6794b9f3b2c31516ccd94/skill/scripts/correctness/parity_verdict.py) · [停止逻辑](https://github.com/amazon-science/attune/blob/b1adde2f741353574ee6794b9f3b2c31516ccd94/harness/convergence.py) · [成本记录](https://github.com/amazon-science/attune/blob/b1adde2f741353574ee6794b9f3b2c31516ccd94/skill/scripts/run_gpuh.py)

## 结果支持受控试验，不支持替代最终验收

作者报告 GLM-4.5 在 128 张 B200、BF16、4K 序列配置下平均吞吐提升 33.9%，平均调参消耗约 669 GPU-hours；Mixtral-8×22B 的候选未超过噪声带，保留基线。对照是公开配方迁移到作者栈后的结果，不是人类专家针对该栈重新精调的上限。正确性门在 24 次故障运行中拦住 16 次、漏过 8 次，短 loss 检查显然不能证明长期训练等价。[实验与局限](https://arxiv.org/html/2610.17528v1#S3)

适合优先借鉴的，是离线版本适配流程：固定负载，保存实际参数与镜像，独立检查质量，明确预算与回退。接入推理服务还要重新定义 TTFT、逐 token 延迟、失败率和质量验收，不能照搬训练 loss 或吞吐百分比。先建可信基线和不可绕过的验收，再让 AI 提候选，最后才讨论无人值守。
