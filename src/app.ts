// Builds the Express app (the part of the teacher's index.js that wires everything).
// Kept separate from index.ts so tests can create an app with their own database client.
import express, { type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import { billController } from "./controllers/billController";
import type { Db } from "./db/db";
import { buildOpenApiDocument } from "./docs/openapi";
import { DtoError } from "./dto/dtoError";

export function createApp(db: Db): express.Express {
  const app = express();
  app.disable("x-powered-by"); // don't tell every client which framework runs here
  app.use(express.json());

  // The URL version lives here: a breaking change would mount new controllers at /api/v2.
  app.use("/api/v1", billController(db));

  // Swagger: the page is at /api-docs and the raw spec at /openapi.json.
  const openapi = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openapi);
  });
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapi));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Express 5 forwards errors thrown in async handlers here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DtoError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" }); // never leak internals
  });

  return app;
}
