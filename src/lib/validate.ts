import { z } from "zod";
import type { ArtifactType, Tool } from "./artifacts/types";

const stringOrStringArray = z.union([z.string(), z.array(z.string())]);

export const skillFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    "allowed-tools": stringOrStringArray.optional(),
    model: z.string().optional(),
    "argument-hint": z.string().optional(),
    paths: stringOrStringArray.optional(),
    "user-invocable": z.boolean().optional(),
    "disable-model-invocation": z.boolean().optional(),
  })
  .passthrough();

export const agentFrontmatterSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().optional(),
    tools: stringOrStringArray.optional(),
  })
  .passthrough();

export const commandFrontmatterSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    "allowed-tools": stringOrStringArray.optional(),
    "argument-hint": z.string().optional(),
  })
  .passthrough();

export const cursorRuleFrontmatterSchema = z
  .object({
    description: z.string().optional(),
    globs: stringOrStringArray.optional(),
    alwaysApply: z.boolean().optional(),
  })
  .passthrough();

export const clineRuleFrontmatterSchema = z
  .object({
    description: z.string().optional(),
    paths: stringOrStringArray.optional(),
  })
  .passthrough();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;
export type CommandFrontmatter = z.infer<typeof commandFrontmatterSchema>;
export type CursorRuleFrontmatter = z.infer<typeof cursorRuleFrontmatterSchema>;
export type ClineRuleFrontmatter = z.infer<typeof clineRuleFrontmatterSchema>;

export function schemaFor(tool: Tool, type: ArtifactType): z.ZodTypeAny {
  if (tool === "cursor") return cursorRuleFrontmatterSchema;
  if (tool === "cline") return clineRuleFrontmatterSchema;
  if (type === "skill") return skillFrontmatterSchema;
  if (type === "agent") return agentFrontmatterSchema;
  return commandFrontmatterSchema;
}

export interface ValidationResult {
  ok: boolean;
  errors: { path: string; message: string }[];
  data?: Record<string, unknown>;
}

export function validate(
  tool: Tool,
  type: ArtifactType,
  data: Record<string, unknown>,
): ValidationResult {
  const schema = schemaFor(tool, type);
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, errors: [], data: result.data as Record<string, unknown> };
  return {
    ok: false,
    errors: result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}

export interface FieldDescriptor {
  name: string;
  kind: "string" | "string[]" | "boolean" | "enum";
  required: boolean;
  description?: string;
  options?: string[];
}

export function describeFields(tool: Tool, type: ArtifactType): FieldDescriptor[] {
  const fields: FieldDescriptor[] = [];
  const schema = schemaFor(tool, type);
  const shape = (schema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape) return fields;
  for (const [name, raw] of Object.entries(shape)) {
    const def = raw;
    const isOptional = def.isOptional?.() ?? false;
    let inner = def;
    if ("unwrap" in def && typeof (def as { unwrap?: () => z.ZodTypeAny }).unwrap === "function") {
      inner = (def as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
    }
    const typeName = (inner as { _def?: { typeName?: string } })._def?.typeName ?? "";
    let kind: FieldDescriptor["kind"] = "string";
    if (typeName === "ZodBoolean") kind = "boolean";
    else if (typeName === "ZodArray") kind = "string[]";
    else if (typeName === "ZodUnion") kind = "string[]";
    fields.push({ name, kind, required: !isOptional });
  }
  return fields;
}
