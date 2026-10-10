# Linux 服务器部署与 HTTPS 接入

当前在线入口是 <https://asr.bizoe.tech>，运行在阿里云 Linux 服务器上。Nginx 提供 HTTPS 和访问认证，Node.js 仅监听本机 `127.0.0.1:5173`。VAD 在 CPU 上运行，ASR 推理调用 `ASR_BASE_URL` 指定的远端服务，不需要本机 GPU。

## 当前部署

| 项目 | 配置 |
| --- | --- |
| 浏览器入口 | `https://asr.bizoe.tech` |
| 服务 | `asr-web.service` |
| 应用目录 | `/srv/asr/app` |
| 配置文件 | `/etc/asr/asr.env` |
| 录音目录 | `/var/lib/asr/recordings` |
| Node.js | `/opt/node22/bin/node` |
| 应用监听 | `127.0.0.1:5173` |
| HTTPS 与 WebSocket 代理 | Nginx，TCP 443 |

```text
浏览器 HTTPS/WSS :443
  → Nginx（证书与访问认证）
  → Node.js HTTP/WS 127.0.0.1:5173
  → SenseNova ASR 公网 HTTPS/WSS :443
```

网页、API、实时 WebSocket、录音和文字下载使用同一域名。访问认证覆盖整个站点，获准访问的用户共享录音列表。应用端口仅监听回环地址；外部浏览器使用 HTTPS 入口。

## 配置

真实凭据仅保存在服务器配置文件中，不能提交到 Git。正式环境同时需要 `ASR_API_KEY` 和已授权的 `ASR_APP_ID`。当前部署的其他设置为：

```dotenv
ASR_BASE_URL=https://api-gai-volc.sensetime.com/agent-5o/signpost/v0/prod-agent-5o-sensenova-filabs-asr-v1
HOST=127.0.0.1
PORT=5173
PUBLIC_ORIGIN=https://asr.bizoe.tech
RECORDINGS_DIR=/var/lib/asr/recordings
VAD_MODEL_PATH=/srv/asr/app/models/net.onnx
VAD_SILENCE_MS=600
ASR_SERVER_VAD=1
ASR_VAD_INTERVAL_MS=800
ASR_TRADITION=0
ASR_GAIN=1
ASR_CONCURRENCY=8
MAX_CONNECTIONS=8
```

上游基础地址含路径前缀，`/infer`、`/infer/stream`、`/health` 都拼在此前缀之后。上游 `/health` 也需要鉴权。

`PUBLIC_ORIGIN` 必须与用户实际访问的 HTTPS 来源一致，用于验证浏览器 WebSocket 和删除请求的 Origin。HTTPS 由 Nginx 终止时，不设置 Node.js 的 `TLS_KEY_FILE` 和 `TLS_CERT_FILE`。改用其他域名时，同时调整证书、Nginx 的 `server_name` 与 `PUBLIC_ORIGIN`。

配置文件应由管理员维护并限制读取权限：

```bash
sudo chmod 0600 /etc/asr/asr.env
```

## 首次安装

需要 Node.js 22.13+、npm 和 git。已有部署应使用下方更新流程。`onnxruntime-node` 使用包内 CPU 运行库，安装时跳过本项目不用的 CUDA 运行库下载。

```bash
sudo install -d -m 0755 /srv/asr
git clone https://github.com/winer632/asr.git /srv/asr/app
cd /srv/asr/app
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
npm test

sudo useradd --system --user-group --home-dir /var/lib/asr --no-create-home --shell /usr/sbin/nologin asr-web
sudo install -d -m 0700 /etc/asr
sudo install -m 0600 .env.example /etc/asr/asr.env
sudoedit /etc/asr/asr.env
sudo install -m 0644 deploy/asr-web.service /etc/systemd/system/asr-web.service
```

模板中的 `ExecStart` 默认使用 `/usr/bin/node`。当前阿里云部署使用 `/opt/node22/bin/node`，安装时按实际路径调整服务文件；构建与测试也应使用同一 Node.js 版本。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now asr-web
curl --noproxy '*' http://127.0.0.1:5173/api/status
sudo systemctl status asr-web --no-pager
```

## Nginx 接入

当前站点使用浏览器信任的证书，完整证书链和私钥分别位于 `/etc/asr-tls/fullchain.pem` 与 `/etc/asr-tls/privkey.pem`。私钥仅允许管理员读取。站点的 HTTPS 配置结构如下：

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name asr.bizoe.tech;

    ssl_certificate /etc/asr-tls/fullchain.pem;
    ssl_certificate_key /etc/asr-tls/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    auth_basic "ASR";
    auth_basic_user_file /etc/nginx/.htpasswd-asr;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
```

HTTP 入口保留证书验证路径，其余请求跳转到 HTTPS。证书、认证文件及续期配置由服务器管理员维护；更新应用代码时保留这些文件。

浏览器录音需要安全上下文，见 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。WebSocket 代理需要转发 Upgrade，见 [Nginx 官方说明](https://nginx.org/en/docs/http/websocket.html)。独立网关的通用示例见 [nginx-office.conf.example](nginx-office.conf.example)，应替换域名、证书和应用地址后使用。

## 更新与验证

更新前检查是否有进行中的录音，备份当前代码版本、运行文件、配置和录音；在独立目录构建并测试，再切换服务。录音目录独立于代码目录，更新不删除已有记录。

```bash
sudo journalctl -u asr-web -n 100 --no-pager
sudo systemctl restart asr-web
curl --noproxy '*' http://127.0.0.1:5173/api/status
```

`vadReady`、`configured` 和 `upstreamHealthy` 均为 `true`，且 `serverVad: true`、`vadIntervalMs: 800`，表示当前配置和健康检查通过。真实识别另用端到端音频测试确认。在服务器应用目录中测试当前部署：

```bash
ASR_TEST_APP_URL=http://127.0.0.1:5173 \
ASR_TEST_ORIGIN=https://asr.bizoe.tech \
npm run test:live
```

测试检查三语识别、粤语默认/繁体输出、连续语种切换、完整 PCM 和分段文字下载。指定 `ASR_TEST_REAL_AUDIO` 可追加真人粤语 WAV 测试。测试会创建新录音。

2026-10-10，当前阿里云部署的 7 组端到端测试通过，原有录音文件的完整性校验通过。证据见 [aliyun-deployment-0930.json](../tests/evidence/aliyun-deployment-0930.json)。
