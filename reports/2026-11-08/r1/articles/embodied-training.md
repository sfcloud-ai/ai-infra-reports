# 制造业具身：训练的掩码，要经得住部署算子

## GR00T修复H100长padding的NaN

把短指令与长指令放进同一个机器人推理batch时，短的一侧会补齐空位。掩码用于告诉注意力层哪些位置不是真实输入。训练时模型处理正确，并不保证导出后的TensorRT融合算子仍能在所有补齐长度下产生有效动作。

GR00T于 **11月6日23:42:30 UTC** 合入 [4d9f888](https://github.com/NVIDIA/Isaac-GR00T/commit/4d9f8886fcf3023ece9c5138b7ebfeffc40aedf7)，直接针对H100上长padding导致TensorRT融合attention连有效token也出现NaN的故障。此前晨报已讲过VL/动作padding隔离，本次增量是数值安全，而不是重新报道掩码开关。

### 改动怎样生效

导出路径将布尔“保留”掩码转换成加性偏置：有效位置为0，被屏蔽位置为当前计算dtype所能表示的最小有限值，避免负无穷。改动统一用于DiT自注意力导出钩子，以及预先缓存cross-attention K/V的路径。前者是动作token之间的注意力，后者把视觉语言上下文提供给动作生成。

使用最小有限值的目的，是在原计算精度中继续压低padding键的贡献，同时避开融合算子处理负无穷的故障；不能理解成“所有被屏蔽输出自动变为零”。上游视觉语言层和后续动作层仍须传递正确掩码。

同批 [VL隔离与TensorRT导出变更](https://github.com/NVIDIA/Isaac-GR00T/commit/8af93e5f793cc4601bef4cd956255167496b61c0) 为strict VL引擎增加attention_mask输入，运行时拒绝与checkpoint设置不匹配的引擎。11月7日的 [#802组合回归](https://github.com/NVIDIA/Isaac-GR00T/commit/9fbe86ad985f909d412165033267e9cff239b64c)进一步覆盖VL引擎mask与严格动作padding同时经过两条运行循环，比较PyTorch动作参考，并检查填充动作保持零。

### 怎样验收，不能推导什么

该修复的CPU回归直接捕获自注意力与缓存cross-attention收到的mask，要求所有值有限且最低值等于dtype最小有限值，并对有效样本与参考实现做容差比较。相关VL设备测试代码还覆盖BF16、batch2、序列7/10/287、长padding、CUDA graph掩码变化等条件。存在测试代码不等于本期在H100上重新执行了它，也不等于所有生产模型组合已验证。

交付时应固定训练checkpoint、strict设置、导出代码和TensorRT引擎版本，重建受影响引擎，测短/长指令混batch、padding扰动、有效动作有限性以及图回放后的mask更新。strict设置改变会改变输入契约，不能拿旧引擎继续跑；已发布checkpoint默认关闭strict，以保持既有策略行为，不应未经训练验证擅自开启。

这是部署正确性修复，没有提供训练加速、工厂任务成功率或服务吞吐收益。H100故障证据不能自动外推为H200或“Pro5500”的设备验收；制造业落地仍须对实际机器人动作范围、任务成功率和安全停止条件做现场验证。


![有限值掩码导出流程](assets/groot-finite-mask.png)
