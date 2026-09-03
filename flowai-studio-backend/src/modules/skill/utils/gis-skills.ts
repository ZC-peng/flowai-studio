import {
  buffer,
  distance,
  featureCollection,
  point,
  pointsWithinPolygon,
} from '@turf/turf';
import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';

type DistanceUnit = 'kilometers' | 'meters' | 'miles';

const MAX_FEATURES = 10_000;
const MAX_TOP_K = 100;
const MAX_BUFFER_KILOMETERS = 1_000;

export const GIS_SKILL_DEFINITIONS = [
  {
    type: 'geo_buffer',
    name: 'geo_buffer',
    description: '对输入的 GeoJSON 要素生成指定距离的缓冲区，适用于服务半径、影响范围等空间分析。',
    inputSchema: {
      type: 'object',
      properties: {
        feature: {
          type: 'object',
          additionalProperties: true,
          description: 'GeoJSON Feature，支持 Point、LineString、Polygon 等几何类型',
        },
        distance: { type: 'number', exclusiveMinimum: 0 },
        unit: {
          type: 'string',
          enum: ['kilometers', 'meters', 'miles'],
          default: 'kilometers',
        },
      },
      required: ['feature', 'distance'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        feature: { type: 'object' },
        distance: { type: 'number' },
        unit: { type: 'string' },
      },
      required: ['feature', 'distance', 'unit'],
    },
  },
  {
    type: 'geo_points_within_polygon',
    name: 'geo_points_within_polygon',
    description: '筛选落在 Polygon 或 MultiPolygon 内的点要素，适用于候选设施范围过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        points: {
          type: 'object',
          additionalProperties: true,
          description: '由 Point 要素组成的 GeoJSON FeatureCollection，最多 10000 个点',
        },
        area: {
          type: 'object',
          additionalProperties: true,
          description: 'Polygon、MultiPolygon Feature 或相应 FeatureCollection',
        },
      },
      required: ['points', 'area'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        featureCollection: { type: 'object' },
        matchedCount: { type: 'number' },
        totalCount: { type: 'number' },
      },
      required: ['featureCollection', 'matchedCount', 'totalCount'],
    },
  },
  {
    type: 'geo_rank_by_distance',
    name: 'geo_rank_by_distance',
    description: '计算候选点到目标点的球面距离并按从近到远排序，适用于选址候选点初筛。',
    inputSchema: {
      type: 'object',
      properties: {
        origin: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '目标点坐标 [longitude, latitude]',
        },
        candidates: {
          type: 'object',
          additionalProperties: true,
          description: '由 Point 要素组成的 GeoJSON FeatureCollection，最多 10000 个点',
        },
        topK: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_TOP_K,
          default: 10,
        },
        unit: {
          type: 'string',
          enum: ['kilometers', 'meters', 'miles'],
          default: 'kilometers',
        },
      },
      required: ['origin', 'candidates'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        candidates: { type: 'array' },
        returnedCount: { type: 'number' },
        totalCount: { type: 'number' },
        unit: { type: 'string' },
      },
      required: ['candidates', 'returnedCount', 'totalCount', 'unit'],
    },
  },
] as const;

export function isGisSkill(type: string): boolean {
  return GIS_SKILL_DEFINITIONS.some((definition) => definition.type === type);
}

export function executeGisSkill(type: string, params: Record<string, unknown>): unknown {
  switch (type) {
    case 'geo_buffer':
      return executeBuffer(params);
    case 'geo_points_within_polygon':
      return executePointsWithinPolygon(params);
    case 'geo_rank_by_distance':
      return executeRankByDistance(params);
    default:
      throw new Error(`Unknown GIS skill type: ${type}`);
  }
}

function executeBuffer(params: Record<string, unknown>) {
  const source = assertFeature(params.feature, 'feature');
  const requestedDistance = assertPositiveNumber(params.distance, 'distance');
  const unit = parseUnit(params.unit);
  const distanceInKilometers = toKilometers(requestedDistance, unit);

  if (distanceInKilometers > MAX_BUFFER_KILOMETERS) {
    throw new Error(`distance must not exceed ${MAX_BUFFER_KILOMETERS} kilometers`);
  }

  const result = buffer(source, requestedDistance, { units: unit, steps: 32 });
  if (!result) {
    throw new Error('Unable to create a buffer for the supplied geometry');
  }

  return { feature: result, distance: requestedDistance, unit };
}

function executePointsWithinPolygon(params: Record<string, unknown>) {
  const points = assertPointCollection(params.points, 'points');
  const area = assertPolygonInput(params.area, 'area');
  const matched = pointsWithinPolygon(points, area);

  return {
    featureCollection: matched,
    matchedCount: matched.features.length,
    totalCount: points.features.length,
  };
}

function executeRankByDistance(params: Record<string, unknown>) {
  const origin = assertPosition(params.origin, 'origin');
  const candidates = assertPointCollection(params.candidates, 'candidates');
  const unit = parseUnit(params.unit);
  const topK = parseTopK(params.topK);
  const originFeature = point(origin);

  const ranked = candidates.features
    .map((candidate, originalIndex) => ({
      id: candidate.id ?? originalIndex,
      properties: candidate.properties ?? {},
      geometry: candidate.geometry,
      distance: distance(originFeature, candidate, { units: unit }),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, topK);

  return {
    candidates: ranked,
    returnedCount: ranked.length,
    totalCount: candidates.features.length,
    unit,
  };
}

function assertFeature(value: unknown, field: string): Feature<Geometry, GeoJsonProperties> {
  if (!value || typeof value !== 'object' || (value as Feature).type !== 'Feature') {
    throw new Error(`${field} must be a valid GeoJSON Feature`);
  }

  const geometry = (value as Feature).geometry;
  if (!geometry || typeof geometry.type !== 'string') {
    throw new Error(`${field}.geometry must be a valid GeoJSON geometry`);
  }

  return value as Feature<Geometry, GeoJsonProperties>;
}

function assertPointCollection(value: unknown, field: string): FeatureCollection<Point> {
  if (!value || typeof value !== 'object' || (value as FeatureCollection).type !== 'FeatureCollection') {
    throw new Error(`${field} must be a GeoJSON FeatureCollection`);
  }

  const collection = value as FeatureCollection;
  if (collection.features.length > MAX_FEATURES) {
    throw new Error(`${field} must contain at most ${MAX_FEATURES} features`);
  }

  if (collection.features.some((feature) => feature.geometry?.type !== 'Point')) {
    throw new Error(`${field} must contain only Point features`);
  }

  return collection as FeatureCollection<Point>;
}

function assertPolygonInput(
  value: unknown,
  field: string,
): Feature<Polygon | MultiPolygon> | FeatureCollection<Polygon | MultiPolygon> {
  if (!value || typeof value !== 'object') {
    throw new Error(`${field} must be a GeoJSON polygon Feature or FeatureCollection`);
  }

  if ((value as Feature).type === 'Feature') {
    const feature = value as Feature;
    if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) {
      throw new Error(`${field} must contain a Polygon or MultiPolygon geometry`);
    }
    return feature as Feature<Polygon | MultiPolygon>;
  }

  if ((value as FeatureCollection).type === 'FeatureCollection') {
    const collection = value as FeatureCollection;
    if (collection.features.length > MAX_FEATURES) {
      throw new Error(`${field} must contain at most ${MAX_FEATURES} features`);
    }
    if (
      collection.features.some(
        (feature) => !feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type),
      )
    ) {
      throw new Error(`${field} must contain only Polygon or MultiPolygon features`);
    }
    return collection as FeatureCollection<Polygon | MultiPolygon>;
  }

  throw new Error(`${field} must be a GeoJSON polygon Feature or FeatureCollection`);
}

function assertPosition(value: unknown, field: string): Position {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))
  ) {
    throw new Error(`${field} must be [longitude, latitude]`);
  }

  const [longitude, latitude] = value;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    throw new Error(`${field} is outside valid longitude/latitude bounds`);
  }
  return value;
}

function assertPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  return value;
}

function parseUnit(value: unknown): DistanceUnit {
  const unit = value ?? 'kilometers';
  if (!['kilometers', 'meters', 'miles'].includes(String(unit))) {
    throw new Error('unit must be kilometers, meters, or miles');
  }
  return unit as DistanceUnit;
}

function parseTopK(value: unknown): number {
  const topK = value ?? 10;
  if (!Number.isInteger(topK) || Number(topK) < 1 || Number(topK) > MAX_TOP_K) {
    throw new Error(`topK must be an integer between 1 and ${MAX_TOP_K}`);
  }
  return Number(topK);
}

function toKilometers(value: number, unit: DistanceUnit): number {
  if (unit === 'meters') return value / 1_000;
  if (unit === 'miles') return value * 1.609344;
  return value;
}
