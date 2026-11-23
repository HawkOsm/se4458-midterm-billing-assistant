// On AWS the API has two public addresses: the API Gateway URL (the one clients use) and
// the ECS service's own URL behind it. The gateway adds a secret header to every request
// it forwards; this middleware refuses requests without it, so nobody can skip the
// gateway (and its throttling) by calling the service URL directly.
// Without a secret (local runs, tests) every request is let through.
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const GATEWAY_HEADER = "x-gateway-secret";

// Hashing first gives two equal-length buffers, so timingSafeEqual can compare them in
// constant time (an early-exit compare would leak how many leading characters match).
const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export function gatewayOnly(secret: string | undefined): RequestHandler {
  if (!secret) return (_req, _res, next) => next();
  const expected = digest(secret);
  return (req: Request, res: Response, next: NextFunction): void => {
    const sent = req.headers[GATEWAY_HEADER];
    if (typeof sent === "string" && timingSafeEqual(digest(sent), expected)) return next();
    res.status(403).json({ error: "Use the API Gateway URL" });
  };
}
