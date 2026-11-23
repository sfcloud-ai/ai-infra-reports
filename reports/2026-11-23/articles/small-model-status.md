# 前沿小模型：WeMM-Video-2B 上传 BF16 权重，视听问答表现如何

腾讯 Hugging Face 仓库记录了一次 WeMM-Video-2B 的 BF16 权重上传提交，时间为北京时间 11 月 20 日 09:41，落在本期 72 小时回溯内。同一仓库在 11 月 17 日建立，11 月 21 日更新运行时元数据。取证时该修订已公开可读，现有记录只能确定上传提交的时间，首次开放下载的时间仍未知。[权重上传提交](https://huggingface.co/tencent/WeMM-Video-2B/commit/aaff85654e51d16aecf4f8197f7eb625333b74db) · [官方提交记录](https://huggingface.co/api/models/tencent/WeMM-Video-2B/commits/821690998399cac0f55bb7f7f805ebafa650c3a4)

这个模型适合评估需要同时听声音、看画面的问答，例如判断某种乐器是否在画面中被演奏。视觉编码器和投影层先处理视频帧，音频路径将 16 kHz 原声按 30 秒分块编码。对于带声视频，再将视觉和音频 token 按时间顺序交错排列，加入显式文本时间戳，一起送入 Qwen3.5-2B 稠密语言主干生成回答。2B 指语言主干所属的规格，整套权重还包括视觉和音频模块。[固定版本模型卡](https://huggingface.co/tencent/WeMM-Video-2B/blob/821690998399cac0f55bb7f7f805ebafa650c3a4/README.md) · [技术报告 v1](https://arxiv.org/html/2611.26409v1)

论文表 2 在同一套联合视听任务上列出三个 Thinking 规格的得分。MUSIC-AVQA 上，2B 距 9B 为 3.9 分；换到 WorldSense，差距扩大到 11.0 分。选小规格时，部署方需要先确定自己的视频问题更接近哪类任务。[论文表 2](https://arxiv.org/html/2611.26409v1#S5.T2)

| 联合视听评测 | 2B Thinking | 4B Thinking | 9B Thinking |
| --- | ---: | ---: | ---: |
| MUSIC-AVQA | 75.4 | 78.0 | 79.3 |
| WorldSense | 52.4 | 60.3 | 63.4 |

两个 BF16 Safetensors 分片合计 6,567,395,904 字节，约 6.12 GiB。在权重上传提交和随后固定的 `8216909` 修订中，两份文件清单逐个分片列出的大小及 LFS SHA-256 完全相同。模型卡列有补丁版 vLLM 在 L20、H20 上的生成检查；这批材料没有给出对应机器的吞吐、尾延迟或峰值显存。评估单卡能否承载目标负载时，可固定视频时长、抽帧数、原声和并发数，分别测量加载后显存、请求峰值与首 token 延迟。[上传提交的分片清单](https://huggingface.co/api/models/tencent/WeMM-Video-2B/revision/aaff85654e51d16aecf4f8197f7eb625333b74db?blobs=true) · [8216909 修订的分片清单](https://huggingface.co/api/models/tencent/WeMM-Video-2B/revision/821690998399cac0f55bb7f7f805ebafa650c3a4?blobs=true) · [固定模型卡的运行说明](https://huggingface.co/tencent/WeMM-Video-2B/blob/821690998399cac0f55bb7f7f805ebafa650c3a4/README.md)

本期 24 小时小模型论文查询先返回 HTTP 429，第二次超时未收到 HTTP 响应，论文总数未知。[当期论文查询](https://export.arxiv.org/api/query?max_results=15&search_query=%28%28cat%3Acs.CL+OR+cat%3Acs.LG+OR+cat%3Acs.CV%29+AND+%28abs%3A%22small+language+model%22+OR+abs%3A%22small+language+models%22+OR+abs%3A%22on-device+language%22+OR+abs%3A%22compact+language+model%22+OR+abs%3A%22sub-billion%22%29%29+AND+submittedDate%3A%5B202611212220+TO+202611222220%5D&sortBy=submittedDate&sortOrder=descending&start=0)
