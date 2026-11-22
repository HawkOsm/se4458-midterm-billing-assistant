// Builds the Express app (the part of the teacher's index.js that wires everything).
// Kept separate from index.ts so tests can create an app with their own database client.
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import express, { type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { ApiVersion, BEARER_AUTH } from "./controllers/apiVersion";
import { authController } from "./controllers/authController";
import { billController } from "./controllers/billController";
import type { Db } from "./db/db";
import { buildOpenApiDocument } from "./docs/openapi";
import { DtoError } from "./dto/dtoError";

export function createApp(db: Db): express.Express {
  const app = express();
  app.disable("x-powered-by"); // don't tell every client which framework runs here
  app.use(express.json());

  // One registry per app: every route registered below ends up in this Swagger document.
  const registry = new OpenAPIRegistry();
  // Lets Swagger's "Authorize" button send `Authorization: Bearer <token>`.
  registry.registerComponent("securitySchemes", BEARER_AUTH, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });

  // The ONLY place the version is written. A breaking change would add a second
  // ApiVersion("/api/v2", registry) with its own controllers, next to this one.
  const v1 = new ApiVersion("/api/v1", registry);
  authController(v1, db);
  billController(v1, db);
  app.use(v1.prefix, v1.router);

  // Swagger: the page is at /api-docs and the raw spec at /openapi.json.
  const openapi = buildOpenApiDocument(registry);
  app.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapi));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use(errorHandler);
  return app;
}

// Express 5 forwards errors thrown in handlers (sync or async) here automatically.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DtoError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  // express.json() rejects a body that isn't valid JSON: the client's mistake, not ours.
  if ((err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: "Request body is not valid JSON" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" }); // never leak internals
}
