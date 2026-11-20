# 前沿小模型：RynnValue-8B 如何估算离任务完成还有多久

拿到一段尚未结束的机器人轨迹，若要比较两条示范的任务进度，可以问模型“按当前画面，离指定任务完成还差多少秒”。RynnValue 是基于 Qwen3-VL 的语言条件价值模型，输入轨迹视频和任务文字，输出预计剩余时间。这个值可以用来评价轨迹，动作指令仍由策略决定。[固定版本的 LeRobot 模型卡](https://huggingface.co/lerobot/RynnValue-8B/raw/0a245773f2d8940170c1be6750464878d1788bf7/README.md)

## 11 月 19 日新增的是哪个入口

LeRobot 官方目录把 RynnValue-8B 集成仓的创建时间记为 11 月 19 日 15:14:53 UTC。固定版本 `0a245773` 的配置指向达摩院上游权重 `12848f45`，指定 BF16、最多 8 帧、图像最长边 640。LeRobot 的这个入口支持推理，模型卡明确说明不能用其训练命令训练该价值模型。这个可追溯的时间属于 LeRobot 集成仓；材料没有给出原团队首次发布的时间。[官方目录的创建记录](https://huggingface.co/api/models?author=lerobot&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&sort=lastModified) · [固定推理配置](https://huggingface.co/lerobot/RynnValue-8B/raw/0a245773f2d8940170c1be6750464878d1788bf7/config.json) · [模型卡](https://huggingface.co/lerobot/RynnValue-8B/raw/0a245773f2d8940170c1be6750464878d1788bf7/README.md)

名称相近的 4B 仓库早在 11 月 5 日创建。11 月 19 日的提交 `1ea1f9c1` 涉及处理器、模板、文档及图像配置，改动文件中没有模型权重。因此比较 4B 和 8B 的输出时，先固定两边的处理器与取帧方式，否则预处理差异也会落入模型差异。[4B 指定提交的文件清单](https://huggingface.co/lerobot/RynnValue-4B/commit/1ea1f9c1742b0f985ceba6841212793d74506c80) · [两个仓库的时间记录](https://huggingface.co/api/models?author=lerobot&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=50&sort=lastModified)

## 用什么基线判断它值得部署

型号名不足以填入 8B 的精确总参数和每次激活参数。BF16 配置也没有给出实测峰值显存、每秒可评估的轨迹数或质量提升。可复现的第一步是固定上游 revision、相机视角、帧数、任务描述和完成时刻标注，分别测剩余时间绝对误差、完成判断与单轨迹时延，再在同任务集上比较 4B。若计划在同卡运行多个评估实例，还须实测权重和实例状态各占多少显存，以及并发时的延迟。此处已核验的运行入口限于 LeRobot，vLLM、SGLang 和多实例缓存管理仍待验证。
