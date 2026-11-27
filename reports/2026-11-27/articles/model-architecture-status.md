# 模型与架构：Qwen4Exp 纯文本解码保留检查点 M-RoPE

## 文本解码和多模态预填充怎样对齐缓存

Qwen4Exp 的预填充 worker 可以接收多模态输入，解码 worker 可以用 `--language-model-only` 运行。此前纯文本初始化会去掉检查点里的 M-RoPE 字段，QSA 索引器则用这些字段决定原始 key 缓存的空间。两端若据此分配不同宽度，就无法沿用同一布局。[原 PR](https://github.com/vllm-project/vllm/pull/69882)

vLLM #69882 于北京时间 11 月 26 日 12:54 合入。三个 Qwen4Exp 入口复用配置钩子，纯文本路径保留 `mrope_section` 等字段，让 QSA 按检查点的位置布局分配空间。回归测试以占位权重启动两层引擎，检查实际文本配置中的 M-RoPE 字段。验证范围是初始化与缓存布局，跨实例传输和模型任务准确率仍未验证。[实现与回归测试](https://api.github.com/repos/vllm-project/vllm/pulls/69882/files?page=1&per_page=100)

## 权重目录与官方文章

zai-org、deepseek-ai、Qwen 的 Hugging Face 作者目录各读了按修改时间倒序的首屏 100 条。最新修改记录分别为 10 月 15 日、11 月 10 日、11 月 20 日（UTC），这三页都无主窗内修改或创建记录。GLM 博客和更新记录、DeepSeek 官方文章入口、Qwen 文章 API 及 Research 页面均未取得正文。现有材料不足以核定厂商的新版本、总参数、激活参数或新增下载状态。[GLM 目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [DeepSeek 目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [Qwen 目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)
