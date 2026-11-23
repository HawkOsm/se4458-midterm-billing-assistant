// Login endpoint (the teacher's Controllers/LoginController.cs).
import type { Db } from "../db/db";
import { LoginRequest, TokenDto } from "../dto/authDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { AuthService } from "../services/authService";
import { LOGIN_LOCK_SECONDS, LoginLimiter, MAX_FAILED_LOGINS } from "../services/loginLimiter";
import { json, type ApiVersion } from "./apiVersion";

export function authController(api: ApiVersion, db: Db, limiter = new LoginLimiter()): void {
  const service = new AuthService(db);

  api.route(
    "post",
    "/login",
    {
      tags: ["Auth"],
      summary: "Log in",
      description:
        "Exchange username and password for a JWT (valid 15 minutes). After " +
        `${MAX_FAILED_LOGINS} wrong passwords in a row, the username is locked for ${LOGIN_LOCK_SECONDS} seconds.`,
      request: { body: { content: json(LoginRequest) } },
      responses: {
        200: { description: "Logged in", content: json(TokenDto) },
        400: { description: "Missing or invalid fields", content: json(ErrorDto) },
        401: { description: "Wrong username or password", content: json(ErrorDto) },
        429: { description: "Too many wrong passwords; see the Retry-After header (seconds)", content: json(ErrorDto) },
      },
    },
    async (req, res) => {
      const { username, password } = parseOrThrow(LoginRequest, req.body);
      // While locked, even the right password is refused (and never checked).
      const wait = limiter.retryAfterSeconds(username);
      if (wait > 0) {
        res.setHeader("Retry-After", String(wait));
        throw new DtoError(`Too many failed logins. Try again in ${wait} seconds`, 429);
      }
      const token = await service.login(username, password);
      // 401, not the teacher's 404 "User not found": never confirm a username exists.
      if (!token) {
        limiter.recordFailure(username);
        throw new DtoError("Invalid username or password", 401);
      }
      limiter.recordSuccess(username);
      // Tokens are credentials: no proxy or browser may cache this response.
      res.setHeader("Cache-Control", "no-store");
      const body: TokenDto = { ...token, tokenType: "Bearer" };
      res.json(body);
    },
  );
}
