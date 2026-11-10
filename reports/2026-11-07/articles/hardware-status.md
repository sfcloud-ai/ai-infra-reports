# 重点硬件｜H100 与 H200 的适用边界

本期研究截止北京时间 2026 年 11 月 7 日 07:26:51。先检查近 24–72 小时，必要时扩展至 168 小时；扩窗条目标明原始日期。

本次检索未发现合格的新硬件事件。以下是本期实际重新读取的静态支持资料，不计入六项新闻；本期论文中的 H100/H200 结果见模型服务板块，不能由产品规格替代实验条件。



本次重新读取NVIDIA H100、H200、RTX PRO 5500官方产品页及MIG指南。H100官方表分别列H100 SXM 80 GB、3.35 TB/s、NVLink 900 GB/s和H100 NVL单GPU94 GB、3.9 TB/s、NVLink 600 GB/s，不能把双卡188 GB误写为单卡。H200 SXM/NVL均列141 GB、4.8 TB/s；SXM和NVL形态及互联拓扑仍须随部署核实。产品表不替代具体内核、驱动/CUDA及引擎支持矩阵。

官方确有“NVIDIA RTX PRO 5500 Blackwell Workstation Edition”产品页，列84 GB GDDR7 ECC与1398 GB/s；本次没有证据确认用户所称“Pro5500”就是该SKU，因此正文继续保留“Pro5500（型号待核实）”，不默认对应、不据此承诺适配。MIG是资源划分与隔离，不是让独立模型权重/KV总量超过物理容量的显存超配。

来源：
- https://www.nvidia.com/en-us/data-center/h100/
- https://www.nvidia.com/en-us/data-center/h200/
- https://www.nvidia.com/en-us/products/workstations/professional-desktop-gpus/rtx-pro-5500/
- https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/
