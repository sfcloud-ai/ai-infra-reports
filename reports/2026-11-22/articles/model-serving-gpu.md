# 模型服务与 GPU 超配：SGLang 把 MoE 工作区放在 KV 池之前

北京时间 11 月 22 日，SGLang 合入 #51995。此前 Kimi K3.1 在 B300 上做低延迟测试时，权重已加载，KV 池也已定容，FlashInfer 到首个长预填充批次才为 MoE 申请临时空间。这次分配只差 12–33 MB 就能成功。[SGLang #51995 的故障记录](https://api.github.com/repos/sgl-project/sglang/pulls/51995)

## 哪一步先占显存

在 SM100 的 trtllm-gen MXFP4 MoE 路径上，引擎在加载权重时查询所需工作区，预留一块进程内缓冲，再按剩余显存给 KV 池定容。执行 finalize 的调用可以复用这块缓冲。[工作区查询、预留与调用点](https://api.github.com/repos/sgl-project/sglang/pulls/51995/files?per_page=100)

![先预留工作区再为 KV 池定容，两条路径的差异](assets/moe-workspace.png)

分离部署的解码进程跳过预留。延后 finalize、采用 prepared-routing 或单次前向超出预留上限时，仍会临时分配。检查部署效果时，可记录启动后的 KV 池容量和首个长预填充批次的峰值。作者尚未报告改动后实测的工作区大小和 KV 容量。[SGLang #51995 的故障记录](https://api.github.com/repos/sgl-project/sglang/pulls/51995)
