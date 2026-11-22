// Login request/response shapes (the teacher's Models/UserLoginDto.cs).
import { z } from "./zod";

export const LoginRequest = z
  .object({
    username: z.string().trim().min(1).max(50).openapi({ example: "ayse" }),
    password: z.string().min(1).max(200).openapi({ example: "<see README test data>" }),
  })
  .openapi("LoginRequest");
export type LoginRequest = z.infer<typeof LoginRequest>;

// Standard OAuth-style token response, so clients know the type and lifetime.
export const TokenDto = z
  .object({
    accessToken: z.string().openapi({ example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }),
    tokenType: z.literal("Bearer"),
    expiresIn: z.number().int().openapi({ description: "Seconds until the token expires", example: 900 }),
  })
  .openapi("Token");
export type TokenDto = z.infer<typeof TokenDto>;
