# 硬件与算力平台：Merlin 更新四张 RTX 3090 上的 P2P 解码默认设置

北京时间 11 月 21 日，Merlin Engine 的 3.0.2.2 发布提交更新了 Qwen3.8-27B 在四张 RTX 3090 上的启动配置。使用 `27b-tp4-3090` 且开启 P2P 时，新版启动器为四个解码选项提供默认值。用户显式设置的值优先。[版本提交](https://api.github.com/repos/halt95/merlin-engine/commits/5522dd91266d42b628ba2ffab801b364ed5e384c)

## 升级时要看哪一层配置

从 3.0.2.1 升级时，即使启动命令仍用同一个配置名，引擎拿到的解码选项也可能变化。核对现有服务时，可以先查看 P2P 是否开启，再检查启动环境中有哪些显式覆盖。[版本提交](https://api.github.com/repos/halt95/merlin-engine/commits/5522dd91266d42b628ba2ffab801b364ed5e384c)

项目分别保留了新旧两版的测试卡，记录了各自的构建、四卡主机和启动条件。维护同类主机时，可据此核对本机配置。[3.0.2.1 基线卡](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-12/Qwen3.8-27B-BENCH-CARD.md) · [3.0.2.2 测量卡](https://raw.githubusercontent.com/halt95/merlin-engine/5522dd91266d42b628ba2ffab801b364ed5e384c/benchmarks/2026-11-21/Qwen3.8-27B-BENCH-CARD.md)
