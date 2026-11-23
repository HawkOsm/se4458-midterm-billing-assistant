import { OpenApiGeneratorV3, type OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export const API_TITLE = "Mobile Provider Billing API";

// Call after every controller has registered its routes on this registry.
export function buildOpenApiDocument(
  registry: OpenAPIRegistry,
): ReturnType<OpenApiGeneratorV3["generateDocument"]> {
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: API_TITLE,
      version: "1.0.0",
      description: "Billing operations for the SE4458 AI Billing Support Assistant.",
    },
    // Relative, so "Try it out" calls the same host locally and when deployed.
    servers: [{ url: "/" }],
  });
}
