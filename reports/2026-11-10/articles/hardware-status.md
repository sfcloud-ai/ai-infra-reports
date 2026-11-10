# 重点硬件｜R620 支持表与托管 MIG 的部署边界

本版补查 H100、H200、RTX PRO 5500 的驱动、平台互联与 MIG 支持范围。近 24–72 小时的所查官方来源中，没有筛出足以独立成篇的新 SKU 或互联公告；以下 11 月 4 日和 6 日的材料属于七日扩窗，不是今日新品新闻。

![GPU本身能力、驱动平台支持和云端服务支持需要逐层核验](assets/hardware-support.png)

## R620 LTS：支持表新增列项，不等于所有组合通用

[NVIDIA 11 月 4 日发行说明](https://docs.nvidia.com/datacenter/tesla/tesla-release-notes-620-70-06/index.html) 对应 Linux 620.70.06 / Windows 621.14。[驱动生命周期表](https://docs.nvidia.com/datacenter/tesla/drivers/supported-drivers-and-cuda-toolkit-versions.html) 将 R620 列为 LTS，支持至 2029 年 9 月。

相对已逐项对照的 [R615.71.10 支持表](https://docs.nvidia.com/datacenter/tesla/tesla-release-notes-615-71-10/index.html)，R620 的 RTX 表新增 RTX PRO 5500 Blackwell Workstation Edition。这个结论只限两份官方表格的差异，不能推断 R620 是所有驱动中首次能运行该型号的版本。

H100 PCIe/NVL、H200 NVL 以及 HGX H100/H200 在 R620 的相应平台范围内。八卡 HGX H100/H200 列的是 NVSwitch，四卡 HGX H100 列的是 NVLink，不能混成统一 H100 互联配置。普通 GPU 支持表也不自动证明每种 MIG、vGPU、虚拟化、操作系统和互联组合都已验收。

R620 机密计算的 attestation 流程有 ABI 变化，Attestation SDK 不能早于 2026.10.02；官方明确非 CC 用户不受这项变化影响。升级前还应核对 Hopper subrevision=3 的 VBIOS 不早于 96.00.68.00.xx，并使用 DCGM 4.3.x 或更新版本。这两个条件在 R615 已存在，不是本次新发现的问题。LTS 标签本身不构成无条件升级建议，本期没有升级机器或运行驱动验证。

## RTX PRO 5500：精确型号已找到，原称仍不自动对应

[NVIDIA 当前产品页](https://www.nvidia.com/en-in/products/workstations/professional-desktop-gpus/rtx-pro-5500/) 给出的精确型号是 RTX PRO 5500 Blackwell Workstation Edition：84GB GDDR7 ECC、1398GB/s 显存带宽、PCIe 5.0 x16、最高 600W，MIG 最多两个实例、每实例最高 42GB。这是当前静态规格背景，页面未给本周变更日期，不另算新品或新 MIG 新闻。

既有重点中的“Pro5500”仍未由型号标签或设备信息确认，因此本期不把原称直接替换成这张卡，也不将上述规格套到未确认设备。页面没有陈述的互联能力不作反向猜测。

## SageMaker 的支持矩阵，不能由 GPU 规格倒推

[AWS 11 月 6 日公告](https://aws.amazon.com/blogs/machine-learning/sagemaker-inference-now-supports-multi-instance-gpu-to-maximize-gpu-utilization-for-model-endpoints/) 和[官方使用文档](https://docs.aws.amazon.com/sagemaker/latest/dg/inference-components-accelerator-partitioning.html) 列出：

- P4d：A100 40GB，最多七分区。
- P5：H100 80GB，最多七分区。
- G7：RTX PRO 4500 Blackwell 32GB，最多两分区。
- G7e：RTX PRO 6000 Blackwell Server Edition 96GB，最多四分区。

这份服务支持表未列 H200 或 RTX PRO 5500。GPU 硬件支持 MIG，不等于 SageMaker 此功能已支持该卡；G7/G7e 也不能写成 5500。

[NVIDIA profile 表](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/supported-mig-profiles.html) 中，H100 的 mig-3g.40gb 使用 3/7 计算与 4/8 显存。两个这种实例耗尽显存，不能再塞入第三个小分区。AWS 布局对同一 variant 中每台机器的每张 GPU 统一应用，不能把列表误读为逐卡独立指定。

运维方面还有显著缺口：分区端点及其组件不发布 GPU、CPU 或 memory utilization 指标，可用调用和延迟指标监控。P4d 的 mig-1g.10gb 需要选择满足要求的 al2023-ami-sagemaker-inference-gpu-4-1 镜像，这是 A100 特定 profile 条件，不推广到 H100 或 5500。地区、实例可用性及配额仍需按实际部署核对。性能与整实例费用分摊的前提见[模型服务与 GPU 超配](https://sfcloud-ai.github.io/ai-infra-reports/2026-11-10/model-serving-gpu/)。

## 本轮覆盖与仍未验证的部分

已读 NVIDIA 当前规格、两版数据中心驱动说明、生命周期、MIG profile，以及 AWS 发布和 Developer Guide；未实测任何卡型或云端点。AWS 示例代码未核验，不能据此称部署路径已完整跑通。既有 H200 LoRA rollout、dummy 八层状态实验和 H100 定向测试仍只对各自配置有效，GB300/B300/H800 结果不替代重点硬件验收。
