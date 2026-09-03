import { z, ZodTypeAny } from 'zod';

const PRIMITIVE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']);

/** 将历史简写参数描述转换为标准 JSON Schema。 */
export function normalizeToolInputSchema(schema: any): {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
} {
  if (schema?.type === 'object' && schema.properties) {
    return {
      ...schema,
      type: 'object',
      properties: schema.properties,
      additionalProperties: schema.additionalProperties ?? false,
    };
  }

  const properties: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema || {})) {
    if (typeof value === 'string' && PRIMITIVE_TYPES.has(value)) {
      properties[key] = { type: value };
    } else if (value && typeof value === 'object') {
      properties[key] = value;
    }
  }

  return { type: 'object', properties, additionalProperties: false };
}

/** LLM 工具名只允许 ASCII 字母、数字、下划线，并保证注册名称稳定。 */
export function normalizeToolName(name: string, stableId: string): string {
  const normalized = name
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);

  if (normalized) return normalized;

  const fallback = stableId
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 56);
  return `tool_${fallback || 'unnamed'}`;
}

function schemaToZod(schema: any): ZodTypeAny {
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    return z.any().refine((value) => schema.enum.includes(value), {
      message: `must be one of: ${schema.enum.join(', ')}`,
    });
  }

  switch (schema?.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number().finite();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(schemaToZod(schema.items || {}));
    case 'object': {
      const required = new Set<string>(schema.required || []);
      const shape: Record<string, ZodTypeAny> = {};
      for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
        const field = schemaToZod(propertySchema);
        shape[key] = required.has(key) ? field : field.optional();
      }
      const objectSchema = z.object(shape);
      return schema.additionalProperties === true ? objectSchema.passthrough() : objectSchema.strict();
    }
    default:
      return z.unknown();
  }
}

/** 在执行前校验工具参数，失败信息会作为 observation 返回给 Agent。 */
export function validateToolArguments(schema: any, args: unknown): Record<string, any> {
  const normalizedSchema = normalizeToolInputSchema(schema);
  const parsed = schemaToZod(normalizedSchema).safeParse(args);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Tool arguments validation failed: ${details}`);
  }
  return parsed.data as Record<string, any>;
}
