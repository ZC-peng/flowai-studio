import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../common/services/prisma.service';
import { NodeExecutorFactory } from './node-executor.factory';
import { RunWorkflowDto, ExecutionControlDto } from '../dto/run-workflow.dto';
import { TracingService } from './tracing.service';
import { Subject } from 'rxjs';
import { randomUUID } from 'crypto';
import {
  withTimeout,
  retryWithBackoff,
  HeartbeatManager,
  TimeoutError,
  CancelledError,
} from '../utils/execution-control.util';

/** 执行控制默认值 */
const DEFAULT_CONTROL: Required<ExecutionControlDto> = {
  workflowTimeoutMs: 300000, // 5 分钟
  nodeTimeoutMs: 60000, // 1 分钟
  heartbeatIntervalMs: 15000, // 15 秒
  maxRetries: 0,
  continueOnError: false,
};

interface RuntimeEdge {
  key: string;
  source: string;
  target: string;
  sourceHandle?: string;
}

@Injectable()
export class WorkflowExecutorService {
  private readonly logger = new Logger(WorkflowExecutorService.name);

  /** 正在运行的工作流取消标记 */
  private readonly cancelTokens = new Map<
    string,
    { cancelled: boolean; userId?: string; workflowId: string }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly factory: NodeExecutorFactory,
    @Optional() private readonly tracingService?: TracingService,
  ) {}

  async executeWorkflow(
    workflowId: string,
    runDto: RunWorkflowDto,
    sseSubject?: Subject<any>,
    executionId?: string,
  ) {
    const workflow = await this.prisma.workflow.findUnique({
      where: { id: workflowId },
    });

    if (!workflow) {
      throw new Error('Workflow not found');
    }

    // 合并执行控制配置
    const control: Required<ExecutionControlDto> = {
      ...DEFAULT_CONTROL,
      ...(runDto.control || {}),
    };

    // 注册取消标记
    const execId = executionId || randomUUID();
    const cancelToken = {
      cancelled: false,
      userId: runDto.userId,
      workflowId,
    };
    this.cancelTokens.set(execId, cancelToken);

    const nodes = JSON.parse(workflow.nodes) as any[];
    const edges = JSON.parse(workflow.edges) as any[];

    this.validateGraph(nodes, edges);

    // 为每条边建立稳定运行时标识，以区分“已决议”和“被激活”。
    const runtimeEdges: RuntimeEdge[] = edges.map((edge, index) => ({
      key: edge.id || `${edge.source}:${edge.sourceHandle || ''}:${edge.target}:${index}`,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
    }));
    const adjList = new Map<string, RuntimeEdge[]>();
    const incomingEdges = new Map<string, RuntimeEdge[]>();

    for (const node of nodes) {
      adjList.set(node.id, []);
      incomingEdges.set(node.id, []);
    }

    for (const edge of runtimeEdges) {
      adjList.get(edge.source)!.push(edge);
      incomingEdges.get(edge.target)!.push(edge);
    }

    // Start Trace (全链路追踪)
    let traceId: string | undefined;
    if (this.tracingService) {
      try {
        traceId = await this.tracingService.startTrace({
          workflowId,
          userId: runDto.userId,
          applicationId: workflow.applicationId,
          executionId: execId,
          inputs: runDto.inputs,
        });
      } catch (e) {
        this.logger.warn(`Failed to start trace: ${e instanceof Error ? e.message : 'Unknown'}`);
      }
    }

    // BFS-style execution: start from nodes with in-degree 0
    const context: Record<string, any> = {
      ...runDto.inputs,
      // 注入元数据供节点执行器使用（如 Token 使用量记录）
      _workflowId: workflowId,
      _applicationId: workflow.applicationId,
      _executionId: execId,
      _userId: runDto.userId,
      _traceId: traceId,
    };
    const executed = new Set<string>();
    const skipped = new Set<string>();
    const failed = new Set<string>();
    const queued = new Set<string>();
    const resolvedEdges = new Set<string>();
    const activatedEdges = new Set<string>();
    let currentNodeId: string | undefined;

    // 根节点没有前置依赖，可直接进入调度队列。
    const queue: string[] = nodes
      .filter((node) => incomingEdges.get(node.id)!.length === 0)
      .map((n) => n.id);
    queue.forEach((nodeId) => queued.add(nodeId));

    const resolveNodeIfReady = (nodeId: string) => {
      if (
        executed.has(nodeId) ||
        skipped.has(nodeId) ||
        failed.has(nodeId) ||
        queued.has(nodeId)
      ) {
        return;
      }

      const incoming = incomingEdges.get(nodeId) || [];
      if (!incoming.every((edge) => resolvedEdges.has(edge.key))) return;

      if (incoming.some((edge) => activatedEdges.has(edge.key))) {
        queue.push(nodeId);
        queued.add(nodeId);
        return;
      }

      // 所有上游边都已决议但没有任何一条被激活，该节点属于未选分支。
      skipped.add(nodeId);
      sseSubject?.next({
        type: 'node_status',
        data: { nodeId, status: 'skipped' },
      });

      const downstream = adjList.get(nodeId) || [];
      downstream.forEach((edge) => resolvedEdges.add(edge.key));
      new Set(downstream.map((edge) => edge.target)).forEach(resolveNodeIfReady);
    };

    const settleOutgoingEdges = (
      outgoing: RuntimeEdge[],
      shouldActivate: (edge: RuntimeEdge) => boolean,
    ) => {
      for (const edge of outgoing) {
        resolvedEdges.add(edge.key);
        if (shouldActivate(edge)) activatedEdges.add(edge.key);
      }
      new Set(outgoing.map((edge) => edge.target)).forEach(resolveNodeIfReady);
    };

    // 启动心跳保活管理器
    const heartbeat = new HeartbeatManager(sseSubject, control.heartbeatIntervalMs);
    heartbeat.start(() => ({
      executed: executed.size,
      total: nodes.length,
      currentNode: currentNodeId,
    }));

    // 推送开始事件（含执行控制配置）
    sseSubject?.next({
      type: 'workflow_start',
      data: {
        executionId: execId,
        totalNodes: nodes.length,
        control,
      },
    });

    // 整体工作流执行逻辑
    const runLoop = async () => {
      while (queue.length > 0) {
        // 检查取消
        if (cancelToken.cancelled) {
          throw new CancelledError('Workflow execution was cancelled');
        }

        const nodeId = queue.shift()!;
        queued.delete(nodeId);

        // Skip if already executed or skipped
        if (executed.has(nodeId) || skipped.has(nodeId) || failed.has(nodeId)) continue;

        const node = nodes.find((n) => n.id === nodeId);
        if (!node) continue;

        currentNodeId = nodeId;
        const executor = this.factory.getExecutor(node.type);

        // Start Span (全链路追踪 - 节点级别)
        let spanId: string | undefined;
        if (this.tracingService && traceId) {
          try {
            spanId = await this.tracingService.startSpan({
              traceId,
              name: `${node.type}:${nodeId}`,
              kind: 'internal',
              attributes: { nodeId, nodeType: node.type, nodeName: node.name || node.id },
            });
          } catch (e) {
            this.logger.warn(`Failed to start span for node ${nodeId}: ${e instanceof Error ? e.message : 'Unknown'}`);
          }
        }

        try {
          sseSubject?.next({
            type: 'node_status',
            data: {
              nodeId,
              status: 'running',
              progress: {
                executed: executed.size,
                total: nodes.length,
              },
            },
          });

          const nodeStartTime = Date.now();

          // 节点执行：超时控制 + 重试
          const output = await retryWithBackoff(
            () =>
              withTimeout(
                executor.execute(node, context, { sseSubject }),
                control.nodeTimeoutMs,
                'node',
                nodeId,
              ),
            {
              maxRetries: control.maxRetries,
              onRetry: (attempt, error, delayMs) => {
                this.logger.warn(
                  `Node ${nodeId} failed (attempt ${attempt}), retrying in ${delayMs}ms: ${error.message}`,
                );
                sseSubject?.next({
                  type: 'node_status',
                  data: {
                    nodeId,
                    status: 'retrying',
                    attempt,
                    delayMs,
                    error: error.message,
                  },
                });
              },
            },
          );

          const nodeDuration = Date.now() - nodeStartTime;

          context[nodeId] = output;
          executed.add(nodeId);

          // End Span - 成功
          if (this.tracingService && spanId) {
            try {
              await this.tracingService.endSpan(
                spanId,
                'ok',
                this.buildNodeSpanEvents(node.type, output, nodeDuration),
              );
            } catch (e) {
              this.logger.warn(`Failed to end span ${spanId}: ${e instanceof Error ? e.message : 'Unknown'}`);
            }
          }

          sseSubject?.next({
            type: 'node_status',
            data: {
              nodeId,
              status: 'success',
              output,
              durationMs: nodeDuration,
              progress: {
                executed: executed.size,
                total: nodes.length,
              },
            },
          });

          // Get downstream edges
          const downstream = adjList.get(nodeId) || [];

          if (node.type === 'condition') {
            const conditionResult = output?.result;
            const matchHandle = conditionResult ? 'true' : 'false';
            settleOutgoingEdges(
              downstream,
              (edge) => edge.sourceHandle === matchHandle,
            );
          } else {
            settleOutgoingEdges(downstream, () => true);
          }
        } catch (error) {
          const isTimeout = error instanceof TimeoutError;
          const isCancelled = error instanceof CancelledError;

          failed.add(nodeId);

          // End Span - 失败
          if (this.tracingService && spanId) {
            try {
              await this.tracingService.endSpan(spanId, 'error', [
                { key: 'error', value: error.message },
                { key: 'errorType', value: isTimeout ? 'timeout' : isCancelled ? 'cancelled' : 'execution_error' },
              ]);
            } catch (e) {
              this.logger.warn(`Failed to end span ${spanId} on error: ${e instanceof Error ? e.message : 'Unknown'}`);
            }
          }

          sseSubject?.next({
            type: 'node_status',
            data: {
              nodeId,
              status: isTimeout ? 'timeout' : 'failed',
              error: error.message,
            },
          });

          // 取消错误直接抛出，不受 continueOnError 影响
          if (isCancelled) {
            throw error;
          }

          // continueOnError 模式：跳过当前节点的下游分支，继续执行其他分支
          if (control.continueOnError) {
            this.logger.warn(
              `Node ${nodeId} failed but continueOnError is enabled, skipping downstream: ${error.message}`,
            );
            const downstream = adjList.get(nodeId) || [];
            settleOutgoingEdges(downstream, () => false);
            continue;
          }

          // 默认行为：失败即中断
          sseSubject?.next({
            type: 'error',
            data: {
              message: `Error executing node ${nodeId}: ${error.message}`,
              nodeId,
              isTimeout,
            },
          });
          throw error;
        }
      }
    };

    try {
      // 工作流整体超时控制
      await withTimeout(runLoop(), control.workflowTimeoutMs, 'workflow', workflow.name);

      // End Trace - 成功
      if (this.tracingService && traceId) {
        try {
          await this.tracingService.endTrace(traceId, 'success', context);
        } catch (e) {
          this.logger.warn(`Failed to end trace on success: ${e instanceof Error ? e.message : 'Unknown'}`);
        }
      }

      sseSubject?.next({
        type: 'done',
        data: {
          finalContext: context,
          stats: {
            executed: executed.size,
            skipped: skipped.size,
            failed: failed.size,
            total: nodes.length,
            durationMs: heartbeat.getElapsedMs(),
          },
        },
      });

      return context;
    } catch (error) {
      const isTimeout = error instanceof TimeoutError;
      const isCancelled = error instanceof CancelledError;

      // End Trace - 失败
      if (this.tracingService && traceId) {
        try {
          await this.tracingService.endTrace(traceId, 'failed', undefined, error.message);
        } catch (e) {
          this.logger.warn(`Failed to end trace on failure: ${e instanceof Error ? e.message : 'Unknown'}`);
        }
      }

      sseSubject?.next({
        type: 'error',
        data: {
          message: error.message,
          isTimeout,
          isCancelled,
          scope: isTimeout ? (error as TimeoutError).scope : undefined,
          stats: {
            executed: executed.size,
            skipped: skipped.size,
            failed: failed.size,
            total: nodes.length,
            durationMs: heartbeat.getElapsedMs(),
          },
        },
      });

      throw error;
    } finally {
      heartbeat.stop();
      this.cancelTokens.delete(execId);
    }
  }

  /**
   * 将 Agent 内部步骤压缩到所属工作流节点 Span 中。
   * 这里只保留诊断所需的摘要，避免把完整 Prompt、工具参数或大段输出写入 Trace。
   */
  private buildNodeSpanEvents(
    nodeType: string,
    output: Record<string, any> | undefined,
    durationMs: number,
  ): Array<Record<string, any>> {
    const events: Array<Record<string, any>> = [
      { key: 'output_keys', value: output ? Object.keys(output) : [] },
      { key: 'durationMs', value: durationMs },
    ];

    if (nodeType !== 'agent' || !output) {
      return events;
    }

    events.push(
      { key: 'agent_iterations', value: output.iterations || 0 },
      { key: 'tool_call_count', value: output.toolCallCount || 0 },
      { key: 'rag_call_count', value: output.ragCallCount || 0 },
      { key: 'agent_success', value: Boolean(output.success) },
      { key: 'token_usage', value: output.tokenUsage || null },
    );

    if (Array.isArray(output.trace)) {
      events.push({
        key: 'agent_steps',
        value: output.trace.slice(0, 50).map((entry: any) => ({
          type: entry.type,
          content: String(entry.content || '').slice(0, 300),
          agentId: entry.agentId,
          timestamp: entry.timestamp,
          ...(entry.type === 'rag_retrieve' && entry.data?.citations
            ? { citations: entry.data.citations }
            : {}),
        })),
      });
    }

    return events;
  }

  /**
   * 取消正在运行的工作流
   *
   * @param executionId 执行 ID
   * @returns 是否成功标记取消
   */
  cancelExecution(executionId: string, userId?: string, workflowId?: string): boolean {
    const token = this.cancelTokens.get(executionId);
    if (
      token &&
      (!userId || token.userId === userId) &&
      (!workflowId || token.workflowId === workflowId)
    ) {
      token.cancelled = true;
      this.logger.log(`Workflow execution ${executionId} marked for cancellation`);
      return true;
    }
    return false;
  }

  /**
   * 获取正在运行的执行 ID 列表
   */
  getRunningExecutions(userId?: string, workflowId?: string): string[] {
    return Array.from(this.cancelTokens.entries())
      .filter(([, token]) => !userId || token.userId === userId)
      .filter(([, token]) => !workflowId || token.workflowId === workflowId)
      .map(([executionId]) => executionId);
  }

  private validateGraph(nodes: any[], edges: any[]): void {
    if (nodes.length === 0) {
      throw new Error('Workflow graph must contain at least one node');
    }

    const nodeIds = new Set<string>();
    for (const node of nodes) {
      if (!node?.id || nodeIds.has(node.id)) {
        throw new Error(`Workflow graph contains an invalid or duplicate node id: ${node?.id}`);
      }
      nodeIds.add(node.id);
    }

    const inDegree = new Map<string, number>(
      nodes.map((node) => [node.id, 0]),
    );
    const adjacency = new Map<string, string[]>(
      nodes.map((node) => [node.id, []]),
    );

    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        throw new Error(
          `Workflow edge references a missing node: ${edge.source} -> ${edge.target}`,
        );
      }
      adjacency.get(edge.source)!.push(edge.target);
      inDegree.set(edge.target, inDegree.get(edge.target)! + 1);
    }

    const queue = nodes
      .filter((node) => inDegree.get(node.id) === 0)
      .map((node) => node.id);
    let visited = 0;

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      visited++;
      for (const target of adjacency.get(nodeId) || []) {
        const nextDegree = inDegree.get(target)! - 1;
        inDegree.set(target, nextDegree);
        if (nextDegree === 0) queue.push(target);
      }
    }

    if (visited !== nodes.length) {
      throw new Error('Workflow graph must be a DAG: cycle detected');
    }
  }
}
