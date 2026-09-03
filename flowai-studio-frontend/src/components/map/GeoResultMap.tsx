import { useMemo, useRef } from 'react'
import { Empty, Tag } from 'antd'
import { Color, GeoJsonDataSource as CesiumGeoJsonDataSource } from 'cesium'
import { GeoJsonDataSource, Viewer } from 'resium'
import { useStore } from '../../store'
import { collectExecutionGeoJson } from '../../utils/geojson'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './GeoResultMap.css'

const GeoResultMap: React.FC = () => {
  const executionStates = useStore((state) => state.executionStates)
  const viewerRef = useRef<any>(null)
  const geoJson = useMemo(
    () => collectExecutionGeoJson(executionStates),
    [executionStates],
  )

  const handleLoad = (dataSource: CesiumGeoJsonDataSource) => {
    viewerRef.current?.cesiumElement?.flyTo(dataSource, {
      duration: 0.8,
      maximumHeight: 2_000_000,
    })
  }

  return (
    <div className="geo-result-map">
      <Viewer
        ref={viewerRef}
        full
        animation={false}
        timeline={false}
        baseLayerPicker={false}
        geocoder={false}
        navigationHelpButton={false}
        sceneModePicker
        requestRenderMode
        maximumRenderTimeChange={Infinity}
        baseLayer={false}
      >
        {geoJson.features.length > 0 && (
          <GeoJsonDataSource
            data={geoJson}
            clampToGround={false}
            markerColor={Color.fromCssColorString('#7c3aed')}
            markerSize={12}
            stroke={Color.fromCssColorString('#06b6d4')}
            strokeWidth={3}
            fill={Color.fromCssColorString('#06b6d4').withAlpha(0.28)}
            onLoad={handleLoad}
          />
        )}
      </Viewer>

      <div className="geo-result-map__badge">
        <Tag color="purple">GeoJSON {geoJson.features.length} 个要素</Tag>
      </div>

      {geoJson.features.length === 0 && (
        <div className="geo-result-map__empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="运行包含 GIS 工具的工作流后，GeoJSON 结果会显示在这里"
          />
        </div>
      )}
    </div>
  )
}

export default GeoResultMap
