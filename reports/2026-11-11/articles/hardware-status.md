# H100、H200 与 RTX PRO 5500：本期硬件适用边界复核

**本页是 2026 年 11 月 11 日的静态规格与适用条件核对，不计入新闻条目，也不把无明确发布日期的产品页写成当天新发布。**

## RTX PRO 5500：型号已确认，不能套用其他卡的实测

[NVIDIA 官方产品页](https://www.nvidia.com/en-in/products/workstations/professional-desktop-gpus/rtx-pro-5500/)确认产品名称为 **NVIDIA RTX PRO 5500 Blackwell Workstation Edition**，配备 **84 GB GDDR7**，最多支持 **2 个完全隔离的 MIG 实例**，并介绍了机架部署方式。

MIG 可以把一张 GPU 划成隔离实例，但“支持隔离实例”和“多模型显存超配已经解决”是两回事。模型权重大小、KV 增长、每个实例的资源配额以及框架支持，仍决定能部署什么服务。本期没有该卡上的吞吐、尾延迟或独立模型权重与 KV 超配对照实验，不能用其他 Blackwell 卡的数据代替。此前已报道的 R620 支持信息也不重复当作新进展。

## H100 与 H200：产品规格不是服务收益证明

本轮已读取 [H100 官方产品页](https://www.nvidia.com/en-us/data-center/h100/)和 [H200 官方产品页](https://www.nvidia.com/en-us/data-center/h200/)。它们提供硬件背景，但静态规格不能单独证明某个新服务方案在这些卡上达到怎样的成本或 SLO。

本期 Evolving Infra 论文有明确的 H200 实验：64 张 H200、DeepSeek-V4-Flash、384 个 Claude Code 会话，在测试过的最佳静态预填充/解码配比之上，吞吐再提高 9%。该结论受模型、并发、并行方式和缓存配置约束，不是 H200 的普遍性能提升，更不是 H100 实测结果。

NVIDIA Snapshot 本期发布的基准使用 B200，没有本次核验到的 H100、H200 或 RTX PRO 5500 对照数据。因此，不能承诺把它部署到上述型号便获得相同恢复速度。

## 两个功能不能直接拼成已验证方案

RTX PRO 5500 产品页列出 MIG 能力，而 Snapshot 当前安装文档要求 **MIG disabled**。不能据此组合出“在 PRO 5500 的 MIG 实例中使用本期 Snapshot 加速恢复”的已验证交付路径。

实际采购和交付前，应按具体 GPU 型号、驱动、框架版本、隔离方式及模型配置做完整验证，测量从资源可用到服务可接流量的时间、稳态吞吐和尾延迟，再评估利用率与成本。
