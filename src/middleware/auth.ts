// Authentication and authorization middleware (what [Authorize] does in the teacher's
// .NET API, which he left commented out).
//
// Who is calling (authenticate):
//   Authorization: Bearer <JWT>  -> a subscriber (logged in with POST /login)
//   X-API-Key: <key>             -> one of the provider's systems (migration 007)
//   neither -> 401; both -> 400 (ambiguous: which one should count?)
// What they may do:
//   requireOwnAccount           -> only the subscriber in the URL (Pay Bill)
//   requireOwnAccountOrProvider -> that subscriber, or the provider (Calculate, Detailed)
//   requireProvider             -> only the provider (Add Usage)
// The spec's rule: knowing a subscriber number is never enough to read or change that
// subscriber's data; only their own token (or the provider's key) is.
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { AuthIdentity } from "../domain/user";
import { DtoError } from "../dto/dtoError";
import { hashApiKey } from "../services/apiKeyService";
import { verifyToken } from "../services/tokenService";

// Finds the name of an active key by its hash (the database in the app, a fake in tests).
export type ApiKeyLookup = (keyHash: string) => Promise<string | null>;

const CHALLENGE = 'Bearer realm="billing-api"';

export function authenticate(findKey: ApiKeyLookup): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const apiKey = req.headers["x-api-key"];
    const authorization = req.headers.authorization;
    if (apiKey !== undefined && authorization !== undefined) {
      throw new DtoError("Send either an X-API-Key or a Bearer token, not both", 400);
    }
    res.locals["auth"] =
      apiKey !== undefined ? await providerFromKey(apiKey, findKey) : subscriberFromBearer(authorization, res);
    next();
  };
}

async function providerFromKey(apiKey: string | string[], findKey: ApiKeyLookup): Promise<AuthIdentity> {
  const name = typeof apiKey === "string" && apiKey !== "" ? await findKey(hashApiKey(apiKey)) : null;
  if (!name) throw new DtoError("Invalid or revoked API key", 401);
  return { kind: "provider", keyName: name };
}

function subscriberFromBearer(authorization: string | undefined, res: Response): AuthIdentity {
  const [scheme, token] = (authorization ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    res.setHeader("WWW-Authenticate", CHALLENGE);
    throw new DtoError("Missing or malformed Authorization header (expected: Bearer <token>)", 401);
  }
  try {
    return { kind: "subscriber", subscriberNo: verifyToken(token).subscriberNo };
  } catch {
    // One message for expired, forged and wrong-audience tokens: don't help an attacker.
    res.setHeader("WWW-Authenticate", `${CHALLENGE}, error="invalid_token"`);
    throw new DtoError("Invalid or expired token", 401);
  }
}

function isOwnSubscriber(req: Request, auth: AuthIdentity): boolean {
  return auth.kind === "subscriber" && req.params["subscriberNo"] === auth.subscriberNo;
}

// Only the subscriber themself: a payment is the customer's own action.
export function requireOwnAccount(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(res);
  if (auth.kind === "provider") throw new DtoError("Only the subscriber can do this", 403);
  if (!isOwnSubscriber(req, auth)) throw new DtoError("You can only access your own account", 403);
  next();
}

// The subscriber themself, or the provider's systems acting for any subscriber.
export function requireOwnAccountOrProvider(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(res);
  if (auth.kind !== "provider" && !isOwnSubscriber(req, auth)) {
    throw new DtoError("You can only access your own account", 403);
  }
  next();
}

// Only the provider's systems (API key).
export function requireProvider(_req: Request, res: Response, next: NextFunction): void {
  if (getAuth(res).kind !== "provider") {
    throw new DtoError("Only the provider's systems can do this (X-API-Key)", 403);
  }
  next();
}

export function getAuth(res: Response): AuthIdentity {
  const auth = res.locals["auth"] as AuthIdentity | undefined;
  if (!auth) throw new Error("getAuth() used on a route without authenticate()");
  return auth;
}
