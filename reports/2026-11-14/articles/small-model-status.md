接入小型视觉语言模型时，如果同一句提示以字符串传入和以多模态内容块传入得到不同编码，问题可能在模板，而不是模型规模太小。

SmolVLM-500M 的 **11 月 13 日 08:37 UTC** 提交 `753c175` 修正了这个边界。旧模板把 `message.content` 当作块列表遍历，再逐个判断 image/text 类型；普通字符串不满足这种结构，文本会被遗漏。新模板先判断 `content is string`，直接输出字符串；否则继续走原来的多模态块分支。

### 两种输入，都要有明确含义

| 输入方式 | 本次模板的处理 |
| --- | --- |
| `content` 为普通字符串 | 新增分支直接保留该文本 |
| `content` 为 image/text 块列表 | 保留原有逐块处理路径 |

这属于输入正确性修复。最直接的验收不是只看模型能否加载，而是检查模板输出是否保留用户文本、角色边界和图像位置；随后再对照一组固定任务观察最终回答。系统消息、普通文本、多模态块与多轮消息应分别覆盖，避免一个成功例子掩盖另一种输入形式的问题。

### 500M 的资源与质量边界

模型卡描述的是由 SmolLM2-360M 和约 93M 视觉编码器组成的小型视觉语言模型，支持图像与文本输入，输出文本。本次没有更换模型权重，也没有提供新的任务质量、速度或显存对比，因此不能称作新的 SOTA 模型发布。

模型卡已有单图资源说明，但不能拿缺少本轮硬件、精度和上下文条件的数字，推导多图或长会话部署容量。选择小模型仍要把任务质量、可接受错误、输入分辨率、上下文、精度和设备放到同一测试条件下比较；模板修复解决的是“输入有没有被正确送进去”，不会自动提升模型的视觉推理能力。

本轮还核查了 Gemma 与微软小模型入口。FrogNano 的卡注明 9 月发布，11 月的 README/LICENSE 改动不能当作新权重事件，因而没有用它凑一条“今日新模型”。

原始来源：[SmolVLM 500M 模板修复提交](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct/commit/753c1752602b5e739af7a7fa6947a635051897a3)；[父版本模板](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct/raw/a7da5b986cb59b408707209984f360a5f4ad7e47/chat_template.json)；[修复后模板](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct/raw/753c1752602b5e739af7a7fa6947a635051897a3/chat_template.json)；[SmolVLM 500M 模型卡](https://huggingface.co/HuggingFaceTB/SmolVLM-500M-Instruct/raw/main/README.md)。
