# 模型与新架构｜区分模板改动和缓存机制变化

本次已读取 Qwen、zai-org、DeepSeek 官方模型索引及 Qwen3.8-27B 的真实提交记录。GLM/DeepSeek 所读模型记录未见7日窗口内改动；Qwen最近一项为11月7日 response template 与 generation tags 更新，11月8日报已覆盖，本期不重复计新闻，也不解释为注意力/KV布局变化。

Qwen博客入口返回客户端渲染页面壳，未取得技术文章正文。这个缺口与“没有新文章”不同。本期未从所读来源确认新的合格架构进展；FlashOffloading研究的是GLM5.2已有原生稀疏注意力的分层存储，不是新模型发布。

来源：https://huggingface.co/api/models/Qwen/Qwen3.8-27B/commits/main 、https://huggingface.co/zai-org 、https://huggingface.co/deepseek-ai 。

