import type {
  Feature,
  FeatureCollection,
  GeoJsonProperties,
  Geometry,
} from 'geojson'
import type { NodeExecution } from '../types'

const MAX_RENDER_FEATURES = 10_000

/**
 * 从节点输出中提取可被 Cesium 消费的 GeoJSON。
 * 支持标准 Feature/FeatureCollection，以及距离排序工具返回的候选点包装结构。
 */
export function collectExecutionGeoJson(
  executionStates: Record<string, NodeExecution>,
): FeatureCollection {
  const features: Feature[] = []
  const visited = new WeakSet<object>()

  for (const execution of Object.values(executionStates)) {
    collectFeatures(execution.output, features, visited)
    if (features.length >= MAX_RENDER_FEATURES) break
  }

  return {
    type: 'FeatureCollection',
    features: features.slice(0, MAX_RENDER_FEATURES),
  }
}

function collectFeatures(
  value: unknown,
  target: Feature[],
  visited: WeakSet<object>,
): void {
  if (value == null || target.length >= MAX_RENDER_FEATURES) return

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return
    try {
      collectFeatures(JSON.parse(trimmed), target, visited)
    } catch {
      // 普通文本输出不是地图数据，直接忽略。
    }
    return
  }

  if (typeof value !== 'object') return
  if (visited.has(value)) return
  visited.add(value)

  if (Array.isArray(value)) {
    value.forEach((item) => collectFeatures(item, target, visited))
    return
  }

  const candidate = value as Record<string, unknown>
  if (candidate.type === 'FeatureCollection' && Array.isArray(candidate.features)) {
    candidate.features.forEach((feature) => collectFeatures(feature, target, visited))
    return
  }

  if (candidate.type === 'Feature' && isGeometry(candidate.geometry)) {
    target.push(candidate as unknown as Feature<Geometry, GeoJsonProperties>)
    return
  }

  // geo_rank_by_distance 返回 { geometry, properties, distance }，转换为标准 Feature。
  if (isGeometry(candidate.geometry)) {
    target.push({
      type: 'Feature',
      id: typeof candidate.id === 'string' || typeof candidate.id === 'number'
        ? candidate.id
        : undefined,
      geometry: candidate.geometry,
      properties: {
        ...(isRecord(candidate.properties) ? candidate.properties : {}),
        ...(typeof candidate.distance === 'number' ? { distance: candidate.distance } : {}),
      },
    })
    return
  }

  // 只递归常见工具包装字段，避免把任意大型业务对象全部扫描一遍。
  for (const key of [
    'feature',
    'featureCollection',
    'candidates',
    'result',
    'data',
    'toolResults',
  ]) {
    if (key in candidate) collectFeatures(candidate[key], target, visited)
  }
}

function isGeometry(value: unknown): value is Geometry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    'coordinates' in (value as object),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
