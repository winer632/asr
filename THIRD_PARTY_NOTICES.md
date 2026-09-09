# 第三方来源

- `server/vad/fbank.ts` 移植自用户提供工程中的 `frontend/fbank.h` 与 `frontend/fft.cc`；测试目录保留对应原文件。fbank 原文件声明 Copyright (c) 2017 Personal (Binbin Zhang)，Apache License 2.0；FFT 文件保留 Copyright (c) 2016 HR 的原声明。完整 Apache 2.0 文本位于 `LICENSES/Apache-2.0.txt`。
- VAD 状态机和 ONNX 缓存布局来自用户提供的 `vad-new-standalone` 工程。原文件、模型的权属与许可条件保持原样，不对这些材料额外授予开源许可。
- `components/ui/` 来源于 Sites 提供的 Shadcn/Base UI 组件目录；对应依赖的许可证在其包内保留。
- React、ONNX Runtime、ws、Vite 等依赖保留各自许可证，详细版本锁定于 `package-lock.json`。
- `tests/fixtures/` 中的语音由本机 macOS say 生成，仅作为接口与音频处理测试样本，参考文本见 `tests/evidence/asr-capability-summary.json`。

本仓库为私有项目，不改变用户提供模型与原工程的既有权属。

## 公开真人测试样本

真人样本来自 [Google FLEURS](https://huggingface.co/datasets/google/fleurs) 和 [PolyAI MInDS-14](https://huggingface.co/datasets/PolyAI/minds14)，数据集标注为 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。测试时转为 16 kHz 单声道 PCM，并为 FLEURS 样本添加可复现的高斯噪声。原音与衍生音频保存在未提交的 `test-output/real-speech/`，数据集、分组、split、行号及参考文本记录在 `tests/evidence/real-speech-sources.json`。
