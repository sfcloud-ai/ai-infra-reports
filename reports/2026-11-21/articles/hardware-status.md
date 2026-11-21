# 硬件与算力平台：四张 CMP170HX 上，续写为何少重算了上千个 token

长对话已经有前缀缓存，接着生成时为什么还要重算？在同时保存注意力 KV 和 Mamba 状态的实现中，恢复点要落在调度器接受的边界上。若末尾停在两个可用检查点之间，恢复时仍要补算一段。社区项目在 11 月 20 日提交 `4e8e4321`，把经过对照的块大小设置纳入自己的默认部署补丁。[项目提交和原始 A/B 表](https://api.github.com/repos/g4bwy/qwen3.8-flash-next-cmp-170hx/commits/4e8e4321c45bfe66eaed19fdb1456cecfae2953b)

## 只改检查点网格，两次启动对照

实验使用四张改装至 64 GB 的 CMP170HX（GA100），以四级流水线并行运行社区项目的 Qwen3.8-Flash-Next FP8 配置。作者在同一代码树上启动两次，保持 NCCL 传输和 12,928 个 token 的状态保留间隔，只切换块大小设置；调度网格由 6,464 个 token 变为 3,232 个。保留间隔在两种网格上都合法。更细的边界使部分增长中会话从离末尾更近的位置恢复。[提交中的开关和对照条件](https://api.github.com/repos/g4bwy/qwen3.8-flash-next-cmp-170hx/commits/4e8e4321c45bfe66eaed19fdb1456cecfae2953b) · [项目环境说明](https://raw.githubusercontent.com/g4bwy/qwen3.8-flash-next-cmp-170hx/4e8e4321c45bfe66eaed19fdb1456cecfae2953b/README.md)

| 会话深度与测量项 | 网格 6,464 | 网格 3,232 |
| --- | ---: | ---: |
| 20K，两个探针的重算 token | 1,321 / 1,334 | 15 / 15 |
| 64K，两个探针的重算 token | 6,196 / 6,086 | 2,971 / 2,917 |
| KV 池可容纳的 token | 4,858,695 | 5,340,298 |

表中斜线分开的是两次探针结果。新设置将 20K 深度的重算降到十几个 token，但在 64K 仍需重算约三千个。两次启动报告的 KV 池容量相差 481,603 个 token。维护者回看 A/B 后，把差额归于块网格和尾块利用率，修正了此前关于 CUDA 图显存计量的解释。[两档深度的重算数据和容量归因](https://api.github.com/repos/g4bwy/qwen3.8-flash-next-cmp-170hx/commits/4e8e4321c45bfe66eaed19fdb1456cecfae2953b)

## 哪些结果可以带到别的机器

这项证据来自社区板卡、PP4 和特定补丁树。项目配置使用的模型名称也不能用作厂商当日发布权重的依据。若要在 H100、H200 或 Pro5500（型号待核实）上评估，应固定模型、保留间隔和调度配置，分别记录可恢复的边界、重算 token、池容量，再测完整一轮续写的首 token 等待。现有结果没有提供这些标准设备的对照，也没有给出线上尾延迟。[板卡与软件环境](https://raw.githubusercontent.com/g4bwy/qwen3.8-flash-next-cmp-170hx/4e8e4321c45bfe66eaed19fdb1456cecfae2953b/README.md)
