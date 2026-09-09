# 声迹 ASR

TypeScript 连续录音网页：使用用户提供的 ONNX VAD 检测说话与停顿，通过内网 ASR WebSocket 自动检测语种并转写文字。完整录音与每段音频、文本均保存到本地磁盘。

界面已收录实测可自动识别的 11 种语言：普通话、粤语、英语、日语、德语、法语、西班牙语、葡萄牙语、韩语、泰语、越南语。语种标签会随识别结果自动高亮，历史记录和新生成的文本文件使用相同的中文标签。

服务声明的显式语种选项仍为普通话、粤语和英语；其余八种根据用户的端到端测试加入展示，使用自动检测，不新增显式指定参数。“已实测 11 种”不代表模型支持语言的完整上限。

- [独立响应式 HTML 接口文档](docs/index.html)：手机可阅读，无外部字体、样式或脚本依赖。
- 私有在线文档：https://asr-api-winer632.xjtu-wang.chatgpt.site （需本人登录）。
- [原始接口测试记录](tests/evidence/)：已验证部分与服务尚未公开的部分分开说明。
- 公开仓库：<https://github.com/winer632/asr>。
- [Linux 服务器部署与办公网端口映射](deploy/README.md)。

## 本地运行

需要 Node.js 22.13 或更新版本（建议 Node.js 22 LTS）、npm，以及到 ASR 内网地址的网络连通性。

```bash
npm ci
cp .env.example .env
```

在 `.env` 中填写 `ASR_API_KEY` 后启动：

```bash
npm run dev
```

打开 <http://127.0.0.1:5173>。点击“开始录音”并授权麦克风，持续说话即可。停顿会自动完成当前语音段；点击“停止录音”后会提交尾段音频并等待最终结果。

生产方式在同一台内网机器上构建并启动：

```bash
npm run build
npm start
```

这会构建浏览器静态资源和 Node.js 服务。接口文档也可单独双击 `docs/index.html` 打开；本地网页中的“接口文档”路径是 `/asr-api.html`。Sites 部署只发布独立文档，录音应用在可访问 ASR 的机器运行。

## 手机访问

手机阅读 HTML 文档不需要麦克风权限。手机实际录音需要浏览器信任的 HTTPS 地址；普通局域网 HTTP IP 地址通常不允许访问麦克风。

1. 让手机和运行本服务的机器位于可互通的网络。
2. 给局域网域名或服务器 IP 配置手机信任的证书；可以使用内部 CA，或按 [mkcert 官方说明](https://github.com/FiloSottile/mkcert#mobile-devices)生成并在手机上信任开发证书。
3. 在 `.env` 中设置 `HOST=0.0.0.0`、`TLS_KEY_FILE=certs/lan-key.pem`、`TLS_CERT_FILE=certs/lan.pem`，重新启动服务。
4. 在手机上打开证书覆盖的 `https://服务器地址:5173`。保持页面在前台；移动系统锁屏或切到后台可能暂停音频采集。

默认只监听本机。使用 `HOST=0.0.0.0` 会让所在网络的用户能够访问录音服务和已保存内容，请在自己的可信内网使用。具体浏览器规则见 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。尚未进行真实手机设备测试。

## 文件保存与对应关系

默认目录是 `recordings/`，可通过 `RECORDINGS_DIR` 更改。它不会提交到 Git。

```text
recordings/<UTC 时间戳-唯一编号>/
├── recording.wav          完整录音，保留静音
├── transcript.txt         完整文字，包含时间范围和对应分段文件名
├── manifest.json          录音、时间、语种、状态与文件路径映射
└── segments/
    ├── 001.wav
    ├── 001.txt            与 001.wav 对应
    ├── 002.wav
    └── 002.txt            与 002.wav 对应
```

WAV 为 16 kHz、单声道、PCM16 小端。每段 TXT 在收到最终识别后保存最终文本；暂定或中断的文字有明确标记。页面下方“已保存的录音”支持成对下载，下载名还会包含录音编号，避免跨录音重名。

音频持续写入磁盘，结束时修正 WAV 头。异常退出遗留的 `.wav.part` 会在服务下次启动时尝试修复。恢复只涉及本地已经收到的音频，无法恢复尚未传到服务器的数据。文件不自动删除，请根据磁盘容量进行备份或归档。页面列出最近 50 次，其他记录仍保留在磁盘。

在“已保存的录音”中，可勾选单条或多条记录后点击“删除所选”，也可使用每条录音右侧的删除按钮。“全选当前列表”只选中当前显示、已结束的录音。确认后会永久删除该录音目录中的完整 WAV、文字稿、清单及全部分段文件；正在录音的记录不可删除。批量删除会分别报告成功、已不存在和失败的记录。

删除接口为 `DELETE /api/recordings`，请求体是 `{"ids":["录音编号"]}`，每次 1–50 条。需使用 `Content-Type: application/json`，并携带与当前网页来源一致的 `Origin`（HTTPS 代理场景由 `PUBLIC_ORIGIN` 指定）。响应包含 `deletedIds`、`missingIds` 和带原因的 `failed`；重复删除不存在的记录不会影响其他录音。当前应用为共享测试空间，能访问网页的使用者可以删除共享列表中的已保存录音。

## 配置

| 变量                             | 默认值                     | 作用                                               |
| -------------------------------- | -------------------------- | -------------------------------------------------- |
| `ASR_BASE_URL`                   | `http://10.210.1.23:19003` | 内网 ASR 服务地址                                  |
| `ASR_API_KEY`                    | 无                         | 仅由 Node.js 服务读取                              |
| `VAD_MODEL_PATH`                 | `models/net.onnx`          | 用户提供的 VAD 模型                                |
| `VAD_SILENCE_MS`                 | `600`                      | 停顿阈值，范围 300–2000 ms                         |
| `ASR_CONCURRENCY`                | `8`                        | 全服务上游活动会话上限，范围 1–8                   |
| `MAX_CONNECTIONS`                | `8`                        | 浏览器连接上限                                     |
| `HOST` / `PORT`                  | `127.0.0.1` / `5173`       | 监听地址与端口                                     |
| `PUBLIC_ORIGIN`                  | 无                         | HTTPS 反向代理后的浏览器来源，包含外部端口（如有） |
| `RECORDINGS_DIR`                 | `recordings`               | 音频、文字、清单保存目录                           |
| `TLS_KEY_FILE` / `TLS_CERT_FILE` | 无                         | 配置后使用 HTTPS，需同时设置                       |

## 实现

- React + TypeScript 浏览器界面、AudioWorklet 实时采集、连续相位的抗混叠重采样。
- TypeScript Node.js 服务运行 `onnxruntime-node`；读取原始 `net.onnx`，没有更换成其他 VAD。
- 80 维 fbank 与原 C++ 前端对照；保留 25 ms 窗、10 ms 帧移、Povey 窗、预加重、原缓存预热与判定逻辑。网页停顿默认 600 ms，原工程默认 300 ms。
- 预留音频避免检测启动延迟截断句首；ASR 会话在 55 秒前切换，低于服务声明的 60 秒上限。
- partial 替换当前段暂定文字；final 固定该段，通过段 ID 关联，避免网络乱序导致文字错位。
- 同源 WebSocket 校验、有限缓冲、活动会话上限、握手及最终响应超时、断线与保存失败反馈。
- 音频与文字保存在本地文件系统，不把 ASR key、录音、证书提交到仓库。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 不调用远端 API，验证原 C++ 特征对照、重采样和包边界、真实 ONNX 三语语音检测、静音、流式长句切换、乱序 final、完整文件及分段配对、异常录音恢复。

有内网连接和有效 `.env` 时，可以运行真实 ASR 端到端测试：

```bash
npm run test:live
```

测试启动独立临时端口与录音目录，实测三种语言及同一次连续录音中切换三种语言。它核对完整下载 WAV 与输入 PCM 逐字节一致，分段 TXT 与 final 一致。结果在 `test-output/live-results.json`，音频与文本副本保存在 `test-output/recordings/`。测试音频来自本机语音合成，不代表真实噪声、口音或手机效果。

`tests/fixtures/fbank-reference.f32` 由原 C++ 前端生成。复现方式见 `tests/reference-native/README.md`。最新补测中，WAV/FLAC/MP3/MPGA/OGG 文件已成功；MP4/M4A/MPEG/WebM 的代表编码仍报错。本应用使用 `/infer/stream`。协议边界、真人噪声与混语差异均已更新到 HTML 文档。

## 目录

```text
app/                     录音界面与响应式样式
lib/audio/               AudioWorklet、重采样
server/vad/              原模型的 TypeScript 接入
server/archive.ts        WAV/TXT 保存、配对与恢复
server/session.ts        连续录音与 VAD/ASR 会话衔接
server/upstream.ts       上游 WebSocket、超时和容量控制
docs/index.html          独立接口文档
models/net.onnx          用户提供的 VAD 模型
tests/                   自动验证与合成语音样本
```

模型和原工程的权属保持不变。第三方来源与许可说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 边界与真人样本补测

- WS：60.0 秒成功、60.1 秒 audio_limit；65,536 字节帧成功、65,538 字节 1009；首条 start 等待约 10 秒、启动后无应用消息约 30 秒超时。
- 8 路实时识别均成功；9 个空会话可同时启动，不据此推断最大推理配额。
- HTTP 文件至少通过 120 秒与 16 MiB；这不是已触发的上限。
- 连续运行 10 分钟，73 个 final，完整 PCM 校验一致；本地桥接 RSS 约 82.9–98.5 MiB。
- FLEURS 真人三语样本加 20/10/0 dB 人工噪声，MInDS-14 三个英语地区分组；保留原音、参考文本、ASR 文本和指标。样本很少，不报告总体准确率。
- 合成句内混语样本的 HTTP 结果完整，WS 漏掉开头普通话。远端留存策略及真实手机麦克风表现仍需额外证据。

可选测试工具（不在普通 CI 中运行）：

```bash
python3 -m venv .venv-tests
.venv-tests/bin/pip install -r scripts/requirements-asr-tests.txt
.venv-tests/bin/python scripts/measure-asr.py
.venv-tests/bin/python scripts/measure-http.py
.venv-tests/bin/python scripts/prepare-real-audio.py
.venv-tests/bin/python scripts/measure-quality.py
npm run build
npx tsx scripts/test-endurance.ts
```

原始测试音频与文本在 `test-output/`，不提交到 Git。`tests/evidence/` 保存精简响应与来源；`scripts/update-reference.py` 可根据这些证据更新 HTML 文档。独立文档由相邻的 `asr-docs-site/` 发布目录托管，仅发布文档，不包含模型或录音。
