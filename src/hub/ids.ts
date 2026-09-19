import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

/** Short, prefixed, unambiguous ids: `a_7xk2mq9p`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomString(10)}`;
}

/** Bearer secrets. Only their sha256 is ever stored. */
export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

/** Invite codes are typed by humans, so they avoid look-alike characters. */
export function shortCode(): string {
  return `${randomString(4)}-${randomString(4)}-${randomString(4)}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
