import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { featureCollection, point } from '@turf/turf';
import { createGisMcpServer } from './gis-mcp-server';

describe('GIS MCP Server', () => {
  it('supports initialize, tool discovery, and a real tool call', async () => {
    const server = createGisMcpServer();
    const client = new Client({ name: 'gis-mcp-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      'geo_buffer',
      'geo_points_within_polygon',
      'geo_rank_by_distance',
    ]);

    const called = await client.callTool({
      name: 'geo_rank_by_distance',
      arguments: {
        origin: [116.397, 39.908],
        candidates: featureCollection([
          point([116.45, 39.9], { name: 'farther' }),
          point([116.4, 39.9], { name: 'nearest' }),
        ]),
        topK: 1,
      },
    });

    expect(called.isError).not.toBe(true);
    expect((called.structuredContent as any).candidates[0].properties.name).toBe('nearest');

    await client.close();
    await server.close();
  });
});
