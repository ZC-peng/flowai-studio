import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { executeGisSkill } from '../modules/skill/utils/gis-skills';

const geoJsonObject = z.record(z.string(), z.unknown());
const distanceUnit = z.enum(['kilometers', 'meters', 'miles']).default('kilometers');

export function createGisMcpServer(): McpServer {
  const server = new McpServer({
    name: 'flowai-gis-tools',
    version: '1.0.0',
  });

  server.registerTool(
    'geo_buffer',
    {
      title: 'GeoJSON 缓冲区分析',
      description: '对 GeoJSON 要素生成指定距离的缓冲区。',
      inputSchema: {
        feature: geoJsonObject.describe('GeoJSON Feature'),
        distance: z.number().positive(),
        unit: distanceUnit,
      },
    },
    async (args) => toMcpResult(() => executeGisSkill('geo_buffer', args)),
  );

  server.registerTool(
    'geo_points_within_polygon',
    {
      title: '候选点范围筛选',
      description: '筛选落在 Polygon 或 MultiPolygon 内的 Point 要素。',
      inputSchema: {
        points: geoJsonObject.describe('Point FeatureCollection'),
        area: geoJsonObject.describe('Polygon/MultiPolygon Feature 或 FeatureCollection'),
      },
    },
    async (args) => toMcpResult(() => executeGisSkill('geo_points_within_polygon', args)),
  );

  server.registerTool(
    'geo_rank_by_distance',
    {
      title: '候选点距离排序',
      description: '计算候选点到目标点的球面距离并返回最近的 Top-K 候选点。',
      inputSchema: {
        origin: z.tuple([
          z.number().min(-180).max(180),
          z.number().min(-90).max(90),
        ]),
        candidates: geoJsonObject.describe('Point FeatureCollection'),
        topK: z.number().int().min(1).max(100).default(10),
        unit: distanceUnit,
      },
    },
    async (args) => toMcpResult(() => executeGisSkill('geo_rank_by_distance', args)),
  );

  return server;
}

function toMcpResult(execute: () => unknown) {
  try {
    const result = execute();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: error instanceof Error ? error.message : 'Unknown GIS tool error',
        },
      ],
      isError: true,
    };
  }
}

export async function startGisMcpServer(): Promise<void> {
  const server = createGisMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  startGisMcpServer().catch((error) => {
    console.error('GIS MCP Server failed:', error);
    process.exit(1);
  });
}
