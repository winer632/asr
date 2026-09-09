# VAD 模型来源

`net.onnx` 直接复制自用户提供的 `~/Desktop/vad-new-standalone/materials/net.onnx`，未替换或重新训练。原模型及工程的权属不因放入本私有仓库而改变。

图输入为 `[1, frames, 80]` 的 fbank 与 14 个状态缓存，输出逐帧二分类概率和更新缓存。TypeScript 接入在 `server/vad/`，初始化按原 C++ `get_default_cache()` 预热。

SHA-256 记录在 `model.sha256`。更新模型时需同时验证缓存布局和特征契约，不能只替换文件名。
