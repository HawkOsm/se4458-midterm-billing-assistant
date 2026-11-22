// JWT signing and verification (the teacher's Generate() plus the validation he left
// commented out in Program.cs: issuer, audience, lifetime and signature all checked).
// Tokens are for subscribers only; the provider's systems use API keys instead.
import jwt from "jsonwebtoken";
import { config } from "../config";

const ALGORITHM = "HS256";

export interface SubscriberClaims {
  subscriberNo: string;
}

export interface IssuedToken {
  accessToken: string;
  expiresIn: number; // seconds
}

export function issueToken(claims: SubscriberClaims): IssuedToken {
  const accessToken = jwt.sign({}, config.JWT_SECRET, {
    algorithm: ALGORITHM,
    subject: claims.subscriberNo, // `sub`: who the token belongs to
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    expiresIn: config.JWT_TTL_SECONDS,
  });
  return { accessToken, expiresIn: config.JWT_TTL_SECONDS };
}

// Throws on a bad signature, wrong issuer/audience, expiry, or any algorithm but HS256
// (pinning the algorithm blocks the classic "alg: none" forgery).
export function verifyToken(token: string): SubscriberClaims {
  const payload = jwt.verify(token, config.JWT_SECRET, {
    algorithms: [ALGORITHM],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    clockTolerance: 0, // like the teacher's ClockSkew = TimeSpan.Zero
  });
  if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub === "") {
    throw new jwt.JsonWebTokenError("token has no subject");
  }
  return { subscriberNo: payload.sub };
}
