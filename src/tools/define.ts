/**
 * Tool definition shim. We keep our internal `Tool` shape minimal so
 * tools can be tested without importing the full MCP SDK, then adapt
 * to the SDK at registration time. This isolates the SDK version from
 * the rest of the package.
 */

import type { ZodTypeAny, z } from "zod";

export interface ToolHandlerResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Type-erased tool entry. Each tool's input schema is its own ZodObject,
 * but the heterogenous registry must hold them in one list — generics
 * don't unify across an Array<Tool<S>> shape. Handlers cast their input
 * back to the schema's inferred type internally; runtime-safe because
 * the server runs `safeParse(req.params.arguments)` against `inputSchema`
 * before invoking `handler`.
 */
export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodTypeAny;
  handler: (input: unknown) => Promise<ToolHandlerResult>;
}

/**
 * Helper that preserves the input type internally for the handler while
 * widening to `Tool` for storage in the registry.
 */
export function defineTool<S extends ZodTypeAny>(tool: {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>) => Promise<ToolHandlerResult>;
}): Tool {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    handler: (input) => tool.handler(input as z.infer<S>),
  };
}
