// One API version: its URL prefix, its Express router, and its Swagger registry.
// Controllers declare each route ONCE (OpenAPI path syntax); this mounts it in Express
// and registers the same path, with the prefix, in Swagger. The prefix is written in one
// place (app.ts), so routes and docs can't drift apart when a /api/v2 is added.
import type { OpenAPIRegistry, RouteConfig } from "@asteasolutions/zod-to-openapi";
import { Router, type RequestHandler } from "express";
import type { ZodType } from "zod";

type Method = "get" | "post" | "put" | "patch" | "delete";
export type RouteDocs = Omit<RouteConfig, "method" | "path">;

export const BEARER_AUTH = "bearerAuth";
export const API_KEY_AUTH = "apiKey";

export class ApiVersion {
  readonly router = Router();
  // What route() registered, for the index page (serveIndex).
  private readonly routes: { method: string; path: string; summary: string }[] = [];

  constructor(
    readonly prefix: string, // e.g. "/api/v1"
    readonly registry: OpenAPIRegistry,
  ) {}

  // path uses OpenAPI syntax: /subscribers/{subscriberNo}/bills/{year}/{month}
  route(method: Method, path: string, docs: RouteDocs, ...handlers: RequestHandler[]): void {
    this.registry.registerPath({ ...docs, method, path: this.prefix + path });
    this.router[method](toExpressPath(path), ...handlers);
    this.routes.push({ method: method.toUpperCase(), path: this.prefix + path, summary: docs.summary ?? "" });
  }

  // GET <prefix> itself (e.g. /api/v1): which version this is, where its Swagger page is,
  // and its routes. Without it, opening the base URL in a browser shows only "Not found".
  // Built from the routes registered above, so it can't list a route that doesn't exist.
  // Call after the controllers. Not in Swagger: it describes the API, it isn't one of its operations.
  serveIndex(name: string): void {
    this.router.get("/", (_req, res) => {
      res.json({
        name,
        version: this.prefix.split("/").pop(),
        docs: "/api-docs/",
        openapi: "/openapi.json",
        routes: this.routes,
      });
    });
  }
}

// "/a/{id}/b" -> "/a/:id/b" (Express 5 path syntax)
export function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ":$1");
}

// A JSON body/response entry for route docs: json(BillDto) instead of the nested literal.
export function json(schema: ZodType): { "application/json": { schema: ZodType } } {
  return { "application/json": { schema } };
}
