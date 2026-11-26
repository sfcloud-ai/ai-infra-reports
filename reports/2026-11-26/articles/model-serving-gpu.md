# 模型服务与 GPU 超配：双机卸载 MLA 缓存，16 MiB 从 256 块增至 512 块

给跨机推理引擎划出 16 MiB 的 CPU 卸载空间，能存多少上下文，取决于同一份 KV 被写了几次。vLLM 于 11 月 25 日 17:10 合入 #69677。在两台各装两张 H100 的主机上，四个张量并行进程持有相同的 MLA KV。原先每个进程各写一份，现在每台主机由第一个进程写入，本机两个进程都从这份副本恢复。配置里的 CPU 容量仍是整个引擎的预算。[vLLM #69677 的设计和实验](https://github.com/vllm-project/vllm/pull/69677) · [卸载路径与测试改动](https://api.github.com/repos/vllm-project/vllm/pulls/69677/files?page=1&per_page=100)

![双机四个 H100 进程的复制型 MLA KV 从每台主机两份 CPU 副本减至一份](assets/mla-host-copies.png)

## 同一份预算装下多少块

| 两机各两张 H100，CPU 总预算 16 MiB | 可容纳的块数 |
| --- | ---: |
| 每个 TP 进程保存一份 | 256 |
| 每台主机保存一份 | 512 |

四个进程恢复出的字节都与原数据一致。作者另清除 GPU 前缀缓存，让两条 DeepSeekV2 提示各从 CPU 重新加载 512 个 token，两次运行的 48 个输出 token 均可复现。这个结果适用于整个并行组持有相同 KV 的情形。若各进程持有不同分片，仍须为各分片留空间。部署不同模型时也要分别预算权重。本次实验没有测量多租户争用时的吞吐和尾延迟。[H100 测试记录](https://github.com/vllm-project/vllm/pull/69677)

## 中间那块 KV 能否单独预热

假设一条提示的首块已经逐出，服务只想把第二块预热到指定节点。LMCache 于 11 月 26 日 04:01 合入 #6877。传入 `token_ids` 时，块哈希要从提示开头逐块计算；已知块键时，协调器可以直接定位中间块，并在目标节点已登记的各组和 rank 上预取所需副本。作者的多进程测试覆盖了首块已从两层存储消失的情形。[LMCache #6877](https://github.com/LMCache/LMCache/pull/6877) · [协调器与端到端用例](https://api.github.com/repos/LMCache/LMCache/pulls/6877/files?page=1&per_page=100)

同一个逻辑块可以有多个物理副本。LMCache 的锁定以逻辑块为单位，删除则按实际存放位置分批执行。运维核对删除结果时，要看每个节点完成了多少；评估还能否多部署一个实例，则要另测显存峰值与服务延迟。上面的两倍容量只来自 vLLM 的双机卸载实验。[块键、副本和返回计数的定义](https://github.com/LMCache/LMCache/pull/6877)

### 跨仓检索覆盖到哪里

24 小时主窗内，内存、调度、计算和数据路径四类查询各读两页，每类 40 条。160 行结果对应 141 个不同仓库，其中 31 行的推送时间晚于截稿。[内存检索](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+%22KV+cache%22+offload+GPU+in%3Areadme+pushed%3A2026-11-24T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [调度检索](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+%22multi-tenant%22+scheduling+isolation+in%3Areadme+pushed%3A2026-11-24T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [计算检索](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+kernel+matrix+throughput+inference+in%3Areadme+pushed%3A2026-11-24T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [数据路径检索](https://api.github.com/search/repositories?order=desc&page=2&per_page=20&q=is%3Apublic+GPU+RDMA+transfer+storage+in%3Areadme+pushed%3A2026-11-24T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated)

把窗口扩至北京时间 11 月 23 日 06:20 至 26 日 06:20 后，四类查询各读首屏 20 条，均有下一页。80 行对应 67 个仓库。按结果所列推送时间，66 行落在最后 24 小时，14 行晚于截稿，更早 48 小时的推送没有出现在首屏。按仓库 ID 对照，66 个仓库已见于主窗样本。唯一新增仓库 Atlas-Inf/atlas 在计算查询中排第 16，所列推送时间为 26 日 15:24，晚于 06:20 截稿。本页两项变更的时间与机制均据各自的 PR 核定。 [内存 · 72 小时首屏](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+%22KV+cache%22+offload+GPU+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [调度 · 72 小时首屏](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+%22multi-tenant%22+scheduling+isolation+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [计算 · 72 小时首屏](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+kernel+matrix+throughput+inference+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated) · [数据路径 · 72 小时首屏](https://api.github.com/search/repositories?order=desc&page=1&per_page=20&q=is%3Apublic+GPU+RDMA+transfer+storage+in%3Areadme+pushed%3A2026-11-22T22%3A20%3A00Z..2026-11-25T22%3A20%3A00Z&sort=updated)
