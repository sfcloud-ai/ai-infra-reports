# 推理引擎每日变动：为临时显存和缓存语义补上边界

三项变更均于11月7日合并主线，不等于已进入稳定版。本次读取最新 vLLM 稳定版为0.32.0、预发布为0.33.0rc3，SGLang为0.5.23，均早于这些合并。

## vLLM：CPU KV卸载按rank统一映射，大页不足提前失败

**先看实际问题。** GPU放不下所有会话的KV缓存时，可以把可复用内容放到CPU内存。CPU侧也不是“申请够容量就行”：每层各自分配、页取整、固定内存注册与NUMA位置都会影响启动、资源释放和搬运。固定内存是允许GPU直接搬运的主机内存，HugeTLB则是需要显式预留的大页，两者不是一回事。

[PR #60130](https://github.com/vllm-project/vllm/pull/60130)于11月7日07:12:22 UTC合并，提交[7a07e234](https://github.com/vllm-project/vllm/commit/7a07e2342e7e857133d3964bd4b7022103a5b030)。SimpleCPUOffloadConnector现在为每个rank（并行工作进程）建立一个mmap，各层KV是其中的视图。总量按实际KV块数计算，再按后备页取整。普通页仍为默认；显式选2MiB/1GiB HugeTLB时先预填充，宿主页池或容器hugetlb额度不足便拒绝启动，不在服务中等到SIGBUS，也不静默回落普通页。

数据流程是：解析每层KV块需求 → 一次映射并按worker NUMA策略放置 → 切出各层视图 → 按不超过256GiB、同时满足KV块和后备页边界的区间注册 → GPU/CPU按原KV传输流程搬运。登记与注销逐区间对应；MADV_DONTFORK阻止子进程继承固定页。该变化没有把不同模型的KV合并为可共享内容，独立权重和模型运行状态仍须单独预算。

**证据与限制。** 早期MI350X修订给出128GiB固定页登记由2.5秒降至0.19秒，但GPU↔CPU带宽仍约42GB/s。这是初始化开销，不是在线推理吞吐提升。后续GB200、CUDA13.0/PyTorch2.14、Linux6.17/64KiB OS页的2MiB HugeTLB验证包括四rank、21,792次字节一致往返；150GiB普通页浸泡、崩溃释放和Qwen3-0.6B三提示输出烟测。它们早于最后把注册上限调整至256GiB等简化，最终版本只报告相关host-buffer 7通过、2因无大页跳过，部分CUDA测试本地未能收集。不能把这些记录拼成“最终版本H100/H200线上已验证”。

**交付价值。** Kubernetes部署要同时申请宿主大页、容器hugepages资源和正确NUMA位置，Linux5.14+是显式大页预填充条件。建议先用实际模型跑卸载开关输出一致性、OOM/强杀释放、重启与回填尾延迟，再决定是否启用HugeTLB；不要仅用启动耗时替代TTFT/TPOT服务验收。

![CPU KV分配和传输](assets/cpu-kv-pages.png)

## SGLang：分块复制循环状态，压住静态池之外的显存尖峰

**先看实际问题。** 混合模型除了逐token增长的KV，还会保存KDA/Mamba等循环状态。多个已缓存会话同时进入时，前缀写时复制要克隆多个checkpoint；原先一次高级索引gather所有源slot，先建立“slot数×单slot状态大小”的临时张量。常驻池明明够用，临时复制仍可能触发OOM并让整批请求重试。

[PR #47984](https://github.com/sgl-project/sglang/pull/47984)于11月7日04:49:54 UTC合并为[784cffe3](https://github.com/sgl-project/sglang/commit/784cffe3d90bb625041f9c0b4f06e66b0a122e42)。它只改变temporal状态复制：根据64MiB预算计算每块slot数，至少复制一个；能一次装下的小复制保留原写法。融合conv分支和fallback分支均调用同一个helper，conv复制不变。

流程是：缓存命中/写时复制 → 源/目的slot集合 → 按64MiB预算分块 → gather当前块 → 写入目的slot → 下一块。源和目的必须不相交；调试模式在实际分块时检查此条件。64MiB不是经调优证明的最优值，若单slot超过64MiB，仍需至少一个slot临时空间，不能写成绝对64MiB上限。

**证据分两组。** 最终PR微基准为1张H100 PCIe、PyTorch2.14.1+cu130、BF16测试池、36MiB/slot、20次复制均值：8slot额外峰值288→36MiB，1.844→1.794ms，作者判断时间变化在噪声内；20项相关测试通过，回退实现会令峰值回归测试失败。另一个[原始故障报告 #47916](https://github.com/sgl-project/sglang/issues/47916)使用2张H100 NVL94GB、GLM-5.3-Flash W4AFP8、TP2、34MiB/slot；12请求突发在未修补时出现2次OOM重试，报告者按slot复制补丁为0次且GSM8K无回归。两组slot大小和硬件不同，不混合数值；最后合并版没有完成该真实模型的端到端突发验证。

**交付价值。** 这是减少工作区峰值而非减少常驻状态，也不是跨模型共享。高显存利用率部署应把复制workspace加入准入余量，验收预缓存会话突发、完整输出质量、OOM重试和P95/P99延迟后再提高并发上限。

![循环状态分块复制](assets/mamba-copy-chunks.png)

## SGLang：P/D先核草稿KV布局，再登记传输目标

**先看实际问题。** 预填充/解码分离（P/D）把“读提示词”和“逐token生成”放到不同服务。DSpark/DFlash还会在prefill从目标模型hidden states产生草稿KV；decode拿到token编号不能重新生成这些字节。两侧地址和dtype对上，但草稿算法或条目数不同，缓存仍不兼容。

[PR #48375](https://github.com/sgl-project/sglang/pull/48375)于11月7日09:30:05 UTC合并为[043cfc4d](https://github.com/sgl-project/sglang/commit/043cfc4d3a2cc2a931d15862f08c4b60b692c957)。携草稿KV的prefill经原有bootstrap PUT /route公布spec_kv_layout，内容是algorithm和num_draft_entries。Python/Rust注册表接受无草稿PP阶段任意先后顺序，记住首个非空布局，拒绝互相冲突的已知布局。Decode在登记prefill传输目的地之前比较；算法或entry数不同、或目标decode没有对应草稿KV时失败。

握手顺序是：prefill发布布局 → bootstrap保留已知一致布局 → decode读取并比较 → 一致才登记目标/开始传输，不一致则报错。无草稿PP stage和state-only draft跳过；旧prefill不发布字段保留旧行为。字段不比较block size，因为此路径按prompt token位置写草稿KV；现有DSV4.1 SWA环大小校验不变，不能用新字段替代。

**升级边界比功能开关更重要。** 旧decode遇新prefill公布的未知字段会拒绝，需要升级；普通PD、EAGLE/NEXTN无新增布局限制。因旧prefill缺字段仍沿旧逻辑，不应宣称所有混合版本都已有保护。

最终head的221单测、175子测以及399注册场景/4,788decode场景的差分验证支持兼容性设计；H200 Qwen3-0.6B NIXL4/4请求成功来自前一head且是普通PD，不是DSpark/DFlash GPU端到端验证。部署前应覆盖新旧prefill/decode/bootstrap组合、无草稿PP阶段与主动不匹配，先确认不兼容配置在传输前失败，再验证真实推测解码质量和SLO。它改善错误配置的早期发现，不承诺吞吐收益。

![草稿KV握手](assets/draft-kv-handshake.png)

## 官方技术文章覆盖

vLLM新见11月6日LibTorch Stable ABI文章，已核读全文和Markdown。其CUDA轮子通过稳定C shim、wrapper和dispatcher解耦LibTorch二进制接口，还需全依赖符号审计；Python API、CUDA及第三方兼容仍需单独验证。该文叙述10月15日迁移完成，Markdown只有日期、RSS统一生成午夜，且文称v0.33而正式release列表仍仅rc3，本期保留线索，不补造精确发布时间或当作当日功能发布。

SGLang官方博客已读11月4日Kimi K3.1 Pro全文（扩窗至一周），文章只有日期精度；H200 rollout和GB300服务条件不同，未将其混成新事件或H100收益。LMSYS补充入口返回导航壳，不宣称完整列表已核查；SGLang官方主站全文读取成功。

### CI成熟度补充（23:32 UTC只读核验）

两项SGLang变更精确PR head的check-runs均仍含失败项，未进一步归因。#47984的pr-test-finish已成功，但extra/AMD finish失败；#48375仍见失败检查。这里的定向测试与差分验证不能解释为全CI通过，升级前需核查对应失败是否影响自身部署。PR正文的旧CI图标不是最新检查结论。

## DeepInfer
本次已分别核查代码、release、PR与官方技术文章。主线最新仍为11月3日部署Q&A v0.2，11月4日晨报已报道，本期不重复。Apple Silicon PR #125仍未合并，且正文明确只是平台检测和构建脚手架，推理入口会报NotImplementedError，不能写成已支持Mac推理。

开源README仍限定NVIDIA SM100与Ascend 950，交付离线推理；完整KV缓存服务与负载均衡未包含。H100/H200部署兼容不能由同属NVIDIA推断。


官方来源：[DeepInfer代码](https://github.com/deepseek-ai/DeepInfer) · [部署Q&A](https://github.com/deepseek-ai/DeepInfer/blob/a679bb86ce36e883a98a97733492b686e5b9a08e/doc/inference_deployment_qa.md)
