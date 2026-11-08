import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.writeFileSync(path.join(dir, "app_private_key_pkcs8.pem"), privateKey);
fs.writeFileSync(path.join(dir, "app_public_key.pem"), publicKey);

const oneLine = publicKey
  .replace(/-----BEGIN PUBLIC KEY-----/g, "")
  .replace(/-----END PUBLIC KEY-----/g, "")
  .replace(/\s+/g, "");

console.log("已生成：");
console.log("  app_private_key_pkcs8.pem  ← 只放服务器，不要上传");
console.log("  app_public_key.pem");
console.log("");
console.log("把下面这一整行贴进网易云开放平台「公钥」：");
console.log(oneLine);
