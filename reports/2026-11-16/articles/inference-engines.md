缓存命中率更高、内核耗时更短，都可能掩盖错误结果。本期两项主线修复分别处理“循环状态对应哪个位置”和“query head 应读取哪个 KV head”；正确性基线建立后，才有资格比较速度。

### vLLM：块中途状态不能登记成完整块

**11 月 15 日 22:59 UTC（北京时间16日06:59）** 合入 #67717，提交 `75f3967ac127cb5cf36b2fee7b7377dca5725d51`。Mamba `align` 前缀缓存从块中部恢复、一次跨过块末时，保留状态可能仍对应恢复点或内部 checkpoint，旧路径却登记完整块 hash。

新流程为：**记录 chunk 起止与非块末状态 → 在 cache_full_blocks 前收窄 block mask → 阻止错误整块状态进入缓存/卸载 → 请求释放时清理记录**。补丁包含 local、local_junction、external 三种回归。

作者最小端到端复现为 **1×GB300、Granite-4.0-tiny-preview、prefix_match_unit=16、dense retention、float32 SSM cache、eager、单序列**，Mamba block为832。修复后受害请求的命中从832降到16，输出回到清缓存参考结果；这是剔除错误命中，**不是命中率或性能提升**。本期未复跑，不外推到所有Mamba模型或H100/H200。

### SGLang：GQA 的尾 tile 不能跨错组

**11 月 15 日 07:06 UTC** 合入 #47802，提交 `40723a52ded9229e221a437254f34bc8a3327251`。GLM-4-32B-0414 的48个query head与2个KV head形成24头分组，而内核tile宽16。旧连续铺排让24–31号query head跨入错误KV组。

新实现给每个KV head分配整数个tile，按组起点生成query索引并mask尾部；24头组使用两个tile。回归覆盖20、24及8、16、32等组大小。

作者在 **H100、该模型、GSM8K 1319题、greedy、step-by-step prompt** 下，Triton由 **50.87%恢复到93.48%**，FA3基线为93.48%；`fp8_e5m2`路径为49.51%→92.87%。换提示会改变分数，不能把这里的结果当不带条件的模型能力。

正确48/2内核使用4个而非3个tile，约**慢1.35倍**；batch32端到端decode约增加1%，batch1基本不变。原先更快是在算错结果。部署时先验证受影响模型/头数组合，再在一致提示、缓存精度和负载下复测质量与延迟；本期未独立执行这些测试，也未宣称全部上游CI通过。

### DeepInfer：所查入口没有新增，不等于完整在线替代

默认分支24小时、七日提交查询及release列表均返回空列表，官方README和基础设施文章索引已读取。结论限于这些入口；不扩展到未查分支或渠道。DeepInfer与FlashInfer是不同项目，不能把离线组件默认当作已具备完整在线KV管理、调度和服务SLO的替代品。

vLLM、SGLang和LMSYS官方博客与代码分别检查；EPD、Inkling及统一内存的既报事件按历史去重。模型服务页和架构页中的另外两项SGLang变化在各自问题下展开，不在这里重复计作新闻。

原始来源：[原始来源 1](https://api.github.com/repos/vllm-project/vllm/pulls/67717)；[原始来源 2](https://api.github.com/repos/vllm-project/vllm/commits/75f3967ac127cb5cf36b2fee7b7377dca5725d51)；[原始来源 1](https://api.github.com/repos/sgl-project/sglang/pulls/47802)；[原始来源 2](https://api.github.com/repos/sgl-project/sglang/commits/40723a52ded9229e221a437254f34bc8a3327251)；[DeepInfer官方说明](https://github.com/deepseek-ai/DeepInfer)。
