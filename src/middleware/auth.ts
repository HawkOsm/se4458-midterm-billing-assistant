// Authentication and authorization middleware (what [Authorize] does in the teacher's
// .NET API, which he left commented out). Two separate checks:
//   requireAuth      -> 401 unless a valid Bearer token is present (who are you?)
//   requireOwnAccount -> 403 unless the URL's subscriber is the token's (may you do this?)
// The second is the spec's rule: knowing a subscriber number is never enough to read
// that subscriber's private data; only their own token is.
import type { NextFunction, Request, Response } from "express";
import { DtoError } from "../dto/dtoError";
import { verifyToken, type AuthIdentity } from "../services/tokenService";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const [scheme, token] = (req.headers.authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="billing-api"');
    throw new DtoError("Missing or malformed Authorization header (expected: Bearer <token>)", 401);
  }
  try {
    res.locals["auth"] = verifyToken(token);
  } catch {
    // One message for expired, forged and wrong-audience tokens: don't help an attacker.
    res.setHeader("WWW-Authenticate", 'Bearer realm="billing-api", error="invalid_token"');
    throw new DtoError("Invalid or expired token", 401);
  }
  next();
}

export function requireOwnAccount(req: Request, res: Response, next: NextFunction): void {
  if (req.params["subscriberNo"] !== getAuth(res).subscriberNo) {
    throw new DtoError("You can only access your own account", 403);
  }
  next();
}

export function getAuth(res: Response): AuthIdentity {
  const auth = res.locals["auth"] as AuthIdentity | undefined;
  if (!auth) throw new Error("getAuth() used on a route without requireAuth");
  return auth;
}
