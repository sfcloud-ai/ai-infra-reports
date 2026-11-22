# 模型服务与 GPU 超配：SGLang 把 MoE 工作区放在 KV 池之前

Kimi K3.1 在 B300 上跑低延迟测试时，模型能正常加载，却会在首个约 16K token 的预填充批次偶发 OOM。此时引擎已经按剩余显存定好了 KV 池，FlashInfer 的 MoE 启动路径才向分配器申请多块工作区，其中一个张量就有 2.83 GiB。这次分配的缺口只有 12–33 MB。[SGLang #51995 的故障记录](https://api.github.com/repos/sgl-project/sglang/pulls/51995)

## 哪一步先占显存

11 月 21 日合入的改动把一次查询移到权重加载阶段。在 SM100 的 trtllm-gen MXFP4 MoE 路径，引擎取预填充缓冲的 token 上限（未设置时用调度器上限），乘以注意力数据并行副本数，再将乘积向上取整到 2 的幂，以这个大小向 FlashInfer 查询所需工作区。引擎先建立一个进程内缓冲，再按余量给 KV 池定容。执行 finalize 的各次 MXFP4 调用可以传入同一块缓冲。[工作区查询、预留与调用点](https://api.github.com/repos/sgl-project/sglang/pulls/51995/files?per_page=100)

![先预留工作区再为 KV 池定容，两条路径的差异](assets/moe-workspace.png)

这改变了谁先拿到显存。2.83 GiB 是旧故障中观察到的一个张量大小，不能当作节省量。分离部署的 decode 进程跳过预留，延后 finalize 和 prepared-routing 路径仍逐次分配；一次前向超过预留的 token 数，也会临时申请额外空间。作者尚未报告新分支在 GPU 上实测的预留大小和 KV 容量。[适用路径及测量边界](https://api.github.com/repos/sgl-project/sglang/pulls/51995)

## 放到同一张卡上怎么验

容量预算应为不同模型分别计算权重，为各实例列出 KV、MoE 工作区、图和通信内存。即使两个实例使用相同检查点，进程内复用也不能证明跨进程共享。可先在同版本、同精度下记录启动时的池容量与首个长请求峰值，再让两个租户交错提交长短请求，比较首 token 和逐 token 延迟的 P99，并记录超出预留和单进程退出后的恢复。只有这组同卡数据才能回答可容纳多少并发。
