# Linux 服务器部署与办公网访问

网页、API、实时 WebSocket 和录音/文字下载共用一个 TCP 端口，默认 `5173`。VAD 在本机 CPU 上运行，无需另开端口或占用 GPU；ASR 推理仍调用 `ASR_BASE_URL` 指定的远端服务。

## 端口与网络

推荐在办公网网关终止 HTTPS，再转发到 L40S 的 HTTP 服务：

```text
同事浏览器 -- HTTPS/WSS :443 --> 办公网 HTTPS 网关
           -- HTTP/WS TCP :5173 --> L40S 应用
           -- HTTP/WS TCP :19003 --> ASR 服务
```

| 路径                           | 需要的端口                            | 用途                                  |
| ------------------------------ | ------------------------------------- | ------------------------------------- |
| 办公网网关 → L40S              | TCP 5173                              | 网页、`/api/live`、状态查询和文件下载 |
| 同事浏览器 → 办公网 HTTPS 网关 | TCP 443，或选定的 HTTPS 端口          | 浏览器录音入口                        |
| L40S → ASR 地址                | TCP 19003，或 `ASR_BASE_URL` 指定端口 | 健康检查和模型推理                    |

无需向同事映射 ASR 原始接口、SSH 或 VAD 端口，也无需 UDP 端口。ASR 的 TCP 19003 是应用的出站依赖，网页端口映射不会自动打通这条路径。

浏览器在普通局域网 HTTP IP 地址下无法使用麦克风。需要可信 HTTPS，证书名称要覆盖同事实际访问的域名或 IP；直接忽略自签名证书警告不能作为统一可用的部署方案。规则见 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

如果只做四层 TCP 映射、不提供 HTTPS 终止，应在 L40S 配置 `TLS_KEY_FILE` 和 `TLS_CERT_FILE`，此时同一个 `5173` 端口直接提供 HTTPS/WSS。外部端口可与 5173 不同。不要把 TLS 请求直接转发到仍为 HTTP 的端口。

## 当前办公网入口的 HTTPS 配置

当前映射为 `101.89.57.55:18005 → 10.120.65.10:5173`。如果在 L40S 上终止 HTTPS，可以保留这一映射，使用 [nginx-l40s-https.conf.example](nginx-l40s-https.conf.example)：

```text
同事浏览器 https://101.89.57.55:18005
  → L40S Nginx HTTPS/WSS :5173
  → L40S Node.js HTTP/WS 127.0.0.1:5174
  → ASR_BASE_URL 指定的模型服务
```

这是待接入证书的配置模板；仅提交模板不会自动将现有 HTTP 服务切换成 HTTPS。

接入步骤：

1. 准备浏览器信任、SAN 包含 `101.89.57.55` 的 IP 证书及完整证书链，分别存放到 `/etc/asr/tls/fullchain.pem` 和 `/etc/asr/tls/privkey.pem`。私钥只允许服务器管理员读取。如果使用域名证书，应将访问地址、Nginx 的 `server_name`、跳转地址和 `PUBLIC_ORIGIN` 一起改为该域名。
2. 在 `/etc/asr/asr.env` 设置 `HOST=127.0.0.1`、`PORT=5174`、`PUBLIC_ORIGIN=https://101.89.57.55:18005`，移除 Node.js 的 `TLS_KEY_FILE` / `TLS_CERT_FILE` 配置。HTTPS 由 Nginx 处理。
3. 确认没有进行中的录音，安装上述 Nginx 配置、执行 `sudo nginx -t`，重启 `asr-web` 释放 5173，然后重载 Nginx。
4. 访问 `https://101.89.57.55:18005/`，确认浏览器证书验证通过，再授权麦克风。旧 HTTP 地址会通过 308 跳转到同一外部端口的 HTTPS 地址。该跳转使用 Nginx 的 [497 错误处理](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#error_processing)。

HTTP 响应头、CORS 设置或删除前端安全连接检查都不能让普通 HTTP 页面获得麦克风权限。也不将关闭浏览器安全保护或跳过证书警告作为部署方案。

如果没有域名，Let's Encrypt 已提供 [IP 证书](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)，但需要从公网完成 HTTP-01（TCP 80）或 TLS-ALPN-01（TCP 443）验证，当前 18005 映射不能替代这些验证端口。IP 证书有效期为六天，需要同时配置自动续期并保留验证路径。也可使用公司已向测试设备分发信任的内部 CA 签发证书。

HTTPS 解决浏览器录音权限；模型连通性需要独立满足。若 `/api/status` 的 `upstreamHealthy` 为 `false`，应放通 L40S 到 `10.210.1.23:19003` 的路径，或将 `ASR_BASE_URL` 改成 L40S 可访问的 ASR 映射地址。

## systemd 安装

需要 `/usr/bin/node` 为 Node.js 22.13+，以及 npm、git。以下为首次部署步骤；已有目录时先检查状态，保留配置和录音。VAD 使用包内自带的 CPU 运行库，安装时设置 `ONNXRUNTIME_NODE_INSTALL=skip`，避免额外下载本项目不用的 CUDA 运行库。

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /srv/asr
git clone https://github.com/winer632/asr.git /srv/asr/app
cd /srv/asr/app
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build
npm test

sudo useradd --system --user-group --home-dir /var/lib/asr --no-create-home --shell /usr/sbin/nologin asr-web
sudo install -d -m 0700 /etc/asr
sudo install -m 0600 .env.example /etc/asr/asr.env
sudoedit /etc/asr/asr.env
```

必须填写真实 `ASR_API_KEY`，将以下值设置为：

```dotenv
HOST=0.0.0.0
PORT=5173
RECORDINGS_DIR=/var/lib/asr/recordings
VAD_MODEL_PATH=/srv/asr/app/models/net.onnx
# 反向代理就绪后填写同事实际访问的来源，包括非默认外部端口：
# PUBLIC_ORIGIN=https://asr.office.example
```

密钥仅在服务器配置文件中保存，切勿提交到公开仓库。`PUBLIC_ORIGIN` 用于验证浏览器 WebSocket 的 Origin，在网关使用 HTTPS、后端使用 HTTP 时必须设置。应用不会信任客户端传入的 `X-Forwarded-*` 来绕过来源校验。修改后重启服务。

```bash
sudo install -m 0644 deploy/asr-web.service /etc/systemd/system/asr-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now asr-web
curl --noproxy '*' http://127.0.0.1:5173/api/status
sudo systemctl status asr-web --no-pager
```

`vadReady`、`configured` 和 `upstreamHealthy` 均为 `true` 才表示 VAD、密钥配置及上游健康检查通过；真实识别仍应以音频测试确认。Node.js 服务使用独立系统用户运行，开机自启、异常退出自动重启。录音持久化到 `/var/lib/asr/recordings`，不随代码更新删除。

办公网 Nginx 配置示例见 [nginx-office.conf.example](nginx-office.conf.example)。请将地址、域名和证书路径替换为实际值。网关必须转发 WebSocket Upgrade，并允许长连接，参见 [Nginx 官方文档](https://nginx.org/en/docs/http/websocket.html)。服务使用同源路径，不需要单独的 WebSocket 域名或端口。

当前应用是共享测试空间：可访问服务的同事可以查看、下载页面中的保存记录。应将办公网入口限制在获准参与测试的网络范围。

## 运维与更新

```bash
sudo journalctl -u asr-web -n 100 --no-pager
sudo systemctl restart asr-web
sudo systemctl stop asr-web
```

更新时先确认没有正在录音的用户，再拉取代码、安装依赖、构建并重启。更新前备份代码版本和配置；录音目录独立保留。`npm run test:live` 会调用真实上游并生成测试音频与文字，要求测试进程有正确环境变量；systemd 的配置不会自动传给交互式 shell。
