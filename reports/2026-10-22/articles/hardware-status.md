历史归档：原期次 2026-10-22，整理于 2026-11-03。发布与合并状态按原期次保留；以下性能为作者报告，本次未独立复跑。

需要保密推理的服务，不只要保护静态文件，也要回答谁能在计算时读取数据，以及模型或密钥应何时放行。Google 在 10 月 21 日宣布搭载 RTX PRO 6000 Blackwell Server Edition 的 Confidential G4 正式可用。本期将它视为安全交付工程进展，不当作机密计算的新发明，也不据此推荐更换硬件。[当期 GA 公告](https://cloud.google.com/blog/topics/ai-infrastructure/confidential-g4-gpus-are-ga)

### 先证明环境，再放行数据

远程证明提供可核验的环境信息，让数据或模型持有者先检查受信状态，再按策略允许访问或释放密钥。CPU 与 GPU 的保护共同构成执行边界，但证明设备与启动状态，不等于证明应用没有漏洞，或日志不会泄露明文。客户端、TLS 终止位置、外部工具调用和输出授权仍需要单独设计。

当期 G4 CPU 侧使用 AMD SEV，证明依赖 Google Shielded VM 的 vTPM，不能宣传为整个链条完全无需信任云商。普通机密 VM 还需信任 guest 管理员与应用；通过加固镜像约束工作负载的 Confidential Space 是另一层能力，G4 上该产品在公告时尚未 GA。把两者混成“已获得完整可信应用”会越过实际保证。[证明覆盖范围](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/attestation-overview)

### 吞吐损失小，不代表尾延迟已经合格

官方特定单卡负载报告吞吐损失低于 3.5%，没有足够的批量、上下文和 p99 明细来推导任意模型服务结果。当期配置也不支持多节点集群，因而更接近单卡私有推理的验证选项，不是多机大模型服务的通用替代。[配置文档](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations)属于持续更新页面，本文只保留当期核查边界，不将后来状态反写为历史事实。

采用前，应明确安全目标到底是保护宿主机外部访问、限制云端操作者，还是证明具体应用镜像。分别测试证明失败时是否拒绝访问、升级后策略能否正确更新，以及真实流量下的质量、尾延迟和新增费用。若需求要求完全排除云商信任或多节点模型，应先说明配置不匹配。安全能力可以形成交付价值，但价值来自可验证的承诺和运行流程，而非单个“加密已开启”的标签。
