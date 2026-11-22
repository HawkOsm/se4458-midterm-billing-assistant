// JWT signing and verification (the teacher's Generate() plus the validation he left
// commented out in Program.cs: issuer, audience, lifetime and signature all checked).
import jwt from "jsonwebtoken";
import { config } from "../config";
import { ROLES, type AuthIdentity, type Role } from "../domain/user";

export type { AuthIdentity } from "../domain/user";

const ALGORITHM = "HS256";

export interface IssuedToken {
  accessToken: string;
  expiresIn: number; // seconds
}

// `sub` is who the token belongs to: the subscriber number, or the admin's username.
// `role` says which of the two it is.
export function issueToken(identity: AuthIdentity): IssuedToken {
  const subject = identity.role === "ADMIN" ? identity.username : identity.subscriberNo;
  const accessToken = jwt.sign({ role: identity.role }, config.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn: config.JWT_TTL_SECONDS,
  });
  return { accessToken, expiresIn: config.JWT_TTL_SECONDS };
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// Throws on a bad signature, wrong issuer/audience, expiry, or any algorithm but HS256
// (pinning the algorithm blocks the classic "alg: none" forgery), and on a token
// without a subject or a known role.
export function verifyToken(token: string): AuthIdentity {
  const payload = jwt.verify(token, config.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    clockTolerance: 0, // like the teacher's ClockSkew = TimeSpan.Zero
  });
  if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub === "") {
    throw new jwt.JsonWebTokenError("token has no subject");
  }
  const role: unknown = payload["role"];
  if (!isRole(role)) throw new jwt.JsonWebTokenError("token has no valid role");
  return role === "ADMIN" ? { role, username: payload.sub } : { role, subscriberNo: payload.sub };
}
