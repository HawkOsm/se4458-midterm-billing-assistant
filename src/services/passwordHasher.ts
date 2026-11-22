// Password hashing with Node's built-in scrypt (no native package to build).
// Stored format: scrypt$N$r$p$<salt>$<hash> (base64url). The parameters are stored with the
// hash, so they can be raised later without breaking existing users.
// N=2^14, r=8, p=5 is one of the scrypt settings the OWASP Password Storage Cheat Sheet
// lists as equivalent; it needs 16 MiB per hash (128 * N * r bytes).
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PARAMS = { N: 2 ** 14, r: 8, p: 5 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH); // unique per user: equal passwords get different hashes
  const hash = await scryptAsync(password, salt, PARAMS);
  const { N, r, p } = PARAMS;
  return ["scrypt", N, r, p, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time compare: `===` stops at the first differing byte, which leaks timing.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verified against when the username doesn't exist, so "unknown user" costs the same
// time as "wrong password" and response timing can't reveal which usernames exist.
export const DUMMY_HASH = "scrypt$16384$8$5$AAAAAAAAAAAAAAAAAAAAAA$" + "A".repeat(86);
