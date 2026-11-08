# 网易云开放平台 · 最小后端

给 **GitHub Pages / 静态站** 用的一层代理。前端继续放 Pages，密钥和用户 token 只出现在这台服务器上。AxureHub 只适合看原型，不要当正式分享地址。

每人用 **自己的网易云账号扫码**。你的 App ID 只代表这个网站，不代替用户登录。

官方入口：[开放平台](https://developer.music.163.com/st/developer/) · [文档中心](https://developer.music.163.com/st/developer/document)

---

## 你要准备的

1. 开放平台里已经过审的 **App ID**
2. 控制台上传过公钥之后，对应的 **PKCS8 私钥**（千万别进 Git）
3. 一台有 **固定公网出口 IP** 的机器  
   Railway / Render / Fly.io / 普通 VPS 都可以。  
   **不要用 Cloudflare Worker 当第一选择**：开放平台要核对 `clientIp` 和实际出口，Worker 出口不固定，容易空 400。
4. Node.js 18+

GitHub Pages、AxureHub 都没有后端，所以这一层是必须的。

---

## 本地跑起来

```bash
cd ncm-min-backend
cp .env.example .env
```

编辑 `.env`：

| 变量 | 填什么 |
|---|---|
| `NCM_APP_ID` | 控制台 App ID |
| `NCM_PRIVATE_KEY` | PEM 全文（换行写成 `\n`），或 `./app_private_key_pkcs8.pem` 路径 |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `FRONTEND_ORIGIN` | 前端域名，例如 `https://你.github.io`，本地测试用 `http://localhost:8787` |
| `NCM_CLIENT_IP` | 可选。探测不准时填服务器公网 IP |

```bash
npm start
```

浏览器打开 http://localhost:8787 ，用网易云 App 扫码。能看到自己的歌单就通了。

生成密钥（若还没有）：

```bash
openssl genrsa -out app_private_key.pem 2048
openssl pkcs8 -topk8 -inform PEM -in app_private_key.pem -outform PEM -nocrypt -out app_private_key_pkcs8.pem
openssl rsa -in app_private_key.pem -pubout -out app_public_key.pem
```

把 **公钥** 贴进开放平台控制台，**私钥**只放服务器。

---

## 接到你的音乐页（GitHub Pages）

1. 把后端部署到 `https://api.你的域名.com`（或 Railway 给的 `*.up.railway.app`）。
2. 控制台 / 防火墙放行 80/443。
3. `.env` 的 `FRONTEND_ORIGIN` 写成 Pages 地址。
4. 页面里引入客户端：

```html
<script src="https://api.你的域名.com/ncm-client.js"></script>
<script>
  NCM.base = "https://api.你的域名.com";

  async function connectCloudMusic() {
    await NCM.login((qrUrl) => {
      document.getElementById("qr").src = qrUrl;
    });
    const { created, collected } = await NCM.playlists();
    console.log(created, collected);
  }
</script>
```

常用方法：

| 方法 | 作用 |
|---|---|
| `NCM.login(onQr)` | 扫码登录，session 存在浏览器 localStorage |
| `NCM.me()` | 当前用户 |
| `NCM.playlists()` | 我创建的 + 我收藏的 |
| `NCM.tracks(id)` | 歌单歌曲 |
| `NCM.search(q)` | 搜歌 |
| `NCM.song(id)` | 详情；有版权才有 `playUrl` |
| `NCM.lyric(id)` | 歌词 |
| `NCM.like(id, true)` | 红心 |
| `NCM.logout()` | 退出 |

后端路由一览：`GET /health`、`GET /login/qr`、`GET /login/qr/poll`、`GET /api/me`、`GET /api/playlists`、`GET /api/playlists/:id`、`GET /api/search`、`GET /api/song/:id`、`GET /api/lyric/:id`、`POST /api/like`、`POST /logout`。

前端只带 `Authorization: Bearer <session>`。云音乐的 accessToken 和私钥不会下发到浏览器。

---

## 分享给别人时

- 分享 **GitHub Pages 的网址**，不是 AxureHub 预览链。
- 每个人自己扫码，各用各的号。
- 仓库可以公开，但 **`.env`、`.pem` 必须在 `.gitignore`**。
- 开放平台给的播放权比官方 App **窄**：很多歌 `playUrl` 为空。前端应降级为「去网易云听」，不要接逆向直链。
- 用户 token 绑在扫码时的 `deviceId` 上，约 24 小时，后端会用 refreshToken 续。

---

## 部署提示

**Railway / Render / Fly：** 根目录选 `ncm-min-backend`，启动命令 `npm start`，环境变量在面板里填，不要写进仓库。

**自己的 VPS：**

```bash
PORT=8787 npm start
```

前面再挂一层 Caddy / Nginx 做 HTTPS。把 HTTPS 域名填进 `FRONTEND_ORIGIN`。

探测到的出口 IP 会打在启动日志里。如果开放平台一直空 400，把这个 IP 填进 `NCM_CLIENT_IP`。

---

## 不要做的事

- 不要把私钥、App Secret 写进 Pages / Axure 的 JS
- 不要让用户在你的网站上输入网易云密码
- 不要接社区逆向 API（NeteaseCloudMusicApi 一类），网易云发过下线通知
- 不要用 `file://` 调这个后端（没有合格 Origin，cookie/CORS 都乱）
