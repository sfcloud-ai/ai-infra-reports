机器人示教数据保存在对象存储时，首个样本能读到还不够。训练程序会读取元数据、构建训练和评测子集，再把 reader 传给 DataLoader worker；如果连接选项只在第一次创建时生效，后面的切分或重开仍可能失败。

**七日补读：LeRobot 11 月 12 日 09:43 UTC** 合入 #4794，提交 `2f05d8f64d62a865c368a9fdf0ba3d8423e28035`。它把 `storage_options` 接入实际训练数据路径，并非新策略模型或训练算法。

### 数据进入训练的路径

**DatasetConfig → 远端元数据本地化 → make_dataset → train/eval 子集 → LanceDatasetReader → 序列化与多进程重开**，每一步都传递连接选项。reader 复制传入字典，避免调用方稍后修改 region 等字段改变已有连接。元数据缓存身份包含 endpoint/region 等路由信息，同一 bucket 名称指向不同服务时不会误用同一份缓存；凭据轮换不应制造新的路由身份。

实际代码还拒绝在选项字典中设置 `revision`，版本使用专用字段。训练配置会移除键名含 `token`/`key` 的项目，并提示凭据通过环境提供；这不是对任意秘密字段的完整识别器，仍应把配置当作会被日志记录和保存的内容。

### 已验证与尚未验证

PR 作者报告在 S3 兼容的远端 **PushT Lance 数据集，25,650 帧、206 episodes** 上读取首、中、末样本、重复读取，并验证 **两 worker、batch size 2** 的 DataLoader；图像为 `[3,96,96]` float32，数据保持远端、元数据本地缓存。补丁还包含本地真实 Lance 表加连接替身的回归，两类证据不能混称为同一次生产训练。

这支持“训练数据读取路径贯通”，**不证明 GPU 训练吞吐提升、策略成功率提高或工厂部署有效**。本期未独立复跑。使用前需确认非 streaming 的 Lance 后端；实际代码对 streaming 连显式空字典 `{}` 也拒绝，默认 Parquet/video 后端拒绝非空选项。

面向工业操作，下一步应固定数据版本，验证训练/评测分割无泄漏、worker 重启后样本一致，并在真实并发、带宽和故障条件下测数据等待时间。GR00T、LeRobot、OpenPI 的七日代码也已核查；已报的 GR00T 插值、Praxis 和 SOMA 没有再次充当新成果，软件 agent 的沙箱 RL 没有混入机器人训练。

原始来源：[原始来源 1](https://api.github.com/repos/huggingface/lerobot/pulls/4794)；[原始来源 2](https://api.github.com/repos/huggingface/lerobot/commits/2f05d8f64d)。
