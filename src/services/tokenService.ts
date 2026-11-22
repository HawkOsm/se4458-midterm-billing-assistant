// JWT signing and verification (the teacher's Generate() plus the validation he left
// commented out in Program.cs: issuer, audience, lifetime and signature all checked).
// Tokens are for subscribers only; the provider's systems use API keys instead.
import jwt from "jsonwebtoken";
import { apiConfig } from "../config";

const ALGORITHM = "HS256";

export interface SubscriberClaims {
  subscriberNo: string;
}

export interface IssuedToken {
  accessToken: string;
  expiresIn: number; // seconds
}

export function issueToken(claims: SubscriberClaims): IssuedToken {
  const accessToken = jwt.sign({}, apiConfig().JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: claims.subscriberNo, // `sub`: who the token belongs to
    issuer: apiConfig().JWT_ISSUER,
    audience: apiConfig().JWT_AUDIENCE,
    expiresIn: apiConfig().JWT_TTL_SECONDS,
  });
  return { accessToken, expiresIn: apiConfig().JWT_TTL_SECONDS };
}

// Throws on a bad signature, wrong issuer/audience, expiry, or any algorithm but HS256
// (pinning the algorithm blocks the classic "alg: none" forgery).
export function verifyToken(token: string): SubscriberClaims {
  const payload = jwt.verify(token, apiConfig().JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: apiConfig().JWT_ISSUER,
    audience: apiConfig().JWT_AUDIENCE,
    clockTolerance: 0, // like the teacher's ClockSkew = TimeSpan.Zero
  });
  if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub === "") {
    throw new jwt.JsonWebTokenError("token has no subject");
  }
  return { subscriberNo: payload.sub };
}
