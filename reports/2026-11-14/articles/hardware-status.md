边缘视觉系统经常把 GPU 预处理、专用加速器推理和 GPU 后处理分开实现。即便每段都能运行，缓冲区注册、数据布局和同步点仍容易成为集成问题。

NVIDIA **11 月 13 日**的 cuDLA Python 技术文章介绍了 `cuda-bindings 13.3.0` 新增的 `cuda.bindings.cudla`。它是 cuDLA 的薄封装，示例目标为 **Jetson AGX Orin**：Python 侧直接组织 GPU 与 DLA 的执行顺序，而非另建一套计算图框架。

### 实际数据路径

先把固定形状的 FP16 ONNX 模型编译成 DLA loadable，再由 Python 加载。程序读取模型输入输出的描述符，按要求分配 GPU 缓冲区并向 cuDLA 注册。随后在同一 CUDA stream 上依次执行：

```text
输入 → GPU 预处理 → DLA 推理 → GPU 后处理 → 同步读取结果
          同一条 CUDA stream 保持依赖顺序
```

结束时还要注销缓冲区、释放资源。这里的价值是把数据所有权和依赖顺序放在同一条可检查的执行链里，不意味着任意 ONNX 都能直接交给 DLA。

### 编译与运行条件分开看

| 环节 | 文章中的条件及含义 |
| --- | --- |
| 编译示例 | TensorRT 11.4.1、CUDA 13.4 Update 1、JetPack 7.2.2+；固定维度、FP16，并满足 DLA 的张量布局与算子要求 |
| Python 绑定 | Python 3.10+；示例通过 `cuda-bindings` 调用 cuDLA |
| 运行已有 loadable | 依赖 JetPack 提供的 `libcudla`；运行程序本身不必再调用 TensorRT 编译网络 |
| 模式 | 当前 Python 接口支持 hybrid 模式，与 CUDA stream 配合；“DLA standalone loadable”不等于已支持 standalone runtime 模式 |

不支持的层需要在转换阶段处理，形状、stride 和布局也必须与描述符一致。先验证模型能正确落到 DLA，再讨论如何分配 GPU 与 DLA 的工作，能够避免把回退计算误认为专用加速器上的收益。

### 对现有平台的意义

这是一条边缘异构部署路径。文章没有给出足以比较采购成本的端到端延迟、吞吐或功耗结果，不能据此宣称比全 GPU 更省电或更快。

**H100/H200 不具备这里使用的 Jetson DLA**，因此这套接口不是数据中心 GPU 超配手段。Pro5500 仍为型号待核实，不能擅自套用其他 RTX PRO 的规格。对制造业边缘视觉，可先选一个固定形状、受支持算子的小网络，核对输出一致性和 stream 时间线，再测完整流水线的延迟与功耗。

原始来源：[NVIDIA cuDLA Python 技术文章与完整示例](https://developer.nvidia.com/blog/run-native-dla-inference-in-python-on-nvidia-jetson-agx-orin-using-cudla/)。
