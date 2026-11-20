# 硬件与算力平台：从显微镜探测器到 GPU 能谱

电子能量损失谱实验要同时看清强信号和弱信号。伯克利实验室的高动态范围相机每秒可产生超过 500 Gbit 的数据。操作人员若想在测量中调整采集区域，除了把数据接进来，还需要及时看到校正后的能谱。NVIDIA 于 11 月 19 日公开了这条采集路径。[NVIDIA 仪器案例及图 1–3](https://developer.nvidia.com/blog/enabling-real-time-ai-for-scientific-instruments-with-gpu-native-data-acquisition/)

## 数据在哪一段进入显存

FPGA 读出电路将探测器数据打成以太网包，DAQIRI 直接接收到 GPU 显存，GPU 再组装、校正探测器帧，归约成能量损失谱。**超过 500 Gbps** 描述相机的数据产生速率。要用它给另一套仪器选型，仍需测实际包长分布、NIC 到显存路径及持续处理能力。[探测器、网络和 GPU 的数据流](https://developer.nvidia.com/blog/enabling-real-time-ai-for-scientific-instruments-with-gpu-native-data-acquisition/)

![探测器经 FPGA 和以太网把包送入 GPU 显存，随后组帧、校正并生成能谱；环回测试只测应用发送到接收。](assets/instrument-path.png)

## 小包吞吐和控制环时延各测了什么

原文图 3 在 **NVIDIA IGX Thor、单队列**条件下比较 ibverbs 与原先的 DPDK 后端。64 字节和 256 字节包的每 CPU 核吞吐接近翻倍；到 8 KB 包，两者接近。短包较多时，每包的 CPU 开销值得优先排查；大包占主导时，应按实际包长重测。另一次测试在同机线缆环回中让应用线程直接收发包，省去独立 I/O 工作线程之间的交接，应用发送至接收约 **2–4 微秒**。这个计时终点是应用收到数据，显微镜的帧校正、能谱计算和反馈执行都在另一条测量链上。[原文图 3 和直接轮询实验](https://developer.nvidia.com/blog/enabling-real-time-ai-for-scientific-instruments-with-gpu-native-data-acquisition/)

移植到生产仪器时，可先在相同网卡、队列和 CPU 核数下回放真实包长分布，再单独测从探测器曝光到输出能谱的完整周期。本次没有 H100、H200 或 Pro5500（型号待核实）的等价对照，无法依据 IGX Thor 的结果为这些设备填写吞吐或时延。
