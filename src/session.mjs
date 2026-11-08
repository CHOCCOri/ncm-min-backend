import crypto from "node:crypto";

export function signToken(payload, secret, ttlSec = 7 * 24 * 3600) {
  const body = {
    ...payload,
    exp: Date.now() + ttlSec * 1000,
  };
  const data = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expect = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearer(req) {
  const h = req.headers.authorization || req.headers.Authorization || "";
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const url = new URL(req.url, "http://local");
  return url.searchParams.get("token") || "";
}
