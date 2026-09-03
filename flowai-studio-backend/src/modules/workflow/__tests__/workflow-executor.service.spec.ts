/**
 * WorkflowExecutorService 单元测试
 *
 * Phase 4.1 测试覆盖:
 * - 基础 DAG 执行
 * - 节点超时控制
 * - 工作流整体超时
 * - 节点重试
 * - continueOnError 模式
 * - 取消执行
 * - 进度上报
 * - 心跳事件
 */
import { WorkflowExecutorService } from '../services/workflow-executor.service';
import { Subject } from 'rxjs';

describe('WorkflowExecutorService', () => {
  let service: WorkflowExecutorService;
  let mockPrisma: any;
  let mockFactory: any;
  let mockExecutor: any;

  const buildWorkflow = (nodes: any[], edges: any[]) => ({
    id: 'wf_1',
    name: 'Test Workflow',
    nodes: JSON.stringify(nodes),
    edges: JSON.stringify(edges),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockExecutor = {
      execute: jest.fn().mockResolvedValue({ result: 'ok' }),
    };

    mockFactory = {
      getExecutor: jest.fn().mockReturnValue(mockExecutor),
    };

    mockPrisma = {
      workflow: {
        findUnique: jest.fn(),
      },
    };

    service = new WorkflowExecutorService(mockPrisma, mockFactory);
  });

  // ============================================================
  // 基础执行
  // ============================================================
  describe('Basic Execution', () => {
    it('should execute a simple linear workflow', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'start', type: 'start', data: {} },
            { id: 'llm', type: 'llm', data: {} },
            { id: 'output', type: 'output', data: {} },
          ],
          [
            { source: 'start', target: 'llm' },
            { source: 'llm', target: 'output' },
          ],
        ),
      );

      const result = await service.executeWorkflow('wf_1', { inputs: {} });

      expect(mockExecutor.execute).toHaveBeenCalledTimes(3);
      expect(result.start).toEqual({ result: 'ok' });
      expect(result.llm).toEqual({ result: 'ok' });
      expect(result.output).toEqual({ result: 'ok' });
    });

    it('should throw when workflow not found', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(null);

      await expect(
        service.executeWorkflow('missing', { inputs: {} }),
      ).rejects.toThrow('Workflow not found');
    });

    it('should pass inputs to context', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'start', type: 'start', data: {} }], []),
      );

      let capturedContext: any;
      mockExecutor.execute.mockImplementation((_node: any, ctx: any) => {
        capturedContext = ctx;
        return Promise.resolve({ result: 'ok' });
      });

      await service.executeWorkflow('wf_1', { inputs: { question: 'hello' } });

      expect(capturedContext.question).toBe('hello');
    });

    it('should generate a database-compatible UUID execution ID', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'start', type: 'start', data: {} }], []),
      );

      let capturedContext: any;
      mockExecutor.execute.mockImplementation((_node: any, ctx: any) => {
        capturedContext = ctx;
        return Promise.resolve({ result: 'ok' });
      });

      await service.executeWorkflow('wf_1', { inputs: {} });

      expect(capturedContext._executionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('Agent trace summary', () => {
    it('persists agent steps and runtime metrics in the node span', async () => {
      const tracingService = {
        startTrace: jest.fn().mockResolvedValue('trace-1'),
        endTrace: jest.fn().mockResolvedValue(undefined),
        startSpan: jest.fn().mockResolvedValue('span-1'),
        endSpan: jest.fn().mockResolvedValue(undefined),
      };
      service = new WorkflowExecutorService(
        mockPrisma,
        mockFactory,
        tracingService as any,
      );
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [{ id: 'agent-1', type: 'agent', data: {} }],
          [],
        ),
      );
      mockExecutor.execute.mockResolvedValue({
        result: '完成',
        success: true,
        iterations: 2,
        toolCallCount: 1,
        ragCallCount: 1,
        tokenUsage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
        trace: [
          {
            type: 'rag_retrieve',
            content: '检索到 1 条内容',
            timestamp: 1,
            data: {
              citations: [{ citationId: 'S1', documentName: '规范.md' }],
            },
          },
        ],
      });

      await service.executeWorkflow('wf_1', {
        inputs: {},
        userId: 'user-1',
      });

      const events = tracingService.endSpan.mock.calls[0][2];
      expect(events).toEqual(
        expect.arrayContaining([
          { key: 'agent_iterations', value: 2 },
          { key: 'tool_call_count', value: 1 },
          { key: 'rag_call_count', value: 1 },
          {
            key: 'token_usage',
            value: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
          },
        ]),
      );
      expect(events.find((event: any) => event.key === 'agent_steps').value[0]).toEqual(
        expect.objectContaining({
          type: 'rag_retrieve',
          citations: [{ citationId: 'S1', documentName: '规范.md' }],
        }),
      );
    });
  });

  describe('Graph validation and conditional joins', () => {
    it('should execute a join node after one condition branch is pruned', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'start', type: 'start', data: {} },
            { id: 'condition', type: 'condition', data: {} },
            { id: 'true_branch', type: 'llm', data: {} },
            { id: 'false_branch', type: 'llm', data: {} },
            { id: 'join', type: 'output', data: {} },
          ],
          [
            { source: 'start', target: 'condition' },
            { source: 'condition', sourceHandle: 'true', target: 'true_branch' },
            { source: 'condition', sourceHandle: 'false', target: 'false_branch' },
            { source: 'true_branch', target: 'join' },
            { source: 'false_branch', target: 'join' },
          ],
        ),
      );

      mockExecutor.execute.mockImplementation((node: any) =>
        Promise.resolve({ result: node.id === 'condition' ? true : 'ok' }),
      );

      const result = await service.executeWorkflow('wf_1', { inputs: {} });

      expect(result.true_branch).toEqual({ result: 'ok' });
      expect(result.false_branch).toBeUndefined();
      expect(result.join).toEqual({ result: 'ok' });
    });

    it('should reject a cyclic graph before executing nodes', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'a', type: 'llm', data: {} },
            { id: 'b', type: 'llm', data: {} },
          ],
          [
            { source: 'a', target: 'b' },
            { source: 'b', target: 'a' },
          ],
        ),
      );

      await expect(
        service.executeWorkflow('wf_1', { inputs: {} }),
      ).rejects.toThrow('cycle detected');
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // SSE 事件与进度上报
  // ============================================================
  describe('SSE Events & Progress', () => {
    it('should emit workflow_start with control config', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'start', type: 'start', data: {} }], []),
      );

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      await service.executeWorkflow('wf_1', { inputs: {} }, subject);

      const startEvent = events.find((e) => e.type === 'workflow_start');
      expect(startEvent).toBeDefined();
      expect(startEvent.data.totalNodes).toBe(1);
      expect(startEvent.data.control).toBeDefined();
      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'start' }),
        expect.any(Object),
        { sseSubject: subject },
      );
    });

    it('should emit node progress in node_status', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'a', type: 'start', data: {} },
            { id: 'b', type: 'output', data: {} },
          ],
          [{ source: 'a', target: 'b' }],
        ),
      );

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      await service.executeWorkflow('wf_1', { inputs: {} }, subject);

      const successEvents = events.filter(
        (e) => e.type === 'node_status' && e.data.status === 'success',
      );
      expect(successEvents.length).toBe(2);
      expect(successEvents[0].data.durationMs).toBeGreaterThanOrEqual(0);
      expect(successEvents[0].data.progress.total).toBe(2);
    });

    it('should emit done event with stats', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'a', type: 'start', data: {} }], []),
      );

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      await service.executeWorkflow('wf_1', { inputs: {} }, subject);

      const doneEvent = events.find((e) => e.type === 'done');
      expect(doneEvent).toBeDefined();
      expect(doneEvent.data.stats.executed).toBe(1);
      expect(doneEvent.data.stats.total).toBe(1);
    });
  });

  // ============================================================
  // 节点超时
  // ============================================================
  describe('Node Timeout', () => {
    it('should timeout a slow node', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'slow', type: 'llm', data: {} }], []),
      );

      mockExecutor.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ result: 'late' }), 500)),
      );

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      await expect(
        service.executeWorkflow(
          'wf_1',
          { inputs: {}, control: { nodeTimeoutMs: 50, heartbeatIntervalMs: 0 } },
          subject,
        ),
      ).rejects.toThrow(/timed out/);

      const timeoutEvent = events.find(
        (e) => e.type === 'node_status' && e.data.status === 'timeout',
      );
      expect(timeoutEvent).toBeDefined();
    });
  });

  // ============================================================
  // 工作流整体超时
  // ============================================================
  describe('Workflow Timeout', () => {
    it('should timeout the whole workflow', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'a', type: 'llm', data: {} },
            { id: 'b', type: 'llm', data: {} },
          ],
          [{ source: 'a', target: 'b' }],
        ),
      );

      mockExecutor.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ result: 'ok' }), 100)),
      );

      await expect(
        service.executeWorkflow('wf_1', {
          inputs: {},
          control: { workflowTimeoutMs: 50, nodeTimeoutMs: 0, heartbeatIntervalMs: 0 },
        }),
      ).rejects.toThrow(/timed out/);
    });
  });

  // ============================================================
  // 节点重试
  // ============================================================
  describe('Node Retry', () => {
    it('should retry a failing node and succeed', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'flaky', type: 'llm', data: {} }], []),
      );

      mockExecutor.execute
        .mockRejectedValueOnce({ response: { status: 503 } })
        .mockResolvedValue({ result: 'recovered' });

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      const result = await service.executeWorkflow(
        'wf_1',
        { inputs: {}, control: { maxRetries: 2, heartbeatIntervalMs: 0 } },
        subject,
      );

      expect(result.flaky).toEqual({ result: 'recovered' });
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      const retryEvent = events.find(
        (e) => e.type === 'node_status' && e.data.status === 'retrying',
      );
      expect(retryEvent).toBeDefined();
    });
  });

  // ============================================================
  // continueOnError
  // ============================================================
  describe('continueOnError', () => {
    it('should skip downstream of failed node but continue other branches', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'root', type: 'start', data: {} },
            { id: 'fail', type: 'llm', data: {} },
            { id: 'fail_child', type: 'output', data: {} },
            { id: 'ok_branch', type: 'output', data: {} },
          ],
          [
            { source: 'root', target: 'fail' },
            { source: 'root', target: 'ok_branch' },
            { source: 'fail', target: 'fail_child' },
          ],
        ),
      );

      mockExecutor.execute.mockImplementation((node: any) => {
        if (node.id === 'fail') {
          return Promise.reject(new Error('node failed'));
        }
        return Promise.resolve({ result: 'ok' });
      });

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      const result = await service.executeWorkflow(
        'wf_1',
        { inputs: {}, control: { continueOnError: true, heartbeatIntervalMs: 0 } },
        subject,
      );

      // root 和 ok_branch 应执行成功
      expect(result.root).toEqual({ result: 'ok' });
      expect(result.ok_branch).toEqual({ result: 'ok' });
      // fail_child 应被跳过
      const skipEvent = events.find(
        (e) => e.type === 'node_status' && e.data.nodeId === 'fail_child' && e.data.status === 'skipped',
      );
      expect(skipEvent).toBeDefined();
    });

    it('should fail fast when continueOnError is false (default)', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'fail', type: 'llm', data: {} }], []),
      );

      mockExecutor.execute.mockRejectedValue(new Error('boom'));

      await expect(
        service.executeWorkflow('wf_1', {
          inputs: {},
          control: { heartbeatIntervalMs: 0 },
        }),
      ).rejects.toThrow('boom');
    });
  });

  // ============================================================
  // 取消执行
  // ============================================================
  describe('Cancellation', () => {
    it('should cancel a running workflow', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow(
          [
            { id: 'a', type: 'llm', data: {} },
            { id: 'b', type: 'llm', data: {} },
          ],
          [{ source: 'a', target: 'b' }],
        ),
      );

      const executionId = 'wf_1_cancel_test';

      mockExecutor.execute.mockImplementation(async (node: any) => {
        if (node.id === 'a') {
          // 第一个节点执行时触发取消
          service.cancelExecution(executionId);
        }
        return { result: 'ok' };
      });

      await expect(
        service.executeWorkflow(
          'wf_1',
          { inputs: {}, control: { heartbeatIntervalMs: 0 } },
          undefined,
          executionId,
        ),
      ).rejects.toThrow(/cancelled/i);
    });

    it('should return false when cancelling non-existent execution', () => {
      expect(service.cancelExecution('nonexistent')).toBe(false);
    });

    it('should track running executions', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'a', type: 'start', data: {} }], []),
      );

      let runningDuringExec: string[] = [];
      mockExecutor.execute.mockImplementation(async () => {
        runningDuringExec = service.getRunningExecutions();
        return { result: 'ok' };
      });

      await service.executeWorkflow(
        'wf_1',
        { inputs: {}, control: { heartbeatIntervalMs: 0 } },
        undefined,
        'tracked_exec',
      );

      expect(runningDuringExec).toContain('tracked_exec');
      // 执行结束后应清理
      expect(service.getRunningExecutions()).not.toContain('tracked_exec');
    });
  });

  // ============================================================
  // 心跳
  // ============================================================
  describe('Heartbeat', () => {
    it('should emit heartbeat during long execution', async () => {
      mockPrisma.workflow.findUnique.mockResolvedValue(
        buildWorkflow([{ id: 'slow', type: 'llm', data: {} }], []),
      );

      mockExecutor.execute.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ result: 'ok' }), 150)),
      );

      const subject = new Subject<any>();
      const events: any[] = [];
      subject.subscribe((e) => events.push(e));

      await service.executeWorkflow(
        'wf_1',
        { inputs: {}, control: { heartbeatIntervalMs: 40, nodeTimeoutMs: 0 } },
        subject,
      );

      const heartbeats = events.filter((e) => e.type === 'heartbeat');
      expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    });
  });
});
