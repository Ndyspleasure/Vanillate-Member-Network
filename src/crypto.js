import {
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
export const secret = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function vault(key, previousKeys = []) {
  const bytes = Buffer.from(key, "hex");
  const keyId = hash(key.toLowerCase()).slice(0, 12);
  const keys = new Map(
    [key, ...previousKeys].map((k) => [
      hash(k.toLowerCase()).slice(0, 12),
      Buffer.from(k, "hex"),
    ]),
  );
  return {
    encrypt(value, context) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", bytes, iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([
        cipher.update(JSON.stringify(value)),
        cipher.final(),
      ]);
      return (
        `v2:${keyId}:` +
        [iv, cipher.getAuthTag(), data]
          .map((b) => b.toString("base64url"))
          .join(".")
      );
    },
    decrypt(value, context) {
      const parts = value.split(":");
      const payload = parts.length === 3 ? parts[2] : value;
      const candidates =
        parts.length === 3
          ? [keys.get(parts[1])].filter(Boolean)
          : [...keys.values()];
      if (parts.length === 3 && parts[0] !== "v2")
        throw new Error("Unknown ciphertext format");
      for (const candidate of candidates)
        try {
          const [iv, tag, data] = payload
            .split(".")
            .map((s) => Buffer.from(s, "base64url"));
          const cipher = createDecipheriv("aes-256-gcm", candidate, iv);
          cipher.setAAD(Buffer.from(context));
          cipher.setAuthTag(tag);
          return JSON.parse(
            Buffer.concat([cipher.update(data), cipher.final()]).toString(),
          );
        } catch {
          /* Try a configured previous key for legacy ciphertext only. */
        }
      throw new Error("Credential decryption failed");
    },
  };
}
