# 前沿小模型｜Clover 的双向草稿边界

AR（自回归）每次接着历史生成下一个 token；块扩散则反复调整一组待生成 token。GDN 是带记忆状态的循环层。TTFT 指首次输出等待，p99 指尾部延迟，SLO 是服务目标。下文区分已提交历史与一次预览的临时状态。

**事件时间：2026-10-30 09:58:28.399 UTC官方工程说明，7天扩窗；不是今日新权重。**

## 问题与方法

智能体每一轮都等待模型生成，块级并行去噪可缩短生成链路，但如何让长期历史与当前噪声块正确交互、以及如何把临时预览状态提交成可复用历史，决定了实际适配成本。

Clover-35B-A3B-Preview沿用Qwen3.6的混合骨干：**35B总参数、每token约3B激活**，40层中30层GDN、10层全注意力，128K上下文。双向GDN把历史状态读出与当前块token放进同一softmax，并加块大小校准与独立右卷积。HF参考实现默认32-token块、0.95置信阈值；预览只读已提交缓存，完成块后按因果顺序重放，再持久化状态。

小的是激活计算量，不是全部权重：BF16权重约69GB，另需全注意力KV、FP32递归状态、卷积状态和预览临时区。块级专家筛选保留累计路由权重达到90%的专家子集，不是只保留90%的专家，也**不减少存储或加载的权重**。多模型部署仍要各自计算完整权重与状态预算。

## 可核验的质量—成本证据

![Clover：预览只读，确认后才写回历史，依据正文来源的原创简化示意图。](assets/clover-preview-commit.png)

SGLang开放PR #46927给出了更可用的H200实验条件：MATH500、EvalScope、每题一次、thinking开启、temperature=0、top_p=1、presence_penalty=0.9、repetition_penalty=1.05；预览块16，threshold接收规则ratio=1.0/delta=0.6，最大输出32,768。

- 1张H200、DP=1、每rank并发1：483/500正确（96.6%），聚合输出450.59 token/s。
- 4张H200、DP=4、每rank并发8：476/500正确（95.2%），聚合输出4,268.73 token/s。

两组同时改变GPU数与并发，没有同设置AR/同精度竞品基线，不能由此计算扩卡效率或“比小模型便宜多少”。评测未给完整输入长度分布、TTFT/p99或线上SLO；threshold规则也不能当作严格保持AR输出分布。官方工程稿中的H200 515 token/s、16GB RTX 5070 Ti INT4演示缺少足够的匹配负载/内存拆分与量化质量对照，不作为容量或性能保证。通用SOTA不成立，本条仅把它作为低激活计算量的块扩散研究候选。

## 引擎适配和复现成本

- **HF参考实现可读**：Transformers 5.19.0、PyTorch 2.10+，自定义代码，单机实验路径。配置与实现明确FP32递归状态，不能把所有状态按BF16估算。
- **SGLang #46927仍为open**：有模型、预览/验证、KV及递归状态管理、CUDA Graph及H200实验，尚非上游发布能力。PP仅1；Attention DP/CP、DCP及未验证EP后端仍被限制。审查讨论曾报告近上下文上限的预留槽问题，采用前应针对固定提交重新验收，不能仅依据发布稿启动生产服务。
- **llama.cpp #31306于11月2日merged，但只支持AR**：自推测被拆到另一PR，不能把它写成扩散/自推测已合入。HF自动生成的vLLM使用示例也不是正式支持证据；本轮没有取得vLLM或DeepInfer的对应合并/发布记录。

下一步应先固定解码语义与引擎提交，选择严格argmax校验或threshold质量门槛，验收上下文边界、停止/取消后KV与状态回收，再用H200真实agent请求测质量、TTFT、p99和峰值显存。H100不能只凭同属Hopper就承诺同样容量或吞吐；Pro5500型号待核实。本条不是建议立即替换现有服务。

## 去重与排除

昨日DiffusionGemma CPU单步不重复。OptiMind-RL的官方活动流显示近期发布，但模型commit落在9月30日、引用论文最新版本仍为1月14日；可读材料不足以确认近期技术新增与质量成本对照，本轮排除。Google近期Gemma tokenizer修复与HuggingFaceTB采样配置变动不当成前沿新方法。

## 来源

- [10月30日工程说明及发布时间](https://huggingface.co/blog/Diffuspace/clover-35b-a3b-preview)
- [官方模型卡](https://huggingface.co/Diffuspace/Clover-35B-A3B-Preview)
- [固定模型配置](https://huggingface.co/Diffuspace/Clover-35B-A3B-Preview/blob/4b0402b65e523d0183a14c431955438714cb16ff/config.json)
- [固定参考实现](https://huggingface.co/Diffuspace/Clover-35B-A3B-Preview/blob/4b0402b65e523d0183a14c431955438714cb16ff/modeling_clover_moe.py)
- [SGLang开放PR与H200验收](https://github.com/sgl-project/sglang/pull/46927)
- [llama.cpp已合并AR支持](https://github.com/ggml-org/llama.cpp/pull/31306)
