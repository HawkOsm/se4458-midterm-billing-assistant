// The one place zod is extended with .openapi(), so every DTO can describe itself in Swagger.
// Import `z` from here, not from "zod", in DTO files.
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export { z };
