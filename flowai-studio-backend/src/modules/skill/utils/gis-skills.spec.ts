import { featureCollection, point, polygon } from '@turf/turf';
import { executeGisSkill } from './gis-skills';

describe('GIS builtin skills', () => {
  it('creates a polygon buffer and keeps the requested unit', () => {
    const result = executeGisSkill('geo_buffer', {
      feature: point([116.397, 39.908]),
      distance: 1,
      unit: 'kilometers',
    }) as any;

    expect(result.feature.geometry.type).toBe('Polygon');
    expect(result.distance).toBe(1);
    expect(result.unit).toBe('kilometers');
  });

  it('filters candidate points inside the supplied polygon', () => {
    const candidates = featureCollection([
      point([0.5, 0.5], { name: 'inside' }),
      point([2, 2], { name: 'outside' }),
    ]);
    const area = polygon([[
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ]]);

    const result = executeGisSkill('geo_points_within_polygon', {
      points: candidates,
      area,
    }) as any;

    expect(result.matchedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.featureCollection.features[0].properties.name).toBe('inside');
  });

  it('ranks candidate points by distance and applies topK', () => {
    const candidates = featureCollection([
      point([116.45, 39.9], { name: 'farther' }),
      point([116.4, 39.9], { name: 'nearest' }),
    ]);

    const result = executeGisSkill('geo_rank_by_distance', {
      origin: [116.397, 39.908],
      candidates,
      topK: 1,
      unit: 'kilometers',
    }) as any;

    expect(result.returnedCount).toBe(1);
    expect(result.totalCount).toBe(2);
    expect(result.candidates[0].properties.name).toBe('nearest');
    expect(result.candidates[0].distance).toBeGreaterThan(0);
  });

  it('rejects an invalid coordinate range', () => {
    expect(() =>
      executeGisSkill('geo_rank_by_distance', {
        origin: [200, 95],
        candidates: featureCollection([]),
      }),
    ).toThrow('outside valid longitude/latitude bounds');
  });

  it('rejects an excessive buffer distance', () => {
    expect(() =>
      executeGisSkill('geo_buffer', {
        feature: point([0, 0]),
        distance: 1001,
        unit: 'kilometers',
      }),
    ).toThrow('must not exceed 1000 kilometers');
  });
});
