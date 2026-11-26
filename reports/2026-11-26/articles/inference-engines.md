# 推理引擎每日变动：SGLang 怎样保住已完成的 KV 传输

## vLLM

本期有两项已合入的变更直接影响部署。#69677 让同一 TP 组中完全复制的 MLA KV 在每台主机上仅卸载一份；#66884 为 GLM-5.3-Flash 的长提示增加 KDA 卷积路径。前者的容量验证使用双机 H100，后者的首 token 时延来自 GB300，分别见服务页和架构页。[CPU 卸载](https://github.com/vllm-project/vllm/pull/69677) · [KDA 预填充](https://github.com/vllm-project/vllm/pull/66884)

另一项 #69901 于 11 月 26 日 07:26:57 合入，已过 06:20 截稿线。同一提交的两页状态结果中，七条带 B200 标签的记录均在截稿后创建，最早为 06:21:50。现有记录无法确认截稿前评审者已在 B200 上实跑，也无法还原截稿瞬间所有检查的状态。[PR 与合入时间](https://github.com/vllm-project/vllm/pull/69901) · [同一提交的状态首页](https://api.github.com/repos/vllm-project/vllm/commits/fc1a999e8c0093c147970937e5876edb16863957/status?page=1&per_page=100) · [状态第二页](https://api.github.com/repositories/599547518/status/fc1a999e8c0093c147970937e5876edb16863957?page=2&per_page=100)

## SGLang

在预填充和解码分离部署中，调度器读到“成功”之前，传输线程可能已经交完所有 KV 块。11 月 25 日 11:56 合入的 #52654 修正了这段间隔内的取消处理：已成功、没有待完成块且必要清理已经结束时，发送端保留完成状态。仍有数据在途或清理尚未结束时，取消继续按失败处理。Mooncake 路径也收敛为一次读取传输状态，使清理逻辑前后使用同一个观测值。[SGLang #52654](https://github.com/sgl-project/sglang/pull/52654) · [状态判断与 CPU 单元测试](https://api.github.com/repos/sgl-project/sglang/pulls/52654/files?page=1&per_page=100)

这使预填充端可以记录已经交付的 KV，解码端可以继续生成。PR 的验证范围是 CPU 单元测试；作者没有提供可在线稳定复现的路由场景、GPU 传输性能或包含此变更的发行版本。生产环境的错误率和吞吐收益仍待测。[作者说明及验证边界](https://github.com/sgl-project/sglang/pull/52654)

## DeepInfer

默认分支查询返回六条提交，最新日期为 11 月 3 日。DeepSeek 的开放基础设施 README 列出了项目和文章，也包含历史内容；仅凭这份索引不能确定本期有新技术文章。其他分支、合入 PR 和 release 的全量记录仍缺，官方新闻入口本次连接失败。[默认分支提交](https://api.github.com/repos/deepseek-ai/DeepInfer/commits?page=1&per_page=100) · [官方基础设施索引](https://api.github.com/repos/deepseek-ai/open-infra-index/readme)

## 检索范围

vLLM 和 SGLang 的已关闭 PR 列表各读三页，每页 100 条。第三页已到 24 小时下界；三页按 PR 编号去重后分别有 275 和 280 个，vLLM 第二页还出现顺序回跳。两个列表仍有下一页，72 小时回看未查全。SGLang 自有博客最近可见的文章卡片为 11 月 12 日。vLLM 归档中 11 月 23 至 24 日的三个链接，以及 LMSYS 目录中标为 11 月 23 日的两篇文章，都还缺正文和带时区的发表时间。两家引擎的提交与发行版本也未查全。[vLLM 第三页](https://api.github.com/repositories/599547518/pulls?direction=desc&page=3&per_page=100&sort=updated&state=closed) · [SGLang 第三页](https://api.github.com/repositories/740303686/pulls?direction=desc&page=3&per_page=100&sort=updated&state=closed) · [vLLM 归档](https://vllm.ai/blog/archive) · [SGLang 博客](https://www.sglang.io/blog) · [LMSYS 目录](https://www.lmsys.org/blog/)
