import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";

// Call after the controllers are imported, so all routes are registered.
export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3["generateDocument"]> {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Mobile Provider Billing API",
      version: "1.0.0",
      description: "Billing operations for the SE4458 AI Billing Support Assistant.",
    },
    // Relative, so "Try it out" calls the same host locally and when deployed.
    servers: [{ url: "/" }],
  });
}
