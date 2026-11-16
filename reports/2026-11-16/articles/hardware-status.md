平台配方记录驱动、组件和版本，但应用团队仍会更换模型与容器。同一个 `latest` 标签也可能解析到不同镜像。排查 GPU 服务漂移时，需要同时回答“平台按什么配置部署”和“工作负载实际声明了什么”。

**七日补读：NVIDIA 11 月 11 日 17:00 UTC 技术文**介绍 AICR **v1.2.0** 固定的 **k8s-aibom 1.6.2** 集成。教程环境是 **GKE、Kubernetes 1.32+、H100、Container-Optimized OS 和 GKE 管理的驱动/设备插件**；不能将其直接改写为 H200 或 Pro5500 的验证结果。Pro5500 仍是型号待核实的原始名称。

### 从部署意图到可追溯清单

**固定 recipe/catalog → 生成带校验和的组件部署包 → 部署与校验 → namespace 选择加入 → 识别支持的 AI 工作负载 → 生成 CycloneDX 1.6 AIBOM**。记录包含模型、容器和运行时，并为属性给出 declared、inferred、unresolved、verified 等置信级别与证据位置。

这里的清单可以在 Pod 尚未运行时就存在并显示 Ready。它说明声明及可获得的 Pod 解析证据，**不证明调度成功、推理执行成功或整个集群完全符合配方**。namespace 标签控制哪些命名空间产生清单，并不把 informer 的读取范围缩小到这些命名空间。

### 开销数字测的是什么

原文的约 **4 次 API-server 请求/分钟、2.2 millicores、28–34 MiB**，来自上游 **k8s-aibom v1.6.1、CPU-only 节点、工作负载 Pod 仍 pending** 的 15 分钟稳态观察。这是控制器清单开销，不是 H100 推理负载下的测量，更不是 LLM 吞吐提升。

工程上可先将镜像 digest、模型版本与清单关联，用于排查跨节点漂移；运行成功仍要看 Pod、服务健康和真实请求。覆盖限于受支持且有可识别 AI 信号的工作负载，运行观察本身默认未签名，模型签名验证也默认未启用。不要把“已有清单”当成完整的上线验收。

原始来源：[原始来源 1](https://developer.nvidia.com/blog/validating-gpu-platforms-with-runtime-ai-inventory-via-the-nvidia-dsx-ai-factory/)；[原始来源 2](https://developer.nvidia.com/blog/feed/)。
