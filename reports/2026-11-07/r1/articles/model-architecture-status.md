# 模型与新架构｜异步训练先对齐数值

RL（强化学习）让模型通过反馈调整生成策略。rollout 是用当前策略采样，learner 是更新参数的训练器；logprob 是生成某个 token 的对数概率。下面先看数值误差如何影响学习，再看不同模型的缓存状态及部署条件。

![先对齐同权重数值，再修正策略滞后](assets/zero-mismatch-async.png)

**发布时间：2026-11-06 09:00 UTC；本次24小时窗口内新文章。** vLLM 的新技术文章把 REINFORCE Zero 的异步训练研究，与 DeepSeek-V4.1-Flash、Kimi K3.1 的训练/推理数值对齐放到同一条工程链上。它的价值不是又增加一个模型开关，而是说明：只要缓存命中、prefill/decode、量化或跨卡归约改变了同一权重下的 token 概率，RL 就会把执行路径差异混进策略更新。

## 先分清两类偏差，再谈异步收益

Rollout 与 learner 的概率差别包含两部分：样本来自旧权重的版本滞后，以及相同权重在不同内核、batch 或执行顺序下产生的数值差异。REINFORCE Zero 先用逐位一致的执行消掉第二项，再用采样时记录的真实 token logprob 做不裁剪的 token-level importance sampling（IS），修正剩下的权重滞后；它不是把所有偏差交给一个拒绝阈值过滤。

论文的数学结论限于固定 token 历史下的条件动作更新，不应扩大成对任意长轨迹分布都完全无偏。工程上还必须保存实际行为策略版本、动作 token 掩码和采样 logprob，不能拿更新后重新计算的概率替代采样分母。

在 DeepSeek-R1-Distill-Qwen-1.5B 数学推理实验中，同为 BF16、128 responses/update，响应/上下文上限为 8,192/9,216 tokens。16 GPU、12,000 updates 的计时从同步 TII 的 164.77 小时降到异步方案的 68.55 小时，训练步吞吐为 2.40 倍；异步配置把 learner/rollout 分为 2+14 GPU。**这个计时排除了评估，论文未给出这组 GPU 的确切 SKU；它既不是在线服务 tokens/s，也不能直接当成 H100/H200 成本收益。** Qwen3-4B 配 Python 工具的 lag-64 实验使用 16K 上下文，图展示到 5,000 步仍在学习，附录写明总训练为 6,000 步，二者不是同一统计终点。

## 缓存不是旁路细节，而是数值契约的一部分

**DeepSeek-V4.1-Flash：SWA 命中和未命中必须给出同一 logprob。** 对齐路径保留 block FP8/MXFP4 权重、压缩 KV、MegaMoE、DSpark 和 CUDA graphs；训练 forward 调用 rollout 的算子，并匹配顺序和布局。vLLM PR #62365 将 sparse FlashMLA 的因果行统一到不切分的 decode 内核，直接读取 FP8 SWA 与 NVFP4 压缩缓存；同时要求 bounded replay、MTP 开关、不同 batch 和 prefix hit/miss 保持一致。由此可见，仅验证生成结果“看起来一样”还不够，缓存复用的检查粒度需要落到每个采样 token 的 logprob。

完整模型证据来自 **16节点×4 GB200**、训练与rollout分时共置：84步DAPO均保持零差异，SWE-bench Pro另有32K的20步和128K的短程验证。**一致性不等于质量提升：32K SWE-bench Pro 的 held-out resolved rate 从0.742降至0.707。** 同机同recipe仅切换对齐模式，sparse FlashMLA路径的RL rollout阶段在自然EOS/固定输出条件下分别长2.3%/7.2%；这是rollout阶段成本，不是总训练耗时或在线尾延迟。

**Kimi K3.1：线性注意力状态要能重现 chunk 内的计算。** KDA 原本的 chunkwise prefill 与逐token递推decode舍入不同，混合batch还可能把decode行送到prefill路径。对齐实现因此不只保留“当前递归状态”，而是保存 **chunk入口FP32状态、当前chunk已计算的行缓存和位置**，让decode重算与prefill相同的行表达式，固定乘积与累加顺序。读取到的公开CUDA实现还显示，状态更新只在chunk边界推进，padding slot不访问状态。这种状态不能套普通全注意力KV的每token容量公式，也不能假定现有循环state卸载格式可原样复用。

Kimi的完整LoRA验证在4节点×4 GB300上完成100步DAPO，逐token差异为0。代价有实测：同镜像同recipe、每请求LoRA、相同GPU memory utilization 0.87，首步rollout由353秒增至412秒（约17%）；不是无成本替换。已读设计材料要求权重同步时清空这类chunk状态，因此建议把权重版本切换、prefix命中、slot回收/再分配与wake-up后的状态重建一起纳入正确性测试，而不是只量一次kernel吞吐。

## 先验证复现边界，再决定是否迁移

当前核查确认 vLLM #62365 和 mLite #257 都仍open，不能写成稳定版已交付。作者case明确区分实测分支和所附公开快照：DeepSeek V4.1 的64GB200验证依赖额外内存、检查点及同步修复，不能只checkout一个展示分支就假定复现实验。Kimi分支目前是工作树快照，context parallel=2只验证过微基准一致性，尚无对应RL运行。Molt主线提供指标与dump/replay能力，但全部aligned kernels仍在逐步上游化。

对当前服务与缓存工作的直接启发是建立三层验证：先用同权重回放锁定内核差异，再逐项覆盖命中/未命中、prefill/decode、MTP、状态回收与权重同步，最后才做异步学习和资源成本对照。**旗舰模型的长程异步RL仍是下一步；已展示的GB200/GB300结果不能外推H100/H200，更不能承诺Pro5500（型号待核实）。** 不同模型独立权重及运行状态的预算仍需分别计算，数值一致性不会自动带来跨模型KV共享或显存超配收益。

## 来源

- 官方文章与精确时间：https://vllm.ai/blog/2026-11-06-zero-mismatch-async-rl
- 论文与算法：https://github.com/hijkzzz/REINFORCE-Zero
- DeepSeek V4.1 实测、开销与限制：https://github.com/Inferact/zero-mismatch-rl/blob/main/cases/deepseek-v4.1-flash/README.md
- Kimi机制与对照：https://github.com/Inferact/zero-mismatch-rl/blob/main/cases/kimi-k3.1/README.md
- KDA公开实现：https://github.com/Inferact/zero-mismatch-rl/blob/vllm/kimi-k3.1/csrc/k31/kda/kda_cfbi_v6.cu
- 适配状态：https://github.com/vllm-project/vllm/pull/62365



## 模型架构核查：索引更新时间不等于新架构
截至 2026-11-06 23:26:51 UTC，本轮按 24→72→168 小时检查 GLM、DeepSeek、Qwen 官方模型入口，并追溯 Qwen3.8-27B 与 Qwen3.8-Flash-Next 的提交记录。两张 Qwen 模型卡的 11 月 5 日新提交在官方元数据中均标为适配暗色主题的基准表格颜色修复，未形成可核验的新注意力、KV/循环状态布局或引擎适配事件，因此不作为新模型新闻。完整 commit diff 页面本次不可读，不声称核查了全部补丁。GLM 官方入口所列最新权重更新为约 23 天前，DeepSeek V4.1-Flash-1017 为约 21 天前；这是本次读取页面中的日期精度，不能改写成精确发布时间。

DeepSeek 官方研究与动态页、基础设施文章索引和 DeepInfer 部署 Q&A 已读。Q&A 的 11 月 3 日 v0.2 更新已在 11 月 4 日晨报报道，本期没有新增到同一事件的证据，不重复收录。Qwen 官方博客本次返回无可读正文，仍保留该入口的访问缺口；模型页读取成功不代表博客核查成功。以上仅说明本轮所查范围未选出新的架构事件，不是对全网“没有更新”的判断。

来源：https://huggingface.co/api/models/Qwen/Qwen3.8-27B/commits/main
https://huggingface.co/api/models/Qwen/Qwen3.8-Flash-Next/commits/main
https://huggingface.co/zai-org
https://huggingface.co/deepseek-ai
https://www.deepseek.com/news/

