# LongCat 2.5：专家分发前量化，复用 INT4 通信与计算

扩展至一周窗口。官方提交 f3ae0ad97209ef50b1a8941e285debbdfbca7155 于2026年11月5日07:07:30 UTC公开完整模型卡：与父版本对比，README由只有MIT许可证头的21字节扩展为27523字节，新增模型架构、量化和部署说明。本条绑定这个实质公开事件，不把11月10日仅修正HLE测试范围的维护提交当作新发布。

实际问题：专家混合模型（MoE）每次只调用部分专家，但仍要把token分发到不同设备。只缩小矩阵计算里的数值，未必同时减少专家间网络通信与数据转换开销。LongCat2.5是1.6万亿总参数、每token约480亿激活参数，不可按480亿计算全部权重驻留需求。

机制：对专家权重和激活做4位量化（W4A4），利用FlatQuant式可学习变换改善量化误差。关键是共享专家输入变换，在token复制和跨设备分发之前完成量化，使同一INT4表示在通信与专家计算中复用。融合变换、缩放、量化和打包内核，分别调优预填充与解码流水线，目标是减少数据搬运与通信。这个机制不是任意独立模型之间共享权重，也不是跨模型KV缓存超配。

简化机制图：输入token→共享变换/INT4量化打包→复制与专家路由→INT4跨设备通信→专家矩阵计算→聚合；在前面标“量化在分发之前”，下方标“NPU专用实现与对应内核，非所有GPU通用”。

![LongCat专家分发前量化流程](assets/longcat-flow.png)

实现核验：官方NPU部署说明来自 SGLang-FluentLLM 的 longcat-2.5-npu 分支，而不是SGLang上游默认支持。README描述 Atlas A2、194卡的编码/预填充/解码分离拓扑：编码2、预填充64、解码128。预填充PP8与AttentionTP8；解码KVP8、DP16、EP128。依赖CANN9、Python3.11、torch2.9、匹配torch_npu与torchair、HDK及ATB，flash_ops与flash_npu_kernel为不同内核组件，还需Mooncake/HCCL网络与权重路径配置。当前只读到了分支README，未独立锁定其commit并运行代码，不能声称可复现部署已经验收。

量化质量与性能：模型卡称评估任务质量与未量化版本相近，并报告相对W8A8吞吐、首token延迟和逐token延迟改善。但所读材料未给出足以独立还原所有数字的完整负载、并发和调优基线条件，因此本文仅解释机制，不引用43.3%等数字作为交付收益，更不推广为H100/H200上的收益。

上下文边界：配置文件max_position_embeddings为524288，而材料提到1M长上下文能力；在缺少对应部署配置验证时，不能承诺开箱1M。原生视觉使用残差向量量化把视觉特征变为离散token、与文本共享主干；离线视觉token预计算缓存也不等于服务端可共享KV。

价值：对国产算力上超大MoE交付，最值得关注的是量化点与通信路径的联合设计，而非仅比较bit数。真实采购评估仍需对目标硬件和负载测试精度、TTFT/TPOT、吞吐、显存、网络和内核维护成本。该示例194卡门槛高，不能包装成小团队轻量方案。


## 同板块检查与覆盖缺口

已查GLM、DeepSeek、Qwen官方模型列表，以及Qwen3.8-27B与DeepSeek-V4.1-Flash-1017提交记录。Qwen11/7与DeepSeek11/10所见为模板维护，相关方向此前已覆盖，不重复包装成架构新闻；GLM最新相关条目超一周。Z.ai博客404，Qwen博客完整文章覆盖未独立证明，不能据此断言无新进展。

## 原始来源

- [11月5日完整模型卡固定版本](https://huggingface.co/meituan-longcat/LongCat-2.5/blob/f3ae0ad97209ef50b1a8941e285debbdfbca7155/README.md)
- [发布前仅许可证头的父版](https://huggingface.co/meituan-longcat/LongCat-2.5/blob/ce55920fc00e3469968eeaf9f6829d1390f16260/README.md)
- [官方提交时间记录](https://huggingface.co/meituan-longcat/LongCat-2.5/commits/main)
- [NPU部署说明](https://github.com/meituan-longcat/SGLang-FluentLLM/blob/longcat-2.5-npu/npu_test/ReadMe.md)
- [官方11月10日中文介绍](https://tech.meituan.com/2026/11/10/Meituan-LongCat-2.5-Open-Source.html)
