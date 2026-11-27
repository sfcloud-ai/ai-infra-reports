# 推理引擎每日变动：SGLang 支持 NVFP4 KV 跨注意力 TP 传输

## vLLM

本期三项合入分别覆盖文件 KV 的 GDS 读回、DCP rank 局部缓冲，以及 Qwen4Exp 在纯文本解码时保留检查点 M-RoPE。前两项的硬件与测量边界见模型服务页，Qwen4Exp 的测试范围见模型架构页。[GDS 改动](https://github.com/vllm-project/vllm/pull/66805) · [DCP 改动](https://github.com/vllm-project/vllm/pull/70178) · [Qwen4Exp 改动](https://github.com/vllm-project/vllm/pull/69882)

## SGLang

预填充侧和解码侧的 attention TP 不同时，同一页 KV 的注意力头需要重新分给接收端。11 月 26 日 09:55 合入的 #51234 让 Mooncake 按页行切分主 KV 的 head，并由指定发送 rank 给每个解码 rank 传送一份已复制的 index K。对 draft KV，滑窗路径发送需要的尾部页，启用 radix cache 的解码端接收完整 draft 页。[原 PR](https://github.com/sgl-project/sglang/pull/51234) · [传输实现与单测](https://api.github.com/repos/sgl-project/sglang/pulls/51234/files?page=1&per_page=100)

作者举例说明预填充侧 attention TP2 可以向解码侧 TP1 传输。适用条件包括受支持的 MSA-v1 NVFP4 页行格式、Mooncake 传输、能力检查和相应 draft 缓存配置。单测覆盖切片与布局。现有材料未给出可外推的吞吐或端到端生产验证。[支持条件与测试](https://api.github.com/repos/sgl-project/sglang/pulls/51234/files?page=1&per_page=100)

## DeepInfer

已关闭 PR 查询返回 31 条，未见主窗内合入。另读到 DeepSeek 的开放基础设施 README，其中含历史项目与文章引用，无法据此核定本窗的新技术文章。发行版本、其他分支和线上能力仍须单独取证。[已关闭 PR](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls?direction=desc&page=1&per_page=100&sort=updated&state=closed) · [官方基础设施索引](https://api.github.com/repos/deepseek-ai/open-infra-index/readme)

## 引擎和技术文章的覆盖

vLLM 与 SGLang 的已关闭 PR 各读三页，每页 100 条，去重分别为 300 和 298 条。分页均到达 24 小时下界，尚未到达 72 小时下界。这两项读取也未覆盖全量 commits 和 releases。[vLLM 列表第三页](https://api.github.com/repositories/599547518/pulls?direction=desc&page=3&per_page=100&sort=updated&state=closed) · [SGLang 列表第三页](https://api.github.com/repositories/740303686/pulls?direction=desc&page=3&per_page=100&sort=updated&state=closed)

vLLM 官方索引可见 ERNIE、vLLM-GR 和 NVMe 文章线索，LMSYS 官方索引有两篇 11 月 23 日的条目。上述五篇的正文和带时区的发表时间尚未核得。SGLang 官方博客已读取，DeepInfer 对应的官方项目索引覆盖边界见上文。[vLLM 官方索引](https://vllm.ai/blog/archive) · [LMSYS 官方索引](https://www.lmsys.org/blog/) · [SGLang 官方博客](https://www.sglang.io/blog)
