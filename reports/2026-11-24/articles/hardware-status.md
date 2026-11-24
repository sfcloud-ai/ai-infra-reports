# 硬件与算力平台：MI355X 如何从本地 NVMe 读回会话 KV

一段多轮会话回到预填充节点时，GPU 需要重新取得前几轮留下的状态。AMD 与 Embedded LLM 在 vLLM 官方仓库记录了 Kimi-K3 的一种部署方式。16 张 MI355X 分在两个节点上，一个节点用 8 张卡做预填充，另一个用 8 张卡做解码。两端各自采用 TP8 和 DCP8，KV 缓存使用 FP8。Kimi-K3 的池里同时保存 MLA 层的 KV 块和线性注意力层的状态检查点。[系统配置与模型说明](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-23-skip-the-dram-tier.md)

## 同一会话再次命中磁盘时，数据经过哪里

主配置中，每个节点装有两块 Micron 7450 PRO NVMe，每块 3.84 TB，分别格式化为 ext4，没有组 RAID。附录还记录了另一对节点上的无写缓冲复测：池使用两块 3.84 TB 的 XFS 盘，写缓冲设为策略允许的最小值 4 MiB。多数实验把池放在预填充节点。新写入的块先进入主机写缓冲区，随后落到本地盘。后续请求命中已经落盘的块时，UMBP 在 Linux 6.8 下通过 io_uring 发起直接 I/O，绕过 Linux 页缓存，先将数据读入 **16 GiB 主机暂存区**，随后再复制到 GPU。绕过页缓存后，读路径依然占用主机内存。估算这套机器能为会话留多少空间时，要分开计算盘容量、写缓冲区和读暂存区。[数据路径示意与实验配置](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-23-skip-the-dram-tier.md)

## 两种 RDMA 流量各自传什么

| 场景 | 搬运者与数据去向 |
| --- | --- |
| 预填充完成，请求转入解码 | 预填充节点通过 MoRIIO 把该请求的 KV 经 RDMA 发给解码节点。即使池只在预填充节点，这段传输也存在。 |
| 同一个存储池跨两个节点 | UMBP 自行通过 RDMA 在池节点之间搬运块。每个节点仍使用自己的本地盘，实验未使用 NVMe-oF 或共享文件系统。 |

核对类似部署时，可以分别计量磁盘命中后的读回、主机到 GPU 的复制，以及预填充到解码的传输。三者出现在不同环节，单看网络流量无法判断是哪一段拖慢了会话恢复。官方仓库文档只标注 **11 月 23 日**，本页记录其系统布局。16 张卡和两块盘是这组实验的配置，文章没有给出通用最低规格。[官方原文及附录](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-23-skip-the-dram-tier.md)
