import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  EP,
  NcmError,
  createClient,
  detectPublicIp,
  mapPlaylist,
  mapSong,
  newDeviceId,
  pickToken,
} from "./ncm.mjs";
import { bearer, signToken, verifyToken } from "./session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(ROOT, ".env"));

const PORT = Number(process.env.PORT || 8787);
const APP_ID = process.env.NCM_APP_ID || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const qrTickets = new Map();
const userStore = new Map();

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null) process.env[k] = v;
  }
}

function readPrivateKey() {
  const raw = process.env.NCM_PRIVATE_KEY || "";
  if (!raw) return "";
  if (raw.includes("BEGIN") || raw.length > 80) return raw;
  const abs = path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
  return raw;
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  let allow = FRONTEND_ORIGIN[0] || "*";
  if (!FRONTEND_ORIGIN.length) allow = origin || "*";
  else if (FRONTEND_ORIGIN.includes("*")) allow = origin || "*";
  else if (origin && FRONTEND_ORIGIN.includes(origin)) allow = origin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    Vary: "Origin",
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function servePublic(req, res, url) {
  let rel = url.pathname === "/" ? "/demo.html" : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, "public", rel);
  if (!file.startsWith(path.join(ROOT, "public"))) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": mime(file), "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
  return true;
}

function errorToJson(err) {
  if (err instanceof NcmError) {
    return { error: err.message, code: err.code, extra: err.extra };
  }
  return { error: err.message || String(err) };
}

let ncm;
let clientIp = process.env.NCM_CLIENT_IP || "";

function requireReady() {
  if (!APP_ID || !readPrivateKey() || !SESSION_SECRET) {
    const miss = [];
    if (!APP_ID) miss.push("NCM_APP_ID");
    if (!readPrivateKey()) miss.push("NCM_PRIVATE_KEY");
    if (!SESSION_SECRET) miss.push("SESSION_SECRET");
    throw new Error(`未配置 ${miss.join(", ")}，请先复制 .env.example 为 .env`);
  }
  if (!ncm) ncm = createClient({ appId: APP_ID, pem: readPrivateKey(), clientIp });
}

function getSession(req) {
  const token = bearer(req);
  const payload = verifyToken(token, SESSION_SECRET);
  if (!payload?.sid) return null;
  const rec = userStore.get(payload.sid);
  if (!rec) return null;
  return { sid: payload.sid, token, rec };
}

async function withFresh(rec, fn) {
  try {
    return await fn(rec);
  } catch (err) {
    if (err instanceof NcmError && (err.code === 301 || err.code === 2509) && rec.refreshToken) {
      const next = await ncm.refresh(rec.deviceId, rec.refreshToken);
      if (!next?.accessToken) throw err;
      rec.accessToken = next.accessToken;
      rec.refreshToken = next.refreshToken || rec.refreshToken;
      rec.expireAt = Date.now() + (next.expireTime || 86400) * 1000;
      return fn(rec);
    }
    if (err instanceof NcmError && err.code === 1406) {
      throw new Error("登录已和设备解绑，请重新扫码");
    }
    throw err;
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const headers = corsHeaders(req);

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const send = (status, body) => json(res, status, body, headers);

  try {
    if (url.pathname === "/health") {
      send(200, {
        ok: true,
        configured: Boolean(APP_ID && readPrivateKey() && SESSION_SECRET),
        clientIpSet: Boolean(clientIp),
      });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || !url.pathname.startsWith("/api") && !url.pathname.startsWith("/login") && url.pathname !== "/logout")) {
      if (servePublic(req, res, url)) return;
    }

    requireReady();

    if (req.method === "GET" && url.pathname === "/login/qr") {
      const deviceId = newDeviceId();
      const anon = await ncm.anonymous(deviceId);
      if (!anon?.accessToken) throw new Error("拿不到匿名 token");
      const key = await ncm.qrKey(deviceId, anon.accessToken);
      const ticket = randomUUID();
      qrTickets.set(ticket, {
        deviceId,
        uniKey: key.uniKey,
        anonToken: anon.accessToken,
        createdAt: Date.now(),
      });
      setTimeout(() => qrTickets.delete(ticket), 6 * 60 * 1000);
      send(200, { ticket, qrCodeUrl: key.qrCodeUrl, uniKey: key.uniKey });
      return;
    }

    if (req.method === "GET" && url.pathname === "/login/qr/poll") {
      const ticket = url.searchParams.get("ticket");
      const job = qrTickets.get(ticket);
      if (!job) {
        send(410, { status: 800, error: "二维码已失效，请刷新" });
        return;
      }
      const data = await ncm.qrPoll(job.deviceId, job.anonToken, job.uniKey);
      const status = data?.status ?? data?.code;
      if (status === 803) {
        const tok = pickToken(data) || pickToken(data?.accessToken) || pickToken({ accessToken: data });
        if (!tok?.accessToken) {
          send(500, { error: "扫码成功但未返回 accessToken", rawKeys: Object.keys(data || {}) });
          return;
        }
        const sid = randomUUID();
        const rec = {
          deviceId: job.deviceId,
          accessToken: tok.accessToken,
          refreshToken: tok.refreshToken || "",
          expireAt: Date.now() + (tok.expireTime || 86400) * 1000,
          profile: null,
        };
        try {
          rec.profile = await ncm.get(EP.profile, rec, {});
        } catch {
          rec.profile = null;
        }
        userStore.set(sid, rec);
        qrTickets.delete(ticket);
        const session = signToken({ sid }, SESSION_SECRET);
        send(200, {
          status: 803,
          session,
          profile: rec.profile,
        });
        return;
      }
      send(200, { status: status ?? 801 });
      return;
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      const sess = getSession(req);
      if (sess) userStore.delete(sess.sid);
      send(200, { ok: true });
      return;
    }

    const sess = getSession(req);
    if (!sess) {
      send(401, { error: "未登录" });
      return;
    }
    const rec = sess.rec;

    if (req.method === "GET" && url.pathname === "/api/me") {
      const profile = await withFresh(rec, (r) => ncm.get(EP.profile, r, {}));
      rec.profile = profile;
      send(200, { profile });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/playlists") {
      const [createdRaw, subedRaw] = await withFresh(rec, async (r) => {
        const created = await ncm.get(EP.playlistCreated, r, { limit: 100, offset: 0 });
        const subed = await ncm.get(EP.playlistSubed, r, { limit: 100, offset: 0 });
        return [created, subed];
      });
      const created = (createdRaw?.records || []).map((x) => mapPlaylist(x, "created")).filter(Boolean);
      const collected = (subedRaw?.records || []).map((x) => mapPlaylist(x, "collected")).filter(Boolean);
      send(200, { created, collected });
      return;
    }

    const tracksMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)$/);
    if (req.method === "GET" && tracksMatch) {
      const playlistId = decodeURIComponent(tracksMatch[1]);
      const limit = Number(url.searchParams.get("limit") || 200);
      const offset = Number(url.searchParams.get("offset") || 0);
      const data = await withFresh(rec, (r) =>
        ncm.get(EP.playlistTracks, r, {
          playlistId,
          limit,
          offset,
          qualityFlag: false,
          trialScene: "cli",
        }),
      );
      const list = Array.isArray(data) ? data : data?.records || [];
      send(200, { tracks: list.map(mapSong).filter(Boolean) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") || "";
      if (!q) {
        send(400, { error: "缺少 q" });
        return;
      }
      const data = await withFresh(rec, (r) =>
        ncm.get(EP.searchSong, r, {
          keyword: q,
          limit: Number(url.searchParams.get("limit") || 20),
          offset: Number(url.searchParams.get("offset") || 0),
          qualityFlag: false,
          trialScene: "cli",
        }),
      );
      const records = data?.records || data?.songs || [];
      send(200, { songs: records.map(mapSong).filter(Boolean), total: data?.recordCount ?? records.length });
      return;
    }

    const songMatch = url.pathname.match(/^\/api\/song\/([^/]+)$/);
    if (req.method === "GET" && songMatch) {
      const songId = decodeURIComponent(songMatch[1]);
      const data = await withFresh(rec, (r) =>
        ncm.get(EP.songDetail, r, {
          songId,
          withUrl: true,
          bitrate: 320,
          trialScene: "cli",
        }),
      );
      send(200, {
        song: mapSong(data) || data,
        playUrl: data?.playUrl || null,
        playUrlExpireTime: data?.playUrlExpireTime || null,
        playFlag: data?.playFlag,
        br: data?.br,
        level: data?.level,
      });
      return;
    }

    const lyricMatch = url.pathname.match(/^\/api\/lyric\/([^/]+)$/);
    if (req.method === "GET" && lyricMatch) {
      const songId = decodeURIComponent(lyricMatch[1]);
      const data = await withFresh(rec, (r) => ncm.get(EP.songLyric, r, { songId }));
      send(200, {
        lyric: data?.lyric || "",
        transLyric: data?.transLyric || "",
        txtLyric: data?.txtLyric || "",
        noLyric: data?.noLyric,
        pureMusic: data?.pureMusic,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/like") {
      const body = await readBody(req);
      if (!body.songId) {
        send(400, { error: "缺少 songId" });
        return;
      }
      await withFresh(rec, (r) =>
        ncm.post(EP.songLike, r, { songId: body.songId, isLike: Boolean(body.like) }),
      );
      send(200, { ok: true });
      return;
    }

    send(404, { error: "not found" });
  } catch (err) {
    const status = err instanceof NcmError && err.code === 301 ? 401 : 500;
    send(status, errorToJson(err));
  }
}

async function main() {
  if (!clientIp) {
    try {
      clientIp = await detectPublicIp();
      console.log("探测到出口 IP:", clientIp);
    } catch (err) {
      console.warn("未探测到公网 IP，请求开放平台时可能返回空 400。", err.message);
    }
  } else {
    console.log("使用 NCM_CLIENT_IP:", clientIp);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      json(res, 500, { error: err.message || String(err) }, corsHeaders(req));
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ncm-min-backend  http://localhost:${PORT}`);
    console.log("打开这个地址扫码测试。GitHub Pages 前端把 NCM 的 base 指到这里。");
    if (!APP_ID || !readPrivateKey() || !SESSION_SECRET) {
      console.warn("还没配 .env：复制 .env.example 为 .env，填 App ID / 私钥 / SESSION_SECRET");
    }
  });
}

main();
