# 模型架构与缓存适配

核查GLM、DeepSeek、Qwen官方模型入口后，本次未发现合格新架构或KV机制进展。Qwen3.8在11月7日更新对话模板的generation边界标签，已读具体diff，不是新权重，也没有新的KV内存或SLO测量。采用自定义Jinja/tokenizer链路的团队应保留模板版本并核验输出及掩码兼容，此为工程建议而非已测收益。Qwen博客返回应用shell，正文访问缺口保留，未写作博客无更新。


官方来源：[Qwen模型](https://huggingface.co/Qwen) · [GLM模型](https://huggingface.co/zai-org) · [DeepSeek动态](https://www.deepseek.com/news/)
