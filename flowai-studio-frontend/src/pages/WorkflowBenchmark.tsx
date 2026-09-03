import { memo, Profiler, useCallback, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './WorkflowBenchmark.css'

interface BenchmarkMetrics {
  mountMs: number | null
  lastCommitMs: number | null
  viewportFps: number | null
  updateFps: number | null
  updatedNodeRenderCount: number | null
  unaffectedNodeRenderCount: number | null
}

const renderCounts = new Map<string, number>()

const BenchmarkNode = memo(({ id, data }: any) => {
  renderCounts.set(id, (renderCounts.get(id) || 0) + 1)
  return (
    <div className="benchmark-node">
      <span className="benchmark-node-dot" />
      <strong>{data.label}</strong>
      <small>{data.kind}</small>
    </div>
  )
})
BenchmarkNode.displayName = 'BenchmarkNode'

const nodeTypes = { benchmark: BenchmarkNode }

const generateGraph = (count: number) => {
  const columns = Math.ceil(Math.sqrt(count))
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `benchmark-${index}`,
    type: 'benchmark',
    position: {
      x: (index % columns) * 210,
      y: Math.floor(index / columns) * 100,
    },
    data: {
      label: `节点 ${index + 1}`,
      kind: index % 4 === 0 ? 'Agent' : index % 4 === 1 ? 'RAG' : 'Tool',
      revision: 0,
    },
  }))
  const edges = Array.from({ length: Math.max(count - 1, 0) }, (_, index) => ({
    id: `edge-${index}`,
    source: `benchmark-${index}`,
    target: `benchmark-${index + 1}`,
  }))
  return { nodes, edges }
}

const WorkflowBenchmarkContent = () => {
  const initialGraph = useMemo(() => generateGraph(100), [])
  const [nodeCount, setNodeCount] = useState(100)
  const [nodes, setNodes] = useState(initialGraph.nodes)
  const [edges, setEdges] = useState(initialGraph.edges)
  const [metrics, setMetrics] = useState<BenchmarkMetrics>({
    mountMs: null,
    lastCommitMs: null,
    viewportFps: null,
    updateFps: null,
    updatedNodeRenderCount: null,
    unaffectedNodeRenderCount: null,
  })
  const mountStartedAt = useRef(performance.now())
  const lastCommitMsRef = useRef<number | null>(null)
  const reactFlowRef = useRef<ReactFlowInstance | null>(null)

  const loadGraph = useCallback((count: number) => {
    renderCounts.clear()
    mountStartedAt.current = performance.now()
    const graph = generateGraph(count)
    setNodeCount(count)
    setNodes(graph.nodes)
    setEdges(graph.edges)
    setMetrics({
      mountMs: null,
      lastCommitMs: null,
      viewportFps: null,
      updateFps: null,
      updatedNodeRenderCount: null,
      unaffectedNodeRenderCount: null,
    })
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setMetrics((current) => ({
          ...current,
          mountMs: performance.now() - mountStartedAt.current,
          lastCommitMs: lastCommitMsRef.current,
        })),
      ),
    )
  }, [])

  const runViewportBenchmark = useCallback(() => {
    const instance = reactFlowRef.current
    if (!instance) return
    const startedAt = performance.now()
    let frames = 0
    const durationMs = 1200

    const step = (now: number) => {
      const elapsed = now - startedAt
      frames += 1
      instance.setViewport({
        x: Math.sin(elapsed / 180) * 100,
        y: Math.cos(elapsed / 220) * 60,
        zoom: 0.75 + Math.sin(elapsed / 300) * 0.08,
      })
      if (elapsed < durationMs) {
        requestAnimationFrame(step)
        return
      }
      const fps = (frames * 1000) / elapsed
      setMetrics((current) => ({
        ...current,
        viewportFps: fps,
        lastCommitMs: lastCommitMsRef.current,
      }))
    }
    requestAnimationFrame(step)
  }, [])

  const runNodeUpdateBenchmark = useCallback(() => {
    const before = new Map(renderCounts)
    const startedAt = performance.now()
    let frames = 0
    const totalUpdates = 60

    const step = () => {
      frames += 1
      setNodes((current) =>
        current.map((node, index) =>
          index === 0
            ? {
                ...node,
                data: { ...node.data, revision: frames, label: `节点 1 · ${frames}` },
              }
            : node,
        ),
      )

      if (frames < totalUpdates) {
        requestAnimationFrame(step)
        return
      }

      requestAnimationFrame(() => {
        const elapsed = performance.now() - startedAt
        let updatedNodeRenderCount = 0
        let unaffectedNodeRenderCount = 0
        for (const [id, count] of renderCounts) {
          const delta = count - (before.get(id) || 0)
          if (id === 'benchmark-0') updatedNodeRenderCount += delta
          else unaffectedNodeRenderCount += delta
        }
        setMetrics((current) => ({
          ...current,
          updateFps: (frames * 1000) / elapsed,
          lastCommitMs: lastCommitMsRef.current,
          updatedNodeRenderCount,
          unaffectedNodeRenderCount,
        }))
      })
    }
    requestAnimationFrame(step)
  }, [])

  return (
    <div className="workflow-benchmark-page">
      <header className="workflow-benchmark-toolbar">
        <div>
          <h1>React Flow 性能基准</h1>
          <p>隔离数据，不写入工作流；开发环境用于生成可复现的 100/300 节点证据。</p>
        </div>
        <div className="workflow-benchmark-actions">
          <button onClick={() => loadGraph(100)}>加载 100 节点</button>
          <button onClick={() => loadGraph(300)}>加载 300 节点</button>
          <button onClick={runViewportBenchmark}>测试视口交互</button>
          <button onClick={runNodeUpdateBenchmark}>测试单节点更新</button>
        </div>
      </header>

      <section className="workflow-benchmark-metrics" data-testid="benchmark-metrics">
        <span>节点 <strong>{nodeCount}</strong></span>
        <span>首次绘制 <strong>{metrics.mountMs?.toFixed(1) ?? '--'} ms</strong></span>
        <span>React Commit <strong>{metrics.lastCommitMs?.toFixed(1) ?? '--'} ms</strong></span>
        <span>视口交互 <strong>{metrics.viewportFps?.toFixed(1) ?? '--'} FPS</strong></span>
        <span>单节点更新 <strong>{metrics.updateFps?.toFixed(1) ?? '--'} FPS</strong></span>
        <span>目标节点渲染 <strong>{metrics.updatedNodeRenderCount ?? '--'}</strong></span>
        <span>其他节点渲染 <strong>{metrics.unaffectedNodeRenderCount ?? '--'}</strong></span>
      </section>

      <div className="workflow-benchmark-canvas">
        <Profiler
          id="workflow-benchmark"
          onRender={(_id, _phase, actualDuration) => {
            lastCommitMsRef.current = actualDuration
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onInit={(instance) => {
              reactFlowRef.current = instance
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  setMetrics((current) => ({
                    ...current,
                    mountMs: performance.now() - mountStartedAt.current,
                    lastCommitMs: lastCommitMsRef.current,
                  })),
                ),
              )
            }}
            nodesDraggable
            nodesConnectable={false}
            elementsSelectable
            onlyRenderVisibleElements
            fitView
            minZoom={0.05}
          >
            <Background gap={16} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </Profiler>
      </div>
    </div>
  )
}

const WorkflowBenchmark = () => (
  <ReactFlowProvider>
    <WorkflowBenchmarkContent />
  </ReactFlowProvider>
)

export default WorkflowBenchmark
