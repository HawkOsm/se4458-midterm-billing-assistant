// Collects every route's OpenAPI description. Controllers register their routes here,
// next to the route code, so Swagger is generated from the same schemas that validate.
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

export const registry = new OpenAPIRegistry();
