# 硬件与算力平台：RTX PRO 6000 的注意力内核快了 1.64 倍，整模省了多少时间

注意力分数占着寄存器，下一块的矩阵乘就得等。11 月 26 日 03:30 发布的 NVIDIA 技术文章给出了一个具体做法：在 96 GB RTX PRO 6000 Blackwell Server Edition（SM120）上，SageAttention3 将一个宽度为 128 的注意力分数块拆成两个宽度为 64 的寄存器区。softmax 的输出量化为 NVFP4 后，原来的寄存器即可复用，下一块的 QK 乘积可以与当前块的剩余工作重叠。[NVIDIA 原文的寄存器布局与流水图](https://developer.nvidia.com/blog/how-to-optimize-nvfp4-attention-on-nvidia-rtx-blackwell-through-register-recycling/)

## 同一内核的前后对照

在长度 8,192 的合成因果注意力负载上，原 NVFP4 内核耗时 0.76466 ms，优化后为 0.46659 ms，两者相除得到 1.64 倍。计时范围到这次注意力内核为止。[原文表 1](https://developer.nvidia.com/blog/how-to-optimize-nvfp4-attention-on-nvidia-rtx-blackwell-through-register-recycling/)

## 把计时范围扩大到整段视频

| 世界模型负载 | BF16 attention | NVFP4 attention | 整模延迟降幅 |
| --- | ---: | ---: | ---: |
| LongLive，32 帧，704 × 1280 | 5.13 秒 | 4.79 秒 | 6.70% |
| OmniDreams moving，2,045 帧，256 个 chunk | 155.92 秒 | 132.00 秒 | 15.34% |

整模表换用了 BF16 attention 作基线，并计入模型的其他工作。对 LongLive 的这段短视频，节省的是 0.34 秒；对表中的长视频，节省的是 23.92 秒。若要判断自己的视频服务能省多少，先固定生成长度、分辨率和模型，再比较整模延迟与输出质量。这两项测试无法给出 H100、B200 或在线文本服务的首 token 时延。[原文表 2 及视频工作负载说明](https://developer.nvidia.com/blog/how-to-optimize-nvfp4-attention-on-nvidia-rtx-blackwell-through-register-recycling/)

## 硬件项目的检索范围

本期还检索了截至北京时间 11 月 26 日 06:20 的 72 小时窗口。内存、调度、计算和数据路径四类查询都只读到首屏 20 条，各有下一页。计算和数据路径的仓库列表提供了查找线索。上表两项整模延迟和内核耗时均取自 NVIDIA 的原始测量。[计算检索](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+kernel+matrix+throughput+inference+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [数据路径检索](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+RDMA+transfer+storage+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated)
