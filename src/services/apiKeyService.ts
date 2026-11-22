// Provider API keys: long random values given to the provider's systems (the usage
// collector, the billing run). The database stores only their SHA-256 hash.
import { createHash, randomBytes } from "node:crypto";

// A new key: 32 random bytes, so there is nothing to guess and no dictionary to try.
export function generateApiKey(): string {
  return `pk_${randomBytes(32).toString("base64url")}`;
}

// SHA-256 is enough for keys (unlike passwords): a slow hash only helps against weak,
// guessable secrets, and a random 256-bit key isn't one.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
