import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function vault(key) {
  const bytes = Buffer.from(key, "hex");
  return {
    encrypt(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", bytes, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
      ]);
      return [iv, cipher.getAuthTag(), data]
        .map((b) => b.toString("base64url"))
        .join(".");
    },
    decrypt(value, context) {
      const [iv, tag, data] = value
        .split(".")
        .map((s) => Buffer.from(s, "base64url"));
      const cipher = createDecipheriv("aes-256-gcm", bytes, iv);
      cipher.setAAD(Buffer.from(context));
      cipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([cipher.update(data), cipher.final()]).toString(),
      );
    },
  };
}
