# 推理引擎每日变动：分离编码、缓存生命周期与 CPU 卸载

**代码核查窗口：北京时间 11 月 11 日 10:00 至 11 月 12 日 10:00。** vLLM、SGLang、DeepInfer 在同一篇中分别记录；技术文章与代码各自核查。下列 PR 均已合并主线。读取到的最新正式版为 vLLM 0.32.0、SGLang 0.5.23，不能把这些新合并自动当作稳定版能力。

## vLLM

### EPD：编码、prefill、decode 分开扩容

[11 月 11 日官方文章](https://vllm.ai/blog/2026-11-11-encoder-disaggregation-epd)将编码 E、预填充 P、解码 D 放入独立资源池。E 传媒体表示，P 产生 KV，再交给 D；下游 metadata-only 路径避开媒体获取、解码、缩放和切块。表示布局与协议仍须匹配，同模型编码缓存复用不等于不同模型共享状态。

DeepSeek-V4.1-Flash 的 GB200 实验为 8 卡 PD（4P+4D）对 12 卡 EPD（另加 4E），TP1、DP4+EP、Engram 在 GPU，EC 使用 Mooncake GPU RDMA、KV 使用 NIXL。MPDocVQA 共 512 问、每问 4–6 页，平均输入 4,905、输出 5.2 token。三轮比较在并发 64–128 时，按**全部 GPU** 归一化的输入加输出吞吐提高 6.6–9.5%，P90 TTFT 降低 44–47%；16 并发更差，32 附近持平。它不是输出吞吐翻倍，也不能外推至 H100/H200。

核心 EPD 路径已在 0.32.0；这组 DeepSeek metadata-only 实现与 SMG 路由依赖新主线。仅保留 metadata 的下游若取不到远程表示，会使相关请求失败，不能凭空恢复原媒体本地重算。应一起核对引擎、路由、连接器版本及失败恢复。

### 惰性卸载：保留前缀，也要计算搬运代价

[#61797](https://github.com/vllm-project/vllm/pull/61797) 于 11 月 11 日 18:37:52 合并，为 UMBP 增加默认关闭的 `lazy_offload`：从 GPU 空闲队列选取可复用块，补齐全注意力前缀链，传输完成前固定源块；缓存节点不可达与真正 miss 分开处理，失败查询和存储使用退避。它也保存 decode 产生的前缀块，此时 `save_decode_cache` 不再控制保存范围。

PR 历史版本的 MI350X、Qwen3-0.6B、1,024 输入/256 输出、并发 64 对照中，开启后 embedded 模式 TPOT 增加约 1–5%，standalone 增加约 13%。这些性能结果来自合并 main 前的 `eecd905ac9`，不是最终合并提交的复测。恢复收益要与扫描、传输成本一起评估；不能据该 AMD 小模型测试宣称 H100/H200 多模型混部收益。

### 权重卸载：修复配置未生效

[#66419](https://github.com/vllm-project/vllm/pull/66419) 于 11 月 12 日 03:02:58 合并，修复 Transformers modeling backend 忽略 `--cpu-offload-gb`。解码层及 MoE experts 逐层构建并交给 offloader，避免先在设备上构建全部层再卸载的峰值。

MTP draft 仍不卸载，多模态模型在该参数下的失败也尚未解决。B200 验证使用 tiny Llama/Mixtral 与随机权重，证明所测构建峰值和输出行为，不能作为大模型在线性能证据。超配部署仍需分别验证加载峰值、稳态显存和搬运引入的尾延迟。

### GLM 草稿 KV：继承 FP8 配置

[#66292](https://github.com/vllm-project/vllm/pull/66292) 于 11 月 12 日 01:01:29 合并，移除 GLM-5.3-Flash 自动选 FP8 时对非 MTP/DSpark 草稿 KV 的 `auto` 覆盖，使 DFlash 继承 FP8。给定 TP4、48 个请求、完整 2,048 token 草稿窗口，PR 计算每卡草稿 KV 数据可少约 790 MiB；这是特定草稿缓存预算，不是所有部署的整卡节省。其单并发吞吐对照基本不变。

### 启动显存：测准峰值，再给图捕获让位

[#66731](https://github.com/vllm-project/vllm/pull/66731) 于 11 月 12 日 07:24:07 合并。当单请求长度小于总 token 预算时，测量阶段用多个 prefill 请求覆盖大步；单并发时允许 prefill-only 测量，prompt logprobs 另按单请求测量。多请求混合 full-vocab prompt logprobs 的峰值仍有已知缺口。PR 给出 GB200 验证，触发问题的 H100 场景尚未完成修复复测。

首版已核实的 [#66523](https://github.com/vllm-project/vllm/pull/66523) 于 08:55:52 合并：图捕获前将已提交的热身 KV 缩到布局所需最小值，再按捕获后余量扩展。最小值通常一块，block-outermost 布局需要两块；单 H100 80GB、Gemma-4-31B、显存比例 0.95、多模态编码器图的对照解决了所给配置的启动 OOM，不是吞吐优化。

[#66704](https://github.com/vllm-project/vllm/pull/66704) 于 08:43:21 合并，针对显式 `0.7 < gpu_memory_utilization < 1.0` 且留下至少 1 GiB 空间的情况增加 extensible KV 配额告警。它不会自动提高上限；多模型服务仍须保留独立权重、临时张量和峰值预算。

## SGLang

### 统一内存：混合模型不再预先锁死各类状态的配额

[11 月 11 日 LMSYS 官方文章](https://www.lmsys.org/blog/2026-11-11-unified-memory/)将全注意力 KV、滑窗 KV 与循环状态放入同一 arena，保留各自的页/槽尺寸，通过压紧和移动回收可用空间，并以整项请求的联合需求做准入。每 token 打包多层状态，适配的草稿 KV 可有不同 dtype；这不是不同模型共享权重或任意共享 KV。

相较此前已报的页回收 fence 修复，文章补充了完整状态声明、联合准入和页面使用记录，以及单 H200、提交 `daa171846f` 的两轮平均实验。Qwen3.5-4B 在 16K 输入、4,096 输出、并发 64 下，运行请求数由 22 增至 32，吞吐提高 26%；基线是默认比例的独立池，并非每负载调优后的最优比例。

该能力仍属实验特性。纯全注意力、DeepSeek-V4 等组合不支持；优先级抢占被禁用，高优先级请求可能等待；循环 checkpoint 不推进时，滑窗行可能超出准入估价。PD 需要 Mooncake，且不能与 PP、推测解码或 DCP 组合。它说明统一预算的价值，也保留了生命周期与隔离方面的实际边界。

### Muse Spark megakernel：把一层的工作融合起来

[11 月 11 日另一篇官方文章](https://www.lmsys.org/blog/2026-11-05-muse-spark-open-ultrafast/)介绍为 Muse Spark Open 编写的 CUDA/PTX megakernel：每层一次启动，重叠权重预取、attention、MoE 与 TP 通信，草稿也做融合。这里是专门实现，不是给所有 SGLang 模型换一个通用算子库。

文中性能来自八张 GB300、TP8、batch 1、DFlash V2；只能用来讨论该低并发 decode 路径，不能外推 H100/H200 或在线端到端吞吐。层内 profiling 还使用合成专家路由；在完整 benchmark 口径与代码未进一步对齐前，本期不采用标题的最高 token/s 作为选型收益。URL 中的 11-05 也不代替页面明确标注的 11 月 11 日发布日期。

### DSA 与 CPU offload：索引器需要常驻 GPU

[#48316](https://github.com/sgl-project/sglang/pull/48316) 于 11 月 11 日 14:00:24 合并。DSA 模型如 GLM-5.3 在 V1 CPU 权重卸载与 breakable prefill CUDA Graph 下，索引器可能在层的 `functional_call` 返回后单独执行，此时参数已回到 CPU，导致设备不一致。

修复将 `indexer` 参数保留在 GPU，保障这段图回放执行，也意味着这部分权重不能计入可卸载空间。新增回归测试覆盖层结束后调用索引器；它不是完整 GLM 在线吞吐或跨硬件性能证明。

### 主机注册失败，保留原 CUDA 错误

首版已核实的 [#48272](https://github.com/sgl-project/sglang/pull/48272) 于 11 月 12 日 09:42:18 合并。错误文字转换保留原 `cudaError` 枚举，比较返回码时才转整数，避免第二个 TypeError 掩盖真实的主机内存注册/注销失败。成功路径不变；它改善 HiCache 等路径的诊断，不会消除底层注册失败。

## DeepInfer 与覆盖边界

在上述 24 小时时窗，DeepInfer 默认分支提交与已合并 PR 查询均返回零项，release 列表为空，本轮没有选入代码事件。[当前官方 README](https://github.com/deepseek-ai/DeepInfer)明确开放的是离线推理能力，硬件列出 NVIDIA SM100 GPU 和华为 Ascend 950 NPU；NVIDIA 路线不能默认 H100/H200 可运行，也不能与 FlashInfer 或完整在线服务混为一谈。

[DeepSeek 研究/动态](https://www.deepseek.com/news/)本次读到最新动态为 9 月 10 日，[基础设施文章索引](https://github.com/deepseek-ai/open-infra-index)的已展示条目未发现七天内新文。这些索引结果不代表全网无进展。

本轮代码发现读取 vLLM 81 条提交、81 条已合并 PR，SGLang 92 条提交、99 条已合并 PR；返回未达到分页上限，PR 搜索未标记 incomplete。正文只收录具体说明与最终变更已核对的项目，其他候选不借标题推断实现。模型发布及模型博客的覆盖另行记录，不能由代码查询代替。
