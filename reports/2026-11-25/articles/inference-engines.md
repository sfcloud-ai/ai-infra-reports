# 推理引擎每日变动：vLLM 保住可复用前缀，SGLang 批量分配分片 KV 页

同样是管理 KV 页，两个引擎本期解决的问题不同。vLLM 修正已经结束的请求继续挤掉他人前缀的顺序。SGLang 压缩新一批请求领页、归还页时调度器需要发起的设备操作。以下时间均为北京时间，代码窗口为 11 月 24 日 06:20 至 25 日 06:20。

## vLLM

11 月 25 日 05:08:44 合入的 #68820 针对 HiSparse 的一种前缀失效。请求结束后，GPU 上仍可能留着已经有干净主机副本的数据页。保留这些副本有助于再次命中，但前提是定位前缀的索引块仍在。旧顺序把两者放在相同回收优先级，较新的数据副本能挤掉较旧前缀的索引。现在分配器先取没有缓存的空闲块，再取已结束请求的干净副本，最后才取前缀缓存块。需要把数据升回 GPU 时，分配器也会避开仍有前缀价值的块。[回收策略差异](https://patch-diff.githubusercontent.com/raw/vllm-project/vllm/pull/68820.diff)

作者在问题对应的提交上应用补丁，用 40 条约 61.5k-token 的填充请求再重发前缀。单机 8×B200、TP8、HiSparse 加 DSpark k=3、无卸载时，基线命中 0/61,511 token，修正后命中 61,504/61,511。这验证了指定负载的缓存保留行为。先期调研按同一窗口查询 GitHub，返回 97 个合入 PR、默认分支 97 个提交。官方博客的 ERNIE 插件文章已单列在架构页。[vLLM #68820](https://github.com/vllm-project/vllm/pull/68820) · [vLLM 官方博客](https://vllm.ai/blog)

## SGLang

先期调研核对的 #47578 于 11 月 25 日 05:48:50 合入。启用 KV 分片后，旧 PageInterleave 分配器逐请求发起小型设备操作，释放时还要按每类页分别同步主机。新实现让每类页一次取齐整批需要的数量，在主机生成页号和页内偏移映射，再用复用的锁页缓冲一次上传。释放时按所属类别计数和分组，只需一次主机同步。对页对齐的连续片段，按页步长取首项即可归还。

单张 B300、分片数 8、页大小 64、开启排序、混合前缀与扩展长度的微基准中，batch 128 的分配由 20.59 降至 2.63 ms，同批分组释放仅由 1.58 降至 1.52 ms。作者另以 B300、Mooncake 分离 prefill/decode、两端各 TP2、DeepSeek-Coder-V2-Lite-Instruct 做正确性测试，GSM8K 为 0.82，并通过了单 rank 池容量装不下整个提示的检索测试。微基准不提供端到端吞吐倍数。先期调研按同一窗口查到 63 个合入 PR、默认分支 63 个提交。

正式核查读到了 SGLang 自有博客和 LMSYS 目录。SGLang 列表可见的最新一项为 11 月 12 日。LMSYS 首页的内嵌目录包含 151 篇，排在最前的两篇均标为 11 月 23 日。先期调研另读了百度与 SGLang 合著的 ERNIE 低延迟解码原文，并沿 307 跳转读到 Miles 关于训练与 rollout 数值一致性的原文。两篇都只标日期，无法按分钟划入本窗口。ERNIE 文章的解码实验使用模拟的 DSpark 平均接受长度 5.5。原文链接的低延迟实现 #52603 在取证时仍为 open。[SGLang #52603](https://github.com/sgl-project/sglang/pull/52603) · [ERNIE 低延迟解码原文](https://www.lmsys.org/blog/2026-11-23-ernie55-flash-low-latency/) · [Miles 原文](https://miles.radixark.com/blogs/true-on-policy-rl-bit-exact-rollout-and-training-with-sglang-and-miles) · [SGLang #47578](https://github.com/sgl-project/sglang/pull/47578) · [SGLang 官方博客](https://www.sglang.io/blog)

## DeepInfer

正式核查中，DeepInfer 默认分支 main 的本期提交查询返回 0 条。先期调研还查了 nv-dev 的同窗提交、全仓同期合入的 PR 和 release 列表，三项均返回空列表。项目 README 将公开实现定位为支持 DeepSeek-V4.1-Flash 的离线推理框架，另列完整服务所需的 KV 系统等组件。[main 提交查询](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100&since=2026-11-23T22%3A20%3A00Z&until=2026-11-24T22%3A20%3A00Z) · [DeepInfer 仓库](https://github.com/deepseek-ai/DeepInfer)

DeepSeek 官方新闻页本次连接失败。先期调研取得了官方研究与动态目录及 API 更新页的摘录，其中未见本窗口的 DeepInfer 新事件。引擎版本另按发布日期核对：先期调研在 vLLM 和 SGLang 的 release API 各查了两页、每家 30 条，其中没有版本发布于本窗口。[DeepSeek 开放基础设施目录](https://github.com/deepseek-ai/open-infra-index)
