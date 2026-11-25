# 模型与架构：ERNIE 5.5 Flash Preview 每步激活 14B，部署仍要算哪些显存

14B 是每生成一个 token 激活的参数量，部署时仍要装下包含 280B 总参数的模型。北京时间 11 月 24 日 17:00，百度 ERNIE 团队与 vLLM 联署发布 ERNIE 5.5 Flash Preview 的首日支持说明。这是基于此前 Flash Base 的首个后训练版本。百度公告写到当时已在千帆提供 API，权重将以 Apache 2.0 开放。取证时，百度的 Hub 仓已公开、免门控，固定快照列出 129 个 safetensors 文件名。[百度发布公告](https://ernie.baidu.com/release/ernie-5-5-flash-preview/)

17:00 是联署文章有时区的发表时间；权重仓创建与修改的时间不能确定首次开放下载的分钟。[联署技术文章](https://vllm.ai/blog/2026-11-24-ernie-5-5-flash-preview) · [百度固定版本模型卡及许可](https://huggingface.co/baidu/ERNIE-5.5-Flash-Preview/tree/ace1100dcde7bf4eb06add6ae11ce4f43a11ddfe)

## 两种注意力怎样影响状态预算

43 层中，37 层使用重压缩注意力 HCA，6 层使用结合稀疏选择的 MLA。第一层是稠密前馈，其余 42 层使用 MoE，每个 token 从 512 个路由专家中选 10 个，另有一个共享专家。配置支持最长 1,048,576 token。默认权重把路由专家存为 MXFP4，其余权重为 FP8；KV 和稀疏索引也有各自的数据格式。FlashIndexer 用查询的隐藏状态挑选少量索引头，再预筛候选 token。团队在百万上下文报告的 1.4 倍加速指这条索引路径；不能代入整个请求的首 token 时延。[固定模型配置](https://huggingface.co/baidu/ERNIE-5.5-Flash-Preview/raw/ace1100dcde7bf4eb06add6ae11ce4f43a11ddfe/config.json) · [索引和量化实现说明](https://vllm.ai/blog/2026-11-24-ernie-5-5-flash-preview)

![43 层中的注意力与专家布局，以及模型上限和 FP8 插件示例的上下文长度](assets/ernie-attention.png)

## 用什么配置评估显存

可复用的部署证据是 vLLM 0.32.0 配百度 vLLM-ERNIE 插件。插件固定提交声明该确切依赖，README 限定 NVIDIA GPU，给出注意力数据并行与专家并行、以及注意力 TP2/4/8 的配置。模型和插件均附 Apache 2.0 许可。README 将 FP4、FP8、BF16 版本的权重分别估为约 155、280、560 GB。其 FP8 示例中，8 张 80 GB 卡、注意力 DP8、显存利用率 0.93 时，配置可到 262,144 token，不能达到模型的标称百万窗口。这才是评估在线容量时可参照的组合。[插件固定版本部署表](https://github.com/baidu/vLLM-ERNIE/blob/ba322a5634f91d3e6f96ae711df72ddaf3c38b6e/README.md) · [插件依赖](https://github.com/baidu/vLLM-ERNIE/blob/ba322a5634f91d3e6f96ae711df72ddaf3c38b6e/pyproject.toml)

## 两卡工作站上，同一实例如何读回长前缀

作者在两张 96 GB RTX PRO 6000 Blackwell Max-Q（每卡 300 W）、PCIe Gen5、无 NVLink、128 GB 主机内存上，给官方插件加了单独的 sm_120 分派补丁。131,072 上下文配置启用 DSpark，作者报每卡模型加草稿权重 80.0 GiB。另一配置关闭 DSpark、提高显存利用率至 0.98，并为每个 rank 配 16 GiB CPU KV 池，报告 GPU KV 每卡 14.17 GiB。后者先冷处理 462,263 token，耗时 126.29 秒，另一会话使首个前缀被逐出后，再次读取首个前缀用了 2.12 秒，返回 462,080 个缓存 token。这是同一模型实例的前缀重用，且两套配置同时改变了多个参数。该记录为自行改过插件的社区作者实测，适用范围与官方部署表分别列出。[固定实现提交](https://github.com/milesangelo/vllm-ernie55-sm120/commit/eeeff15e659d656174e166237b7bbf14f7db8f74) · [原实验表](https://github.com/milesangelo/vllm-ernie55-sm120/blob/5dda9c0bebf05019faae3c576553d547f4de0a8f/README.md)

若两实例共卡，先按完整模型权重和每实例独占部分分别列预算。验证权重共享时，可以先对齐两个实例的 checkpoint、量化布局和并行拓扑。即便权重能共享，每个实例的请求 KV、稀疏索引、推测解码状态、专家工作区、通信和图捕获内存仍需分别计量。原件证实了原生插件路径；其他 KV 管理器对 HCA 和 MLA-DSA 两类页面的增长、回收、前缀复用，以及一方退出时的隔离，均需在目标环境验证。当前不能据 14B 激活量给出双实例卡数或尾延迟承诺。

## 同窗还核对了哪些发布渠道

正式核查读取了 GLM、DeepSeek、Qwen 在 Hugging Face 的官方模型目录。三个首页均按最后修改时间从新到旧排列，各返回 100 项。最新记录分别为 10 月 15 日、11 月 10 日和 11 月 20 日，均早于本期起点（北京时间 11 月 24 日 06:20）。先期调研曾分别读取 154、106、469 项。[GLM 模型目录](https://huggingface.co/api/models?author=zai-org&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [DeepSeek 模型目录](https://huggingface.co/api/models?author=deepseek-ai&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified) · [Qwen 模型目录](https://huggingface.co/api/models?author=Qwen&direction=-1&expand=createdAt&expand=lastModified&expand=sha&limit=100&sort=lastModified)

三家的 ModelScope 权重目录都未查全。Qwen 的目录首页请求连接失败，GLM 和 DeepSeek 缺少完整的官方账户目录。技术文章也有缺口。DeepSeek 新闻页、Qwen 英文博客的文章接口均因连接失败而未取得正文。GLM 的 Z.ai 博客、智谱官网研究页和 Z.ai 文档的更新记录也都连接失败，三处均无返回正文。先期调研中可读的历史文章和官方动态只支持其中的具体事件。11 月 24 日晨报已报道 GLM-5.4 公告。

跨仓检索按内存、调度、计算、数据路径四类进行。正式核查逐类阅读首页前 20 条，四个查询分别匹配 404、200、422、47 个仓库，后续页仍有结果。先期调研每类查看前 40 条。上面的双卡 ERNIE 案例出现在本次内存检索中，其数字取自项目固定提交和作者实验表。
