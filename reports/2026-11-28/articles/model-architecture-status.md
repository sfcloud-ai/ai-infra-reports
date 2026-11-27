# 模型与架构：Qwen4Exp 优化 Blackwell QSA，GLM-5.3-Flash 接入 Ascend 预填充 CP

## Qwen4Exp 的 QSA 解码内核

vLLM #70187 于 11 月 27 日 13:17 合入。Blackwell FP8 QSA 按行数选择 split-K 路径，小批量融合页表查找，并按平台能力启用 PDL。新版 PTX 可直接将 FP8 转为 BF16，较旧工具链保留回退路径。11 月 27 日晨报收录的 #69882 处理的是 M-RoPE 配置和 QSA 缓存布局，这次改动对应解码内核。[PR 与基准](https://github.com/vllm-project/vllm/pull/70187) · [补丁](https://api.github.com/repos/vllm-project/vllm/pulls/70187/files?page=1&per_page=100)

作者使用单张 GB300（sm_103），在 H=24、HKV=2、D=256、TOPK=2048、行数 1 至 2048 的 QSA 对照中，报告内核加速 1.07 至 1.92 倍。范围随批次变化，数字对应所列内核与基线。[作者单卡对照](https://github.com/vllm-project/vllm/pull/70187)

## GLM-5.3-Flash 的 Ascend 交错预填充

SGLang #51185 于 11 月 27 日 19:13 合入。交错 CP 将长序列分到多个 rank，KPool 压缩前用 gather 恢复全序列的 key 和 gate score。pooled indexer 用原 query 的位置计算因果边界，同时处理空 rank 和 padding。当前路径要求 eager prefill。[PR](https://github.com/sgl-project/sglang/pull/51185) · [实现与测试](https://api.github.com/repos/sgl-project/sglang/pulls/51185/files?page=1&per_page=100)

![8 张 Ascend 950DT 上，开启 CP8 后平均首 token 时延从 31.43 秒降至 28.20 秒，输入吞吐从 16337.51 升至 18207.02 token 每秒](assets/ascend-prefill-cp.png)

作者使用 8 张 Ascend 950DT、W8A8 MXFP8、BF16 KV、TP8/EP8 和 eager prefill，每组完成 128 次请求。每次 65,536 个输入 token、1 个输出 token，并发 8。开启 CP8 后，平均首 token 时延由 31.43 秒降至 28.20 秒（下降 10.26%），输入吞吐由 16,337.51 升至 18,207.02 token/s（提高 11.44%）。数据适用于该配置，与上面的 GB300 内核结果分别解读。[作者预填充对照](https://github.com/sgl-project/sglang/pull/51185)

## 官方目录与文章入口

GLM、DeepSeek 和 Qwen 的 Hugging Face 作者目录各读按修改时间倒序的首屏 100 条。三个首屏均无主窗内创建或修改记录。三家官方文章入口连接复位，相关替代入口亦未取得正文。以上证据覆盖引擎适配与查到的权重目录，模型参数规模、权重开放和新品发布需相应公告或模型卡支撑。[GLM 目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [DeepSeek 目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [Qwen 目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)
