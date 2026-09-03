import {
  normalizeToolInputSchema,
  normalizeToolName,
  validateToolArguments,
} from '../utils/tool-schema.util';

describe('tool schema utilities', () => {
  it('allows arbitrary nested GeoJSON properties when explicitly configured', () => {
    const result = validateToolArguments(
      {
        type: 'object',
        properties: {
          feature: { type: 'object', additionalProperties: true },
        },
        required: ['feature'],
        additionalProperties: false,
      },
      {
        feature: {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [116.4, 39.9] },
          properties: { name: '候选点' },
        },
      },
    );

    expect(result.feature).toMatchObject({ type: 'Feature' });
  });

  it('normalizes legacy shorthand into JSON Schema', () => {
    expect(normalizeToolInputSchema({ expression: 'string' })).toEqual({
      type: 'object',
      properties: { expression: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('creates a stable fallback for non-ASCII tool names', () => {
    expect(normalizeToolName('空间缓冲区分析', 'builtin:geo_buffer')).toBe(
      'tool_builtin_geo_buffer',
    );
  });

  it('validates required fields and rejects unknown arguments', () => {
    const schema = {
      type: 'object',
      properties: { distance: { type: 'number' } },
      required: ['distance'],
      additionalProperties: false,
    };

    expect(validateToolArguments(schema, { distance: 500 })).toEqual({ distance: 500 });
    expect(() => validateToolArguments(schema, { unit: 'meter' })).toThrow(
      'Tool arguments validation failed',
    );
  });
});
