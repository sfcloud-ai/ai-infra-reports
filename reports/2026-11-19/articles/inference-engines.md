## vLLM：每个调度步更新滑窗 KV 块的扫描下界

启用 KV 卸载后，调度器要跟踪哪些缓存块仍属于当前请求，存储端才能处理末尾那段仍需保存的滑窗数据。vLLM #68359 于 11 月 18 日合入 main（`5ff924e5`）。补丁让调度器在每一步计算过期块的扫描下界，最后一个仍在运行的 decode 步也照此处理。对按计算进度触发存储的处理器，只有 `prefix_cache_retention_interval=None` 且对齐后的滑窗尾段起点低于已存进度时，下界才降至该起点。默认值 `0` 保留原下界。这样，请求结束时，存储端不会把已经失去归属的块当成这个请求的块写出。这是状态正确性修复。

作者报告四个针对性调度器用例在原实现失败、修复后通过。单张 H100、Gemma-2-2B 的实验没有走到被改动的分支。另一个双卡 Gemma-3-1B 离线实验带有测试专用改动，876 次调用中有 132 次走到新的检查下界；该实验的新旧两侧都没有观察到错误归属的存储任务。分支覆盖数不能当作线上故障数，现有对照也没有给出性能收益。

同日合入的 #67053 处理另一类状态：Mamba align 在稀疏模式保留最新的解码边界，待请求释放时登记前缀哈希。其稳态块数、峰值预算和可复用条件详见本期「模型与架构」。

## SGLang：V4 上报计入等待队列，路由副本随机二选一

#51147 已合入 main。引擎配置 KV 事件发布器并开启负载上报、路由器显式启用 `--dp-aware --dp-rank-policy least_tokens` 后，对未被粘性键或前缀确定的请求，随机挑两个 rank，比较引擎报告和本地修正后的负载；V4 上报在用 KV 和排队提示，旧版仅上报在用 KV。任一 rank 读数缺失或过期时，按本路由器的在途请求数回退。MI350X 四 rank 实验观察到的改善是请求分派分散度。原始计数、每 rank 的运行上限及多副本对照见本期「模型服务与 GPU 超配」。

## DeepInfer：开发分支提供 SM120 离线运行路径

#289 合入 `nv-dev`。在八张 RTX PRO 6000 Blackwell Server Edition 上，融合索引和稀疏 MLA 接入使离线 decode 从 6.99 到 7.17 steps/s，prefill 每卡 token 吞吐近似持平。数字来自与较早 SM120 实现的对比；精度测试、PCIe 条件和功能限制见本期「硬件与算力平台」。主线支持清单与开发分支分开看，单机离线对照也无法给出线上 SLO。

**技术博客的可见时间。** vLLM 的 FlyDSL 文章讨论 AMD Instinct 上低并发解码时多个短内核反复启动的开销，以及针对模型融合内核的办法。11 月 18 日，包含原稿的提交触发了官方 Pages 部署。部署从 13:19:11 UTC 运行至 13:20:37 UTC 并成功完成，文章在本期 22:20 UTC 截止前已上线。

LMSYS 的部署记录给出了更精确的边界。包含 SGLang Summit 回顾的 Pages 部署在 11 月 17 日 16:51 UTC 已成功，比窗口起点早五个多小时。包含 Humming 正文的部署在 11 月 18 日 22:20:25 UTC 启动，22:21:47 UTC 完成，均晚于本期 22:20 UTC 截止点。官方公告也在截止后发出。这两篇作为背景阅读；Humming 相关的 SGLang #49873 在核查时仍开放。

## 原始来源

- [vLLM #68359：修复范围与各组测试记录](https://api.github.com/repos/vllm-project/vllm/pulls/68359)
- [vLLM #68359 文件与测试变化](https://api.github.com/repos/vllm-project/vllm/pulls/68359/files?page=1&per_page=12)
- [vLLM #67053：Mamba 状态](https://api.github.com/repos/vllm-project/vllm/pulls/67053)
- [SGLang #51147：DP 路由](https://api.github.com/repos/sgl-project/sglang/pulls/51147)
- [DeepInfer #289：SM120 离线路径](https://api.github.com/repos/deepseek-ai/DeepInfer/pulls/289)
- [vLLM FlyDSL 文章的原始 Markdown](https://raw.githubusercontent.com/vllm-project/vllm-project.github.io/main/_posts/2026-11-18-flydsl-monokernels.md)
- [FlyDSL 文章的官方 Pages 部署记录](https://github.com/vllm-project/vllm-project.github.io/actions/runs/44312492745)
- [FlyDSL 原稿的提交时间](https://github.com/vllm-project/vllm-project.github.io/commit/745dac974059d9596e04b4349ea6af161a7878dd)
- [Summit 回顾的 Pages 部署记录](https://github.com/lm-sys/lm-sys.github.io/actions/runs/44130250081)
- [Humming 文章的 Pages 部署记录](https://github.com/lm-sys/lm-sys.github.io/actions/runs/44410616094)
- [LMSYS Summit 回顾](https://www.lmsys.org/blog/2026-11-17-sglang-summit-recap/)
- [LMSYS Humming 公告](https://x.com/lmsysorg/status/2123199188414664812)
- [LMSYS Humming 正文](https://www.lmsys.org/blog/2026-11-18-humming-sglang/)
