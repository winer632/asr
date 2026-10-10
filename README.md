# 声迹 ASR

TypeScript 连续录音网页：使用用户提供的 ONNX VAD 检测说话与停顿，通过 SenseNova ASR 公网流式接口转写文字，同时启用上游服务端 VAD。完整录音与每段音频、文本均保存到本地磁盘。

当前在线入口为 <https://asr.bizoe.tech>，部署在阿里云 Linux 服务器，通过 Nginx 提供 HTTPS 和访问认证。

已适配《SenseNova ASR 0930 流式/离线接口对接说明》（2026-10-10）：实时限速发送、同一连接接收多个 VAD 分段 final、繁体中文输出、服务端 VAD 静音阈值与增益配置。页面“文字输出”可选择默认文字或繁体中文，选择同时作用于流式和离线重识别，录音开始后保持不变。默认文字表示不要求繁体转换，不承诺将模型原文转换为简体。

界面已收录实测可自动识别的 12 种语言：普通话、粤语、英语、日语、韩语、阿拉伯语、德语、法语、西班牙语、葡萄牙语、泰语、越南语。语种标签会随识别结果自动高亮，历史记录和新生成的文本文件使用相同的中文标签。

SenseNova ASR 2609 起，服务声明的显式语种为普通话、粤语、英语、阿拉伯语、日语、韩语六种，全称和缩写（zh/yue/en/ar/ja/ko）在流式与文件两个入口都接受；其余六种根据端到端测试加入展示，使用自动检测，不新增显式指定参数。“已实测 12 种”不代表模型支持语言的完整上限。

- [独立响应式 HTML 接口文档](docs/index.html)：手机可阅读，无外部字体、样式或脚本依赖。
- 独立 Sites 文档站已于 2026-09-15 关闭并删除；接口文档请通过上述仓库文件或[在线应用](https://asr.bizoe.tech/asr-api.html)阅读。
- [原始接口测试记录](tests/evidence/)：已验证部分与服务尚未公开的部分分开说明。
- 公开仓库：<https://github.com/winer632/asr>。
- [Linux 服务器部署与 HTTPS 接入](deploy/README.md)。

上游流式识别的 `session_id` 统一使用 `abg-web-<UUID>`，每个语音片段生成一个唯一 ID。语音组可按 `abg-` 前缀筛选本项目的日志；本地 `manifest.json` 中的 `segments[].id` 与该 ID 一致，可用于定位具体片段。命令行示例使用 `abg-example-<UUID>`，探测脚本也使用 `abg-` 前缀。

## 本地运行

需要 Node.js 22.13 或更新版本（建议 Node.js 22 LTS）、npm，以及到所配置 ASR 服务的网络连通性。

```bash
npm ci
cp .env.example .env
```

在 `.env` 中填写 `ASR_API_KEY` 和授权的 `ASR_APP_ID` 后启动：

```bash
npm run dev
```

打开 <http://127.0.0.1:5173>。点击“开始录音”并授权麦克风，持续说话即可。停顿会自动完成当前语音段；点击“停止录音”后会提交尾段音频并等待最终结果。

录音面板上的“识别语种”默认是自动检测，也可以锁定为服务声明支持的六种之一：普通话、粤语、英语、日语、韩语、阿拉伯语。锁定后整段录音都按该语种识别，流式与整段重识别都会带上这个语种，不再自动切换；录音进行中不能改，停止后可以改回自动检测。会议中会混说多种语言时保持自动检测；只说一种语言、尤其是纯英语时，锁定语种更准（9 月版本曾存在英语自动检测退化，0930 本次样本已通过）。

生产方式在可访问 ASR 服务的机器上构建并启动：

```bash
npm run build
npm start
```

这会构建浏览器静态资源和 Node.js 服务。接口文档也可单独双击 `docs/index.html` 打开；本地网页中的“接口文档”路径是 `/asr-api.html`。录音应用在可访问 ASR 的机器运行。

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

WAV 为 16 kHz、单声道、PCM16 小端。每段 TXT 在收到最终识别后保存最终文本，按句号、问号、分号分行；暂定或中断的文字有明确标记。页面下方“已保存的录音”支持成对下载，下载名还会包含录音编号，避免跨录音重名。

音频持续写入磁盘，结束时修正 WAV 头。异常退出遗留的 `.wav.part` 会在服务下次启动时尝试修复。恢复只涉及本地已经收到的音频，无法恢复尚未传到服务器的数据。文件不自动删除，请根据磁盘容量进行备份或归档。页面列出最近 50 次，其他记录仍保留在磁盘。

在“已保存的录音”中，可勾选单条或多条记录后点击“删除所选”，也可使用每条录音右侧的删除按钮。“全选当前列表”只选中当前显示、已结束的录音。确认后会永久删除该录音目录中的完整 WAV、文字稿、清单及全部分段文件；正在录音的记录不可删除。批量删除会分别报告成功、已不存在和失败的记录。

删除接口为 `DELETE /api/recordings`，请求体是 `{"ids":["录音编号"]}`，每次 1–50 条。需使用 `Content-Type: application/json`，并携带与当前网页来源一致的 `Origin`（HTTPS 代理场景由 `PUBLIC_ORIGIN` 指定）。响应包含 `deletedIds`、`missingIds` 和带原因的 `failed`；重复删除不存在的记录不会影响其他录音。当前应用为共享测试空间，能访问网页的使用者可以删除共享列表中的已保存录音。

## 配置

| 变量                             | 默认值               | 作用                                               |
| -------------------------------- | -------------------- | -------------------------------------------------- |
| `ASR_BASE_URL`                   | 见 `.env.example`    | ASR 服务地址，服务路由拼在它的路径之后             |
| `ASR_API_KEY`                    | 无                   | 仅由 Node.js 服务读取                              |
| `ASR_APP_ID`                     | 无                   | 公网服务两个入口都必须填写授权值 |
| `ASR_SERVER_VAD`                 | `1`                  | 上游服务端 VAD，建议开启以避免过长语音报错 |
| `ASR_VAD_INTERVAL_MS`            | `800`                | 上游 VAD 静音截断阈值，范围 100–2000 ms |
| `ASR_TRADITION`                  | `0`                  | 客户端省略 tradition 时的默认值；网页自行选择 |
| `ASR_GAIN`                       | `1`                  | 上游音频增益，必须是有限正数 |
| `VAD_MODEL_PATH`                 | `models/net.onnx`    | 用户提供的 VAD 模型                                |
| `VAD_SILENCE_MS`                 | `600`                | 停顿阈值，范围 300–2000 ms                         |
| `VAD_SOFT_SPLIT_SECONDS`         | `12`                 | 长句收句的最短时长，`0` 关闭，其余取 5–55 s        |
| `VAD_SOFT_SPLIT_PAUSE_MS`        | `200`                | 长句收句所需的判定静音，范围 100–600 ms            |
| `ASR_FILE_RECOGNITION`           | `1`                  | 分段结束后用整段音频重识别，取回标点并补救失败     |
| `PAUSE_PUNCTUATION`              | `1`                  | 服务未给标点时，按测得的停顿补句末标点             |
| `ASR_CONCURRENCY`                | `8`                  | 全服务上游活动会话上限，范围 1–8                   |
| `MAX_CONNECTIONS`                | `8`                  | 浏览器连接上限                                     |
| `HOST` / `PORT`                  | `127.0.0.1` / `5173` | 监听地址与端口                                     |
| `PUBLIC_ORIGIN`                  | 无                   | HTTPS 反向代理后的浏览器来源，包含外部端口（如有） |
| `RECORDINGS_DIR`                 | `recordings`         | 音频、文字、清单保存目录                           |
| `TLS_KEY_FILE` / `TLS_CERT_FILE` | 无                   | 配置后使用 HTTPS，需同时设置                       |

语种由浏览器每次录音时选择，不是服务端配置项。服务端只接受服务声明的六种语种，其余值直接拒绝，不会转发给上游。

## 实现

- React + TypeScript 浏览器界面、AudioWorklet 实时采集、连续相位的抗混叠重采样。
- TypeScript Node.js 服务运行 `onnxruntime-node`；读取原始 `net.onnx`，没有更换成其他 VAD。
- 80 维 fbank 与原 C++ 前端对照；保留 25 ms 窗、10 ms 帧移、Povey 窗、预加重、原缓存预热与判定逻辑。网页停顿默认 600 ms，原工程默认 300 ms。
- 预留音频避免检测启动延迟截断句首；ASR 会话在 55 秒前切换，低于服务声明的 60 秒上限。若某个节点在 `started` 里给出更短的 `max_audio_seconds`，切换点自动跟随该值再留 5 秒余量。
- 同一句讲满 12 秒后，在 VAD 判出的 200 ms 静音处收句；切点由模型给出，续接段用预留音频从切点接上，音频不重不漏。
- 分段结束后把该段 WAV 再发一次 `POST /infer`，用整段上下文取回标点；流式段失败时同一次调用即是补救。超时预算按该段音频时长计算，因为托管网关的整段识别耗时接近音频时长的一半。
- 服务对整段也没给出标点时，按测得的停顿补一个句末标点：句中停顿用「，」，一句结束用「。」。`manifest.json` 中 `text` 始终是服务原样返回的文字，补的标点单独记在 `mark`。
- 语种锁定在服务端按声明列表校验后，同时用于流式 `start` 和整段重识别；`manifest.json` 记录 `requestedLanguage`，文字稿标注“识别语种”。
- 0930 的 partial 只替换当前上游 VAD 语音段，所有上游 final 按顺序保留。客户端发送 end 后，等待服务端 end 或正常关闭才把合并结果作为本地 final；提前关闭或未收到 final 会报告该段失败。上游 sequence 用于过滤重复和过期结果。
- 上游收到 started 后按实时速度发送最多 100 ms 的 PCM 包，启动预留音频与积压音频也经过限速；尾包按实际长度发送，队列排空后只发送一次 end。
- 繁体输出以 tradition 布尔值传入 start，并以字符串 true/false 传入离线表单。录音清单 requestedTradition 记录本次选择，离线补救不会覆盖为不同的文字模式。
- 单段识别失败只标记该段并继续录音；仅麦克风、浏览器连接、磁盘等会话级故障才停止采集。系统暂停音频或切换麦克风时自动恢复。
- 同源 WebSocket 校验、有限缓冲、活动会话上限、握手及最终响应超时、断线与保存失败反馈。
- 音频与文字保存在本地文件系统，不把 ASR key、录音、证书提交到仓库。

### 公网与内网上游地址

0930 文档的正式环境地址带路径前缀：

- 公网 `https://api-gai-volc.sensetime.com/agent-5o/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1`
- 内网 `https://api-gai-volc-internal.sensetime.com/agent-5o/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1`

`/infer`、`/infer/stream`、`/health` 都拼在这个路径之后，不是拼在域名根上；`ASR_BASE_URL` 末尾带不带 `/infer` 都可以。托管服务的 `/health` 也要带 `Authorization`。

公网服务**两个入口都必须带 `app_id`**，向商汤语音组申请后填入 `ASR_APP_ID`。未授权 app_id 的文件接口返回 HTTP 403；新版流式数字错误码包括 106（缺少 APP ID）、201（APP ID 未授权）、202（其他鉴权失败）、401（发送过快）。程序保留错误码，并隐藏上游内部错误详情和凭据。

本次实现以 0930 流式协议为准；文档列为 TODO 的 itn、punctuation、context 不发送。原 ONNX VAD 继续控制本地分段、保存与语音指示，上游 server_vad 负责同一连接内部的语音截断。两个静音阈值分别由 VAD_SILENCE_MS 和 ASR_VAD_INTERVAL_MS 控制。

托管网关整段重识别比办公网网关慢很多：7 秒音频 1.1–2.8 秒对 0.2 秒，57 秒音频 22.8/38.8 秒对 1.0 秒。因此整段重识别的超时按分段时长计算（10–40 秒，超过 20 秒只试一次），浏览器等待最终文字的窗口相应放宽到 75 秒。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 不调用远端 API，验证原 C++ 特征对照、重采样和包边界、真实 ONNX 三语语音检测、静音、流式长句切换、乱序 final、完整文件及分段配对、异常录音恢复、单段失败后继续录音并从 WAV 补救、整段重识别取回标点、长句在停顿处收句且音频不重不漏。

配置有效 `.env` 且能够访问上游时，可以运行真实 ASR 端到端测试：

```bash
npm run test:live
```

测试启动独立临时端口与录音目录，实测三种语言及同一次连续录音中切换三种语言。它核对完整下载 WAV 与输入 PCM 逐字节一致，分段 TXT 与 final 一致。结果在 `test-output/live-results.json`，音频与文本副本保存在 `test-output/recordings/`。测试音频来自本机语音合成，不代表真实噪声、口音或手机效果。

测试还会锁定粤语，分别验证默认文字与繁体输出。可用 `ASR_TEST_APP_URL=http://127.0.0.1:5173 npm run test:live` 直接复测运行中的部署；需要反向代理来源时设置 `ASR_TEST_ORIGIN`。这会创建新的测试录音，并验证部署的下载接口，不会启动第二个应用进程。

`tests/fixtures/fbank-reference.f32` 由原 C++ 前端生成。复现方式见 `tests/reference-native/README.md`。9 月历史补测中，WAV/FLAC/MP3/MPGA/OGG 成功，部分其他容器样本报错；0930 文档已声明支持这些容器，但本次未逐一重测。本应用使用 `/infer/stream`。

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

## 0930 功能验证

2026-10-10：普通话、粤语、英语自动识别，粤语默认/繁体输出，以及连续切换三语共 6 组端到端测试均通过，没有识别告警。下载的完整音频与输入 PCM 逐字节一致，所有分段 TXT 与最终文字一致。公网同一连接返回两段 VAD final 已验证；实测 final 可与前一条 partial 共用 sequence，去重分别按消息类型处理。35 项回归测试、类型检查、lint 和生产构建全部通过。结果见 [tests/evidence/upstream-0930.json](tests/evidence/upstream-0930.json)。

真人 VAD 专项测试：FLEURS 粤语样本重复两次，800 ms 上游阈值返回 2 段，100 ms 返回 12 段；默认阈值合并文本与离线文本一致（去除标点并统一数字形式后比较）。纯静音与本次纯噪声样本没有输出文字。本地 ONNX VAD 对纯噪声会误触发 1 段；10 dB 人工噪声的流式出现个别错字，离线重识别可以更正。只验证了一个真人样本，不能据此保证所有背景噪声或口音表现。证据见 [tests/evidence/server-vad-0930.json](tests/evidence/server-vad-0930.json)。

阿里云在线部署已更新，7 组部署端到端测试通过（含真人粤语），音频与文字下载一致，原有录音文件的完整性校验通过。证据见 [tests/evidence/aliyun-deployment-0930.json](tests/evidence/aliyun-deployment-0930.json)。可通过 `ASR_TEST_REAL_AUDIO` 指定本地的真人粤语 WAV，追加到 `test:live` 验证；独立服务端 VAD 测试为 `npx tsx scripts/test-server-vad.ts`，需先准备保留的 FLEURS 样本。

## 边界与真人样本补测

以下为 2026 年 9 月的历史结果，不能视作 0930 公网接口的现行限制。新版文档规定离线单次默认最长 60 秒，流式以 started.max_audio_seconds 为准；最新功能验证见 tests/evidence/upstream-0930.json。

- WS：60.0 秒成功、60.1 秒 audio_limit；65,536 字节帧成功、65,538 字节 1009；首条 start 等待约 10 秒、启动后无应用消息约 30 秒超时。
- 8 路实时识别均成功；9 个空会话可同时启动，不据此推断最大推理配额。
- HTTP 文件至少通过 120 秒与 16 MiB；这不是已触发的上限。
- 连续运行 10 分钟，73 个 final，完整 PCM 校验一致；本地桥接 RSS 约 82.9–98.5 MiB。
- FLEURS 真人三语样本加 20/10/0 dB 人工噪声，MInDS-14 三个英语地区分组；保留原音、参考文本、ASR 文本和指标。样本很少，不报告总体准确率。
- 合成句内混语样本的 HTTP 结果完整，WS 漏掉开头普通话。远端留存策略及真实手机麦克风表现仍需额外证据。
- 2026-09-15 复测标点，三段音频：30 秒连续口语普通话在 `/infer/stream` 全程无标点，同一文件发到 `POST /infer` 返回完整标点与分句；22 秒粤语连续口语两个接口都不给标点；34 秒清晰朗读的整句两个接口都给标点。证据在 [tests/evidence/streaming-punctuation.json](tests/evidence/streaming-punctuation.json)。
- 2026-09-15 复测上游 2609 变更：显式语种从 3 种扩到 6 种（新增阿拉伯语、日语、韩语），流式与文件入口都接受全称或缩写、忽略大小写；日/韩/阿语自动识别均返回正确语种。`app_id` 与 `max_completion_tokens` 被流式 `start` 拒绝、被文件接口接受。原始记录在 [tests/evidence/upstream-2609.json](tests/evidence/upstream-2609.json)。
- 2026-09-17 按新版 `ASR_API.docx` 迁移到托管网关：地址带路径前缀，`app_id` 在流式与文件两个入口都必填，`/health` 也要鉴权。拿到语音组签发的 app_id 后端到端跑通：流式 `started` 0.17 秒、`max_audio_seconds` 仍为 60、partial 每 2 秒累计下发、`end` 到 `final` 尾延迟 93 毫秒；文件接口自动识别与显式语种都正确。内网地址在本机不解析，公网地址可用。老网关 `10.210.1.23:19003` 同日复测仍可用且更快，留作注释备选。原始记录在 [tests/evidence/upstream-2609.json](tests/evidence/upstream-2609.json)。
- 托管网关新增 `output_limit`：连续 51 秒不停顿的语音在第 36 秒返回 `{"type":"error","code":"output_limit"}`，该段改由整段重识别补回完整带标点文本，录音与文字都没有丢。老网关对应的边界是 60 秒的 `audio_limit`。
- 英语自动识别退化在托管网关同样存在（`english_1`/`english_2` 自动检测仍返回 Chinese，显式传 `en` 正确），两个入口背后是同一个模型。
- 英语自动识别退化的临时规避：在页面上把识别语种锁定为“英语”。实测锁定后与直接传 `language=en` 结果一致，文字和语种都正确。
- 2026-09-15 复测发现英语自动识别退化：`english_1.wav` 与 `english_2.wav` 自动检测都返回 `language: "Chinese"`，2026-09-09 的记录是 English；`english_1` 还把 “please turn” 识别成“请转”。显式传 `language=en` 时两条的语种和文字都正确，普通话与粤语样本的自动检测没有变化，因此问题在自动语种识别，不在英语识别本身。绕开本应用直接调用上游同样如此，`npm run test:live` 的英语语种断言目前会失败，已向服务方反馈。

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

原始测试音频与文本在 `test-output/`，不提交到 Git。`tests/evidence/` 保存精简响应与来源；旧 scripts/update-reference.py 面向 9 月历史报告，不能用于覆盖 0930 文档。接口文档以本仓库的 `docs/index.html` 和构建生成的 `public/asr-api.html` 为准。
