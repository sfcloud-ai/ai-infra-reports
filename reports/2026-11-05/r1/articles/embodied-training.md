# 制造业具身训练｜GR00T 把训练掩码带进 TensorRT

同一段机器人观测，为什么会因同批次另一个任务的文字更长而改变动作？这类问题比平均推理时间更早决定批处理能否上线。Isaac-GR00T 在 **2026 年 11 月 4 日 23:11:50 UTC** 的两条公开仓库提交中，一方面修补视觉语言（VL）填充在动作头内部泄漏，另一方面把严格动作填充掩码接入 TensorRT。掩码是告诉模型“哪些补齐位置不能参与计算”的标记；TensorRT 是把模型转换为 NVIDIA GPU 高效执行引擎的部署路径。它们已进入 main，尚未发现包含这组改动的新 release。[VL 填充修复](https://github.com/NVIDIA/Isaac-GR00T/commit/bc5d21a2ea1d41306318486faac3c8992440b499) · [TensorRT 动作掩码支持](https://github.com/NVIDIA/Isaac-GR00T/commit/f4a9c89bb74d513612c4c3bc1d78a733ef6a4f63)

这更新了 11 月 1 日晨报中的一个具体限制：当时开启严格动作掩码的检查点只能保留 PyTorch 动作头，TensorRT 路径会拒绝运行；现在源码已补齐相应输入与循环处理。**不是旧训练开关的再次发布，也不是已完成工厂验证的部署方案。**

## 两种填充，分别守住什么边界

**VL 填充解决“同批任务互相影响”。** 不同指令长度需要左侧补齐。此前即便后面的 AlternateVLDiT 已屏蔽这些位置，前面的 VL 自注意力层仍可能先让填充影响真实 token。此次将注意力掩码传入该层，并在启用严格模式时要求其绝对位置嵌入为 None，避免补齐长度同时移动真实 token 的位置。普通 DiT 的交叉注意力也须保持相同语义。

README 给出的约 **2% 动作幅度变化**，测量条件是已发布检查点的动作头加合成骨干特征。这不是实机末端误差、工厂良率或任务成功率，不能据此估算产线损失。默认开关仍对旧检查点关闭，以保留原先的训练和服务行为。[当前配置说明](https://github.com/NVIDIA/Isaac-GR00T/blob/7b304f95b95790490b79bd263ba57015c3c12dfd/README.md)

**动作填充解决“无效维度进入控制计算”。** 不同机器人形态仅使用固定动作维度与时间窗口的一部分。严格模式不仅在输出时裁掉空白，还要在动作编码、DiT（扩散 Transformer 动作头）自注意力和每轮去噪更新中排除无效部分。此次 TensorRT 导出的 DiT 增加 hidden_attention_mask 输入，运行循环同步处理动作维度和时间步掩码，优化路径中的 CUDA Graph 缓冲也在每次调用时更新，避免沿用上一次形态的掩码。[实现与接口检查](https://github.com/NVIDIA/Isaac-GR00T/blob/f4a9c89bb74d513612c4c3bc1d78a733ef6a4f63/gr00t/deployment/action_padding.py) · [TensorRT 运行循环](https://github.com/NVIDIA/Isaac-GR00T/blob/f4a9c89bb74d513612c4c3bc1d78a733ef6a4f63/scripts/deployment/trt/trt_model_forward.py)

![GR00T 掩码契约的原创简化流程](assets/groot-mask-contract.png)

## 可以导出，不等于旧引擎可直接复用

新运行时会检查检查点的严格动作掩码开关是否与 DiT 引擎输入一致；两者不匹配就拒绝加载。因此切换开关后必须重新导出引擎，不能只替换配置文件。新训练是否启用，也应与最终服务路径一并决定。

另一个限制仍在：开启严格 VL 掩码时，VL 自注意力模块保留在 PyTorch，因为现有该模块的 TensorRT 图没有掩码输入；若使用普通 DiT 的 TensorRT 路径，含有 VL 填充的批次仍被拒绝，可以改用单样本调用或保留 PyTorch 动作头。**“支持严格动作掩码”不意味着所有模块都已纯 TensorRT 化，更不意味着任意长短指令混批都可用。**[VL 填充部署保护](https://github.com/NVIDIA/Isaac-GR00T/blob/bc5d21a2ea1d41306318486faac3c8992440b499/gr00t/deployment/vl_padding.py)

## 证据覆盖到哪里

新增测试覆盖三类契约：固定扩散噪声后，同一观测不因 1、5、17 个填充位置或更长的同批指令而改变动作；TensorRT 循环替身与 PyTorch 严格动作头保持一致；导出图含正确的掩码输入、开关不匹配的旧引擎被拒绝。动作掩码测试使用小型随机初始化动作头、CPU/PyTorch 引擎替身及 ONNX 接口检查，并非真实 TensorRT GPU 端到端测试。[VL 回归测试](https://github.com/NVIDIA/Isaac-GR00T/blob/bc5d21a2ea1d41306318486faac3c8992440b499/tests/gr00t/model/test_action_head.py) · [动作掩码回归测试](https://github.com/NVIDIA/Isaac-GR00T/blob/f4a9c89bb74d513612c4c3bc1d78a733ef6a4f63/tests/scripts/deployment/test_strict_action_padding_trt.py)

本轮核实到的 main [CI 运行](https://github.com/NVIDIA/Isaac-GR00T/actions/runs/41931761620)仅为 Python 3.12 lint 成功，不能写成这些回归测试已全部运行通过。这组提交没有给出 H100/H200 上开启掩码后的吞吐、p99 延迟或实机成功率；Pro5500（型号待核实）也没有可据此确认的适配结果。

## 对制造业平台的下一步价值

优先把训练配置、处理器配置、引擎接口和机器人有效动作范围放进同一份交付验收，而不是把“训练正常”和“TensorRT 能加载”分开签收。在受控离线回放里，固定随机噪声，交叉改变同批指令长度、有效动作维度与时间窗口，比较 PyTorch 和实际 GPU 引擎；通过后，再在带安全约束的实机任务中检查成功率与端到端尾延迟。

这是一项**同一模型的批处理与多形态正确性更新**，不是不同模型共享权重或 KV 的显存超配收益。它的直接价值是让训练时的动作边界不在部署转换时消失。

检索与去重：本轮读取 arXiv cs.RO 新近列表、GUILD/PyRUA-DataFarm 等一手论文，以及 Isaac-GR00T、LeRobot、openpi 的官方提交与发布入口；与截至 11 月 4 日的既往正文和去重索引比对。本条记为 11 月 1 日 GR00T 动作填充条目的实质更新。GUILD 是 11 月 3 日的 72 小时扩窗候选，本次未占正文；其实验室补采结果和代码入口缺口保留在研究证据中。

