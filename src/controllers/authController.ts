// Login endpoint (the teacher's Controllers/LoginController.cs).
import type { Db } from "../db/db";
import { LoginRequest, TokenDto } from "../dto/authDto";
import { DtoError, ErrorDto, parseOrThrow } from "../dto/dtoError";
import { AuthService } from "../services/authService";
import type { ApiVersion } from "./apiVersion";

export function authController(api: ApiVersion, db: Db): void {
  const service = new AuthService(db);

  api.route(
    "post",
    "/login",
    {
      tags: ["Auth"],
      summary: "Log in",
      description: "Exchange username and password for a JWT (valid 15 minutes).",
      request: { body: { content: { "application/json": { schema: LoginRequest } } } },
      responses: {
        200: { description: "Logged in", content: { "application/json": { schema: TokenDto } } },
        400: { description: "Missing or invalid fields", content: { "application/json": { schema: ErrorDto } } },
        401: { description: "Wrong username or password", content: { "application/json": { schema: ErrorDto } } },
      },
    },
    async (req, res) => {
      const { username, password } = parseOrThrow(LoginRequest, req.body);
      const token = await service.login(username, password);
      // 401, not the teacher's 404 "User not found": never confirm a username exists.
      if (!token) throw new DtoError("Invalid username or password", 401);
      // Tokens are credentials: no proxy or browser may cache this response.
      res.setHeader("Cache-Control", "no-store");
      const body: TokenDto = { ...token, tokenType: "Bearer" };
      res.json(body);
    },
  );
}
