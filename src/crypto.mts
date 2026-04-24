import { pbkdf2Sync, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const VERSION_BYTE = 0x01;
const SALT = Buffer.from("meander-walkthrough-v1", "utf-8");
const ITERATIONS = 600_000;
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for AES-GCM
const TAG_LENGTH = 16; // 128 bits

/**
 * Derive a 256-bit AES key from a password using PBKDF2-SHA256.
 * Fixed salt — the salt's purpose is to prevent rainbow tables, and
 * a fixed salt per deployment is sufficient for this threat model.
 */
export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_LENGTH, "sha256");
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns base64: [1 byte version][12 bytes IV][ciphertext + 16 byte auth tag]
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // [version][iv][ciphertext][tag]
  const combined = Buffer.concat([
    Buffer.from([VERSION_BYTE]),
    iv,
    ciphertext,
    tag,
  ]);

  return combined.toString("base64");
}

/**
 * Decrypt base64 ciphertext using AES-256-GCM.
 * Throws if authentication fails (wrong key or tampered data).
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const combined = Buffer.from(ciphertext, "base64");

  if (combined.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error("Ciphertext too short");
  }

  const version = combined[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  const iv = combined.slice(1, 1 + IV_LENGTH);
  const tag = combined.slice(combined.length - TAG_LENGTH);
  const encrypted = combined.slice(1 + IV_LENGTH, combined.length - TAG_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return plaintext.toString("utf-8");
}
