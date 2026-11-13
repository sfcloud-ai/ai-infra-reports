# 硬件适用边界：不把新平台吞吐外推到H100/H200

**本栏为覆盖状态，不计作新闻。** 已读取[NVIDIA官方技术博客发现页](https://developer.nvidia.com/blog/)，但没有取得相关硬件文章的完整正文和实验条件。因此本期硬件方向核验不完整，不能写成“无新进展”。

本期[Inkling引擎适配](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-13/model-serving-gpu/)所见GB200、GB300和VR200性能分别有负载、并行和计量限定，不能直接用于H100/H200报价或交付SLO。SGLang文章列出H200的部署recipe，但本期未逐条验证精度、卡数、依赖和内存条件。Pro5500（型号待核实）与该模型的兼容性未核，不猜规格。

下一步应在目标硬件确认完整权重大小、KV与运行状态占用、并行拓扑和实际请求P99延迟，再形成容量承诺。[SGLang原文硬件段](https://www.sglang.io/blog/inkling-2-small-day0-support)仅提供核查起点，不替代这些验证。
