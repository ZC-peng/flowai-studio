import { useState } from 'react'
import { Button, Input, Empty, message } from 'antd'
import {
  PlayCircleOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  ClockCircleOutlined,
  ClearOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import { useStore } from '../../store'
import './RunPanel.css'
import { useShallow } from 'zustand/react/shallow'

const { TextArea } = Input

const RunPanel: React.FC = () => {
  const {
    currentWorkflow,
    nodes,
    executionStates,
    executionStatus,
    streamRunWorkflow,
    cancelWorkflowExecution,
    clearExecutionStates,
  } = useStore(useShallow((state) => ({
    currentWorkflow: state.currentWorkflow,
    nodes: state.nodes,
    executionStates: state.executionStates,
    executionStatus: state.executionStatus,
    streamRunWorkflow: state.streamRunWorkflow,
    cancelWorkflowExecution: state.cancelWorkflowExecution,
    clearExecutionStates: state.clearExecutionStates,
  })))

  const [inputsText, setInputsText] = useState('{"question": "你好，请介绍一下自己"}')
  const [isRunning, setIsRunning] = useState(false)

  const handleRun = async () => {
    const workflowId = currentWorkflow?.id
    if (!workflowId) return

    let inputs: Record<string, any> = {}
    try {
      inputs = JSON.parse(inputsText)
    } catch {
      message.error('输入参数不是合法 JSON')
      return
    }

    setIsRunning(true)
    try {
      await streamRunWorkflow(workflowId, inputs)
    } catch {
      // Error handled in store
    } finally {
      setIsRunning(false)
    }
  }

  const handleStop = async () => {
    const workflowId = currentWorkflow?.id
    if (!workflowId) return
    try {
      await cancelWorkflowExecution(workflowId)
    } catch {
      message.warning('取消请求未确认，已关闭本地流连接')
    } finally {
      setIsRunning(false)
    }
  }

  const handleClear = () => {
    clearExecutionStates()
    useStore.getState().setExecutionStatus(null)
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case 'running':
        return <LoadingOutlined spin style={{ color: 'var(--c-blue)' }} />
      case 'success':
        return <CheckCircleOutlined style={{ color: 'var(--c-green)' }} />
      case 'failed':
        return <CloseCircleOutlined style={{ color: 'var(--c-red)' }} />
      case 'skipped':
        return <MinusCircleOutlined style={{ color: 'var(--c-text-tertiary)' }} />
      default:
        return <ClockCircleOutlined style={{ color: 'var(--c-text-tertiary)' }} />
    }
  }

  const executedNodes = Object.values(executionStates)
  const hasResults = executedNodes.length > 0

  return (
    <div className="run-panel">
      <div className="run-panel-header">
        <h3>调试运行</h3>
      </div>

      <div className="run-panel-body">
        {/* Input section */}
        <div className="run-section">
          <label className="run-section-label">输入参数 (JSON)</label>
          <TextArea
            value={inputsText}
            onChange={(e) => setInputsText(e.target.value)}
            placeholder='{"question": "你好"}'
            rows={4}
            className="run-input-textarea"
            disabled={isRunning}
          />
        </div>

        {/* Action buttons */}
        <div className="run-actions">
          {isRunning ? (
            <Button
              danger
              icon={<StopOutlined />}
              onClick={handleStop}
              block
              size="middle"
            >
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleRun}
              block
              size="middle"
            >
              运行工作流
            </Button>
          )}
          {hasResults && !isRunning && (
            <Button
              icon={<ClearOutlined />}
              onClick={handleClear}
              size="middle"
              className="run-clear-btn"
            >
              清除
            </Button>
          )}
        </div>

        {/* Execution status */}
        {executionStatus && (
          <div className={`run-status run-status--${executionStatus}`}>
            {statusIcon(executionStatus)}
            <span>
              {executionStatus === 'running'
                ? '运行中…'
                : executionStatus === 'success'
                ? '执行完成'
                : executionStatus === 'failed'
                ? '执行失败'
                : '已停止'}
            </span>
          </div>
        )}

        {/* Node results */}
        {hasResults ? (
          <div className="run-results">
            <label className="run-section-label">节点执行结果</label>
            {executedNodes.map((exec) => {
              const node = nodes.find((n) => n.id === exec.nodeId)
              return (
                <div key={exec.nodeId} className="run-result-card">
                  <div className="run-result-header">
                    {statusIcon(exec.status)}
                    <span className="run-result-name">
                      {(node?.data as any)?.label || exec.nodeId}
                    </span>
                    <span className="run-result-type">{node?.type}</span>
                  </div>
                  {exec.output !== undefined && (
                    <pre className="run-result-output">
                      {typeof exec.output === 'string'
                        ? exec.output
                        : JSON.stringify(exec.output, null, 2)}
                    </pre>
                  )}
                  {exec.error && (
                    <div className="run-result-error">{exec.error}</div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          !isRunning && (
            <div className="run-empty">
              <Empty
                description="点击「运行工作流」开始调试"
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              />
            </div>
          )
        )}
      </div>
    </div>
  )
}

export default RunPanel
