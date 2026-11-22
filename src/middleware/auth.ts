// Authentication and authorization middleware (what [Authorize] does in the teacher's
// .NET API, which he left commented out).
//   requireAuth              -> 401 unless a valid Bearer token is present (who are you?)
//   requireOwnAccount        -> 403 unless it is the URL's own subscriber (Pay Bill)
//   requireOwnAccountOrAdmin -> 403 unless own subscriber, or the provider's admin
//   requireAdmin             -> 403 unless the provider's admin (Add Usage)
// The spec's rule: knowing a subscriber number is never enough to read or change that
// subscriber's data; only their own token (or the provider's admin) is.
import type { NextFunction, Request, Response } from "express";
import type { AuthIdentity } from "../domain/user";
import { DtoError } from "../dto/dtoError";
import { verifyToken } from "../services/tokenService";

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

function isOwnSubscriber(req: Request, auth: AuthIdentity): boolean {
  return auth.role === "SUBSCRIBER" && req.params["subscriberNo"] === auth.subscriberNo;
}

// Only the subscriber themself: a payment is the customer's own action.
export function requireOwnAccount(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(res);
  if (auth.role === "ADMIN") throw new DtoError("Only the subscriber can do this, not an admin", 403);
  if (!isOwnSubscriber(req, auth)) throw new DtoError("You can only access your own account", 403);
  next();
}

// The subscriber themself, or the provider's admin acting for any subscriber.
export function requireOwnAccountOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(res);
  if (auth.role !== "ADMIN" && !isOwnSubscriber(req, auth)) {
    throw new DtoError("You can only access your own account", 403);
  }
  next();
}

// Only the provider's admin (operator / billing system).
export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if (getAuth(res).role !== "ADMIN") throw new DtoError("Only the provider's admin can do this", 403);
  next();
}

export function getAuth(res: Response): AuthIdentity {
  const auth = res.locals["auth"] as AuthIdentity | undefined;
  if (!auth) throw new Error("getAuth() used on a route without requireAuth");
  return auth;
}
