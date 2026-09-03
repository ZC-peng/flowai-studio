import { describe, expect, it } from 'vitest'
import type { NodeExecution } from '../types'
import { collectExecutionGeoJson } from './geojson'

const success = (nodeId: string, output: unknown): NodeExecution => ({
  nodeId,
  status: 'success',
  output,
})

describe('collectExecutionGeoJson', () => {
  it('collects standard GeoJSON features from node output wrappers', () => {
    const result = collectExecutionGeoJson({
      buffer: success('buffer', {
        result: {
          featureCollection: {
            type: 'FeatureCollection',
            features: [
              {
                type: 'Feature',
                properties: { name: 'service-area' },
                geometry: {
                  type: 'Polygon',
                  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
                },
              },
            ],
          },
        },
      }),
    })

    expect(result.features).toHaveLength(1)
    expect(result.features[0].properties?.name).toBe('service-area')
  })

  it('normalizes distance ranking candidates into GeoJSON Features', () => {
    const result = collectExecutionGeoJson({
      rank: success('rank', {
        candidates: [
          {
            id: 'site-1',
            properties: { name: '候选点 A' },
            geometry: { type: 'Point', coordinates: [116.4, 39.9] },
            distance: 1.25,
          },
        ],
      }),
    })

    expect(result.features[0]).toMatchObject({
      type: 'Feature',
      id: 'site-1',
      properties: { name: '候选点 A', distance: 1.25 },
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
    })
  })

  it('collects GIS results exposed by an Agent tool call', () => {
    const result = collectExecutionGeoJson({
      agent: success('agent', {
        result: '候选点排序完成',
        toolResults: [
          {
            toolName: 'geo_rank_by_distance',
            success: true,
            result: {
              candidates: [
                {
                  id: 'site-a',
                  properties: { name: '候选点 A' },
                  geometry: { type: 'Point', coordinates: [116.397, 39.908] },
                  distance: 0.34,
                },
              ],
            },
          },
        ],
      }),
    })

    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({
      id: 'site-a',
      properties: { name: '候选点 A', distance: 0.34 },
    })
  })

  it('ignores plain LLM text and malformed JSON strings', () => {
    const result = collectExecutionGeoJson({
      llm: success('llm', '这是普通回答'),
      malformed: success('malformed', '{not-json}'),
    })

    expect(result.features).toEqual([])
  })
})
