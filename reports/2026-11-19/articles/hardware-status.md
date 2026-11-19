为 DeepSeek-V4.1-Flash 部署 PCIe 服务器时，先核对显卡架构、代码分支和运行方式。DeepInfer #289 于 11 月 18 日合入开发分支 `nv-dev`（`fc099cd2`），提供 SM120 离线推理路径。默认 main 的公开支持清单仍列 SM100 与昇腾 950。此处实测型号为 **RTX PRO 6000 Blackwell Server Edition**；H100、H200 及 Pro5500（型号待核实）均无这组测试数据。

新路径接入 FlashInfer 的 SM120 稀疏 MLA 内核，读取带内联缩放因子的 KV 记录，并在 DSA 索引环节选出要访问的位置。作者的 `sm120-offline` 分支早期版本用 DeepGEMM 计算 logits、DeepSelect 选择 top-k。索引器只是一步解码的一个环节，单独给它计时与给整步计时会得到不同幅度。

| 作者 sm120-offline 分支早期版本 → 本次实现 | 早期实现 | 新实现 |
| --- | ---: | ---: |
| Prefill，每张 GPU 每秒处理的 token | 4,513 | 4,510 |
| Decode，每秒推进的步数 | 6.99 | 7.17 |
| Decode 索引器，每步毫秒数 | 4.9 | 2.1 |

这组离线基准使用八张 PCIe 显卡、CUDA 13.2、PyTorch 2.13.0+cu132，DSpark 草稿长度 5，prefill batch 参数 8,192，decode 请求数 64。索引器每步少用 2.8 毫秒，端到端的解码步速提高约 2.6%，prefill 基本持平。一次解码步产出的 token 会受草稿接受情况影响，因此 7.17 steps/s 不能直接换算成用户收到的 token/s。

质量测试另用 GSM8K 的 1,319 道题、EP8、贪心解码。作者表中无推测解码得分 95.15，DSpark 5 得分 93.71。选型时应保留两种配置各自的得分与速度。SM120 路径仍限制 batch invariance、上下文并行、MTP 变长验证和 GPU 常驻 Engram。复现先锁定开发分支与软件栈，再按本地 PCIe 拓扑测预填充、解码和索引器；在线排队及尾延迟需要单独的服务负载。

## 原始来源

- [DeepInfer #289：支持范围、软件组合、离线测试及质量表](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/289)
- [SM120 实现的变更文件（第一页）](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/289/files?page=1&per_page=16)
