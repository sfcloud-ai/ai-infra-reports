Isaac-GR00T 的 `JointActionChunk.interpolate` 与 `EndEffectorActionChunk.interpolate` 辅助 API 会在插值前过滤不递增的时间戳。连续倒退时，旧逻辑可能留下仍然乱序的点，使关节插值采用过时样本，或令末端姿态的旋转插值失败。本次证据证明的是这两个动作插值 API 的修复，尚未证明标准训练数据管线调用它们，不能表述为训练标签已得到修正。

主线 **11 月 10 日 18:35 UTC** 的 `3b49067943eb1ab2eb2203b93d461c4390c78da3` 采纳了这一实现，属于七日扩展窗口。相关外部 #809 为 **closed、merged_at=null**；不能说该 PR 已合并。

### 一个连续倒退的例子

对于时间戳 `[0,3,1,2,4]`，旧逻辑删除 1 后会留下 `[0,3,2,4]`，仍然倒退。新逻辑利用 `numpy.maximum.accumulate`，相对此前保留的最大时间戳判断，删除 1 和 2，并同步删除它们对应的姿态。

已核实的辅助 API 路径为：**动作 chunk 的时间戳与姿态 → 过滤非递增样本 → 保持时间与姿态对齐 → 在目标时间点插值 → 返回动作 chunk**。关节值和末端位置采用线性插值，末端旋转采用 SLERP。这里的输出是插值后的动作数据；不能据此认定它已进入训练标签生成流程。

### CPU 验证与训练用途边界

新增回归直接构建 `JointActionChunk` 和 `EndEffectorActionChunk`，调用 `interpolate`，检查关节值、末端位置与旋转。测试覆盖正常递增、连续倒退，以及倒退后出现重复时间戳的情况。PR 记录的验证使用 NumPy/SciPy 与 CPU，包括 Python 3.12、macOS ARM64 环境；本期没有复跑这些测试。

这不是标准训练管线的端到端验证，也没有给出 GPU 训练收敛、真实机器人任务成功率或工厂闭环数据。若自有示教重采样或数据清洗工具显式调用这些 API，此修复可能有助于避免其中的时间与姿态错配；需要先确认调用链，再用真实示教记录验证过滤前后关键动作是否丢失。训练预处理是可能应用，已接入标准训练流程及其收益仍未得到本批证据证明。

若时钟或采集源持续乱序，还需修复采集链；不能用过滤掩盖大范围时间同步问题。本期也核查了官方训练资料与项目变更，此前已报的 fast loader 没有再次包装成新消息。

原始来源：[原始来源 1](https://api.github.com/repos/NVIDIA/Isaac-GR00T/commits/3b49067943eb1ab2eb2203b93d461c4390c78da3)；[原始来源 2](https://api.github.com/repos/NVIDIA/Isaac-GR00T/pulls/809)；[原始来源 3](https://raw.githubusercontent.com/NVIDIA/Isaac-GR00T/3b49067943eb1ab2eb2203b93d461c4390c78da3/README.md)。
