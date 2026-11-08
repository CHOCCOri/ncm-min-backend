import crypto from "node:crypto";
import os from "node:os";

export const BASE_URL = "https://openncm.music.163.com";
export const SIGN_TYPE = "RSA_SHA256";

export const EP = {
  anonymous: "/openapi/music/basic/oauth2/login/anonymous",
  qrKey: "/openapi/music/basic/user/oauth2/qrcodekey/get/v2",
  qrPoll: "/openapi/music/basic/oauth2/device/login/qrcode/get",
  profile: "/openapi/music/basic/user/profile/get/v2",
  playlistCreated: "/openapi/music/basic/playlist/created/get/v2",
  playlistSubed: "/openapi/music/basic/playlist/subed/get/v2",
  playlistTracks: "/openapi/music/basic/playlist/song/list/get/v3",
  songDetail: "/openapi/music/basic/song/detail/get/v2",
  songLyric: "/openapi/music/basic/song/lyric/get/v2",
  songLike: "/openapi/music/basic/playlist/song/like/v2",
  searchSong: "/openapi/music/basic/search/song/get/v3",
  recommend: "/openapi/music/basic/recommend/songlist/get/v2",
};

const IP_PROBES = [
  "https://ip.3322.net",
  "https://myip.ipip.net",
  "https://api.ipify.org?format=json",
];

export class NcmError extends Error {
  constructor(code, message, extra = {}) {
    super(message || `ncm error ${code}`);
    this.name = "NcmError";
    this.code = code;
    this.extra = extra;
  }
}

export function compactJson(obj) {
  return JSON.stringify(obj);
}

export function normalizePem(raw) {
  if (!raw) throw new Error("缺少 NCM_PRIVATE_KEY");
  let text = String(raw).trim().replace(/\\n/g, "\n");
  if (text.startsWith("-----")) return text;
  const b64 = text.replace(/\s+/g, "");
  const lines = b64.match(/.{1,64}/g)?.join("\n") || b64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

export function canonical(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

export function signParams(params, pem) {
  const body = canonical(params);
  const sig = crypto.sign("sha256", Buffer.from(body, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return { ...params, sign: sig.toString("base64") };
}

export function buildDevice({ deviceId, clientIp, osVer = os.release() || "5.15.0" }) {
  if (!deviceId || !clientIp) throw new Error("deviceId / clientIp 必填");
  return {
    deviceType: "openapi",
    os: "ncmcli",
    appVer: "0.1.7",
    channel: "ncmcli",
    model: "Linux_x64_cli",
    brand: "ncmcli",
    osVer: String(osVer),
    clientIp,
    deviceId,
  };
}

export function newDeviceId() {
  return `web-${crypto.randomBytes(12).toString("hex")}`;
}

function extractIp(text) {
  const jsonTry = (() => {
    try {
      return JSON.parse(text)?.ip || "";
    } catch {
      return "";
    }
  })();
  if (jsonTry) return jsonTry;
  const m = String(text).match(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/);
  return m ? m[0] : "";
}

export async function detectPublicIp() {
  let last = null;
  for (const url of IP_PROBES) {
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const text = (await res.text()).trim();
        const ip = extractIp(text);
        if (ip) return ip;
      } catch (err) {
        last = err;
      }
    }
  }
  throw last || new Error("探测公网 IP 失败，请在 .env 里填 NCM_CLIENT_IP");
}

export function pickToken(data) {
  if (!data) return null;
  const t = data.accessToken;
  if (typeof t === "string" && t) {
    return {
      accessToken: t,
      refreshToken: data.refreshToken || "",
      expireTime: Number(data.expireTime) || 86400,
    };
  }
  if (t && typeof t === "object") {
    const accessToken = t.accessToken || t.token || "";
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: t.refreshToken || data.refreshToken || "",
      expireTime: Number(t.expireTime || data.expireTime) || 86400,
    };
  }
  return null;
}

let lastCallAt = 0;
async function throttle(ms = 250) {
  const wait = lastCallAt + ms - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export function createClient({ appId, pem, clientIp }) {
  if (!appId) throw new Error("缺少 NCM_APP_ID");
  const key = normalizePem(pem);

  function compose(accessToken, biz, device) {
    const params = {
      accessToken: accessToken || "",
      appId,
      bizContent: typeof biz === "string" ? biz : compactJson(biz),
      device: typeof device === "string" ? device : compactJson(device),
      signType: SIGN_TYPE,
      timestamp: String(Date.now()),
    };
    return signParams(params, key);
  }

  async function send(method, endpoint, { accessToken, biz, device, idempotent = method === "GET" }) {
    await throttle();
    const params = compose(accessToken, biz, device);
    const url = new URL(endpoint, BASE_URL);
    const headers = {
      Accept: "application/json",
      Referer: "https://music.163.com/",
      "User-Agent": "ncm-min-backend/1.0",
    };
    let res;
    const attempts = idempotent ? 4 : 1;
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        if (method === "GET") {
          for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
          res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        } else {
          res = await fetch(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: compactJson(params),
            signal: AbortSignal.timeout(15000),
          });
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i));
      }
    }
    if (lastErr) throw lastErr;

    const text = await res.text();
    if (res.status === 400 && !text.trim()) {
      throw new NcmError(400, "网关限流或 clientIp 不匹配（空 400）", { http: 400 });
    }
    if (!res.ok) throw new NcmError(res.status, text.slice(0, 200), { http: res.status });

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new NcmError("parse", "响应不是 JSON", { body: text.slice(0, 200) });
    }
    if (payload.code !== 200) {
      throw new NcmError(payload.code, payload.message || "业务失败", {
        subCode: payload.subCode,
      });
    }
    return payload.data;
  }

  function deviceOf(deviceId, ip = clientIp) {
    return buildDevice({ deviceId, clientIp: ip });
  }

  return {
    appId,
    send,
    deviceOf,
    async anonymous(deviceId) {
      const data = await send("POST", EP.anonymous, {
        accessToken: "",
        biz: { clientId: appId },
        device: deviceOf(deviceId),
        idempotent: true,
      });
      return pickToken(data);
    },
    async refresh(deviceId, refreshToken) {
      const data = await send("POST", EP.anonymous, {
        accessToken: "",
        biz: { clientId: appId, refreshToken },
        device: deviceOf(deviceId),
      });
      return pickToken(data);
    },
    async qrKey(deviceId, accessToken) {
      return send("GET", EP.qrKey, {
        accessToken,
        biz: { type: 2, expiredKey: "300" },
        device: deviceOf(deviceId),
      });
    },
    async qrPoll(deviceId, accessToken, uniKey) {
      return send("GET", EP.qrPoll, {
        accessToken,
        biz: { key: uniKey, clientId: appId },
        device: deviceOf(deviceId),
      });
    },
    get(endpoint, session, biz) {
      return send("GET", endpoint, {
        accessToken: session.accessToken,
        biz,
        device: deviceOf(session.deviceId),
      });
    },
    post(endpoint, session, biz) {
      return send("POST", endpoint, {
        accessToken: session.accessToken,
        biz,
        device: deviceOf(session.deviceId),
      });
    },
  };
}

export function mapPlaylist(r, kind) {
  if (!r || typeof r !== "object") return null;
  return {
    id: r.id || r.playlistId,
    name: r.name,
    trackCount: r.trackCount || r.songCount || 0,
    cover: r.coverImgUrl || r.cover || r.picUrl,
    specialType: r.specialType,
    creator: r.creatorNickName || r.creator?.nickname,
    kind,
  };
}

export function mapSong(r) {
  if (!r || typeof r !== "object") return null;
  const artists = r.artists || r.ar || r.artistName || r.singerName;
  return {
    id: r.songId || r.id,
    name: r.name || r.songName,
    artists: Array.isArray(artists)
      ? artists.map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean).join(" / ")
      : artists || "",
    album: r.album?.name || r.albumName || r.al?.name || r.album || "",
    cover: r.coverUrl || r.albumPic || r.al?.picUrl || r.cover || r.picUrl,
    liked: r.liked,
    playFlag: r.playFlag,
    duration: r.duration || r.dt,
  };
}
