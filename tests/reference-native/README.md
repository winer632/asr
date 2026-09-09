# 原 C++ 特征参考

本目录的 `frontend/fbank.h`、`frontend/fft.*`、`utils/log.h` 保留了用户原工程的内容及声明；`generate.cc` 是测试入口，不参与应用运行。

参考输入是 `tests/fixtures/english_1.wav` 的前 16,000 个 PCM 采样。通过原 C++ 实现生成 `tests/fixtures/fbank-reference.f32`，每帧 80 个 float32，小端序。

```bash
python3 - <<'PY'
import wave
from pathlib import Path
with wave.open('tests/fixtures/english_1.wav') as f:
    Path('/tmp/asr-fbank-reference-input.pcm').write_bytes(f.readframes(16000))
PY
clang++ -std=c++17 -O2 -ffp-contract=off -I tests/reference-native \
  tests/reference-native/generate.cc tests/reference-native/frontend/fft.cc \
  -o /tmp/asr-fbank-reference
/tmp/asr-fbank-reference /tmp/asr-fbank-reference-input.pcm tests/fixtures/fbank-reference.f32
```

`-ffp-contract=off` 避免硬件将 float32 运算融合成 FMA，令跨语言浮点比较具有明确参考。算法与原源码不变。本机 TypeScript 输出与此参考逐值相同，测试允许最大绝对差 `0.0001`。
