/**
 * AgentExecutorService 单元测试
 *
 * Phase 3.1 + 3.2 测试覆盖:
 * - Single Agent ReAct 循环
 * - 工具调用与结果处理
 * - 最大迭代次数限制
 * - Supervisor/Worker 模式
 * - RAG 集成
 * - 执行轨迹
 * - 错误处理
 * - 多模型路由
 */
import { AgentExecutorService } from '../services/agent-executor.service';
import { LLMProviderFactory } from '../providers/llm-provider.factory';
import { SkillService } from '../../skill/services/skill.service';
import { RAGService } from '../../rag/services/rag.service';
import {
  AgentNodeConfig,
  LLMResponse,
} from '../interfaces/agent.interface';

describe('AgentExecutorService', () => {
  let agentExecutor: AgentExecutorService;
  let mockProviderFactory: any;
  let mockProvider: any;
  let mockSkillService: any;
  let mockRAGService: any;
  let mockPrismaService: any;
  let mockMcpService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock LLM Provider
    mockProvider = {
      chat: jest.fn(),
      chatStream: jest.fn(),
      buildToolDefinitions: jest.fn().mockReturnValue([]),
      name: 'qwen',
      defaultModel: 'qwen-turbo',
      supportedModels: [],
      healthCheck: jest.fn().mockResolvedValue(true),
      estimateTokens: jest.fn().mockReturnValue(100),
    };

    // Mock LLMProviderFactory
    mockProviderFactory = {
      getProviderForModel: jest.fn().mockReturnValue(mockProvider),
      create: jest.fn().mockReturnValue(mockProvider),
    };

    // Mock SkillService
    mockSkillService = {
      getBuiltinSkills: jest.fn().mockResolvedValue([
        {
          type: 'calculator',
          name: 'calculator',
          description: '计算数学表达式',
          inputSchema: {
            type: 'object',
            properties: { expression: { type: 'string' } },
            required: ['expression'],
            additionalProperties: false,
          },
        },
      ]),
      findSkillById: jest.fn(),
      executeSkill: jest.fn(),
    };

    // Mock RAGService
    mockRAGService = {
      retrieve: jest.fn(),
    };

    // Mock PrismaService
    mockPrismaService = {
      skill: {
        findUnique: jest.fn(),
      },
    };

    mockMcpService = {
      findConnectedTool: jest.fn(),
      callTool: jest.fn(),
    };

    agentExecutor = new AgentExecutorService(
      mockProviderFactory as any,
      mockSkillService as any,
      mockRAGService as any,
      mockPrismaService as any,
      mockMcpService as any,
    );
  });

  // ============================================================
  // Single Agent
  // ============================================================

  describe('Single Agent', () => {
    const singleConfig: AgentNodeConfig = {
      mode: 'single',
      strategy: 'react',
      maxIterations: 10,
      memoryEnabled: false,
      memoryWindowSize: 10,
      singleAgent: {
        id: 'test_agent',
        name: '测试助手',
        description: '测试用',
        systemPrompt: '你是一个测试助手。',
        model: 'qwen-turbo',
        temperature: 0.7,
        maxTokens: 2048,
        toolIds: ['builtin:calculator'],
        knowledgeBaseIds: [],
        ragEnabled: false,
      },
    };

    it('should execute a single agent with direct answer', async () => {
      mockProvider.chat.mockResolvedValue({
        content: '这是最终答案',
        toolCalls: undefined,
        usage: {
          promptTokens: 12,
          completionTokens: 8,
          totalTokens: 20,
        },
      });

      const result = await agentExecutor.execute(singleConfig, '你好');

      expect(result.success).toBe(true);
      expect(result.result).toBe('这是最终答案');
      expect(result.iterations).toBe(1);
      expect(result.tokenUsage).toEqual({
        promptTokens: 12,
        completionTokens: 8,
        totalTokens: 20,
      });
      expect(mockProviderFactory.getProviderForModel).toHaveBeenCalledWith('qwen-turbo');
    });

    it('should execute tool calls and return final answer', async () => {
      // 第一次调用返回工具调用
      mockProvider.chat.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'calculator', arguments: { expression: '1+1' } },
        ],
      });
      // 第二次调用返回最终答案
      mockProvider.chat.mockResolvedValueOnce({
        content: '1+1=2',
        toolCalls: undefined,
      });

      mockSkillService.executeSkill.mockResolvedValue({ result: 2 });

      const result = await agentExecutor.execute(singleConfig, '计算1+1');

      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(1);
      expect(result.iterations).toBe(2);
      expect(mockSkillService.executeSkill).toHaveBeenCalledWith(
        'builtin:calculator',
        { expression: '1+1' },
        undefined,
      );

      const secondCallMessages = mockProvider.chat.mock.calls[1][0].messages;
      expect(secondCallMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            toolCalls: [expect.objectContaining({ id: 'call_1', name: 'calculator' })],
          }),
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_1',
            toolName: 'calculator',
          }),
        ]),
      );
    });

    it('should load and execute an explicitly authorized MCP tool', async () => {
      const mcpConfig: AgentNodeConfig = {
        ...singleConfig,
        singleAgent: {
          ...singleConfig.singleAgent!,
          toolIds: ['mcp:server-123:geo_rank_by_distance'],
        },
      };
      mockMcpService.findConnectedTool.mockResolvedValue({
        name: 'geo_rank_by_distance',
        description: '按距离排序候选点',
        inputSchema: {
          type: 'object',
          properties: {
            origin: { type: 'array', items: { type: 'number' } },
          },
          required: ['origin'],
          additionalProperties: false,
        },
      });
      mockProvider.chat
        .mockImplementationOnce(async (params: any) => ({
          content: '',
          toolCalls: [
            {
              id: 'mcp_call_1',
              name: params.tools[0].name,
              arguments: { origin: [116.397, 39.908] },
            },
          ],
        }))
        .mockResolvedValueOnce({ content: '最近候选点已找到', toolCalls: undefined });
      mockMcpService.callTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"returnedCount":1}' }],
      });

      const result = await agentExecutor.execute(mcpConfig, '查找最近候选点', {
        context: { _userId: 'user-1' },
      });

      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(1);
      expect(mockMcpService.findConnectedTool).toHaveBeenCalledWith(
        'user-1',
        'server-123',
        'geo_rank_by_distance',
      );
      expect(result.messages.find((message) => message.role === 'tool')?.content).toBe(
        '{"returnedCount":1}',
      );
      expect(mockMcpService.callTool).toHaveBeenCalledWith(
        'user-1',
        'server-123',
        'geo_rank_by_distance',
        { origin: [116.397, 39.908] },
      );
    });

    it('should stop at max iterations', async () => {
      mockProvider.chat.mockResolvedValue({
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'calculator', arguments: { expression: 'loop' } },
        ],
      });

      const limitedConfig = { ...singleConfig, maxIterations: 3 };
      mockSkillService.executeSkill.mockResolvedValue({ result: 'looping' });

      const result = await agentExecutor.execute(limitedConfig, '无限循环');

      expect(result.iterations).toBe(3);
      expect(result.success).toBe(false);
      expect(result.error).toContain('max iterations');
    });

    it('should produce execution trace', async () => {
      mockProvider.chat.mockResolvedValue({
        content: '答案',
        toolCalls: undefined,
      });

      const result = await agentExecutor.execute(singleConfig, '测试');

      expect(result.trace.length).toBeGreaterThan(0);
      expect(result.trace.some((t: any) => t.type === 'thinking')).toBe(true);
      expect(result.trace.some((t: any) => t.type === 'final_answer')).toBe(true);
    });
  });

  // ============================================================
  // Supervisor Agent
  // ============================================================

  describe('Supervisor Agent', () => {
    const supervisorConfig: AgentNodeConfig = {
      mode: 'supervisor',
      strategy: 'react',
      maxIterations: 15,
      memoryEnabled: false,
      memoryWindowSize: 10,
      supervisor: {
        systemPrompt: '你是协调者',
        model: 'qwen-turbo',
        temperature: 0.7,
        maxIterations: 15,
        workers: [
          {
            id: 'worker_1',
            name: '搜索专家',
            description: '负责搜索信息',
            systemPrompt: '你是搜索专家',
            model: 'qwen-turbo',
            temperature: 0.7,
            maxTokens: 2048,
            toolIds: [],
            knowledgeBaseIds: [],
            ragEnabled: false,
          },
        ],
      },
    };

    it('should delegate to worker and return final answer', async () => {
      // Supervisor 委派给 Worker
      mockProvider.chat.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'delegate_to_worker_1', arguments: { task: '搜索信息' } },
        ],
      });
      // Worker 返回答案
      mockProvider.chat.mockResolvedValueOnce({
        content: '搜索结果: XXX',
        toolCalls: undefined,
      });
      // Supervisor 给出最终答案
      mockProvider.chat.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call_2', name: 'finish', arguments: { answer: '最终答案' } },
        ],
      });

      const result = await agentExecutor.execute(supervisorConfig, '帮我搜索');

      expect(result.success).toBe(true);
      expect(result.result).toBe('最终答案');
    });
  });

  // ============================================================
  // RAG 集成
  // ============================================================

  describe('RAG Integration', () => {
    const ragConfig: AgentNodeConfig = {
      mode: 'single',
      strategy: 'react',
      maxIterations: 10,
      memoryEnabled: false,
      memoryWindowSize: 10,
      singleAgent: {
        id: 'rag_agent',
        name: 'RAG 助手',
        description: '带知识库的助手',
        systemPrompt: '你是知识库助手。',
        model: 'qwen-turbo',
        temperature: 0.7,
        maxTokens: 2048,
        toolIds: [],
        knowledgeBaseIds: ['kb_001'],
        ragEnabled: true,
      },
    };

    it('should enrich context with RAG results', async () => {
      mockRAGService.retrieve.mockResolvedValue([
        {
          id: 'chunk-1',
          content: '知识库内容1',
          documentId: 'doc-1',
          documentName: '规划规范.md',
          chunkIndex: 0,
          similarity: 0.95,
          source: 'hybrid',
          metadata: {},
        },
        {
          id: 'chunk-2',
          content: '知识库内容2',
          documentId: 'doc-1',
          documentName: '规划规范.md',
          chunkIndex: 1,
          similarity: 0.85,
          source: 'hybrid',
          metadata: {},
        },
      ]);

      mockProvider.chat.mockResolvedValue({
        content: '基于知识库的回答',
        toolCalls: undefined,
      });

      const result = await agentExecutor.execute(ragConfig, '查询知识', {
        context: { _userId: 'user-1' },
      });

      expect(result.ragCallCount).toBe(1);
      expect(result.ragResults?.[0].documents[0]).toMatchObject({
        citationId: 'S1',
        documentName: '规划规范.md',
        chunkIndex: 0,
        score: 0.95,
      });
      expect(mockRAGService.retrieve).toHaveBeenCalledWith(
        'user-1',
        '查询知识',
        'kb_001',
        5,
      );
      expect(mockProvider.chat.mock.calls[0][0].messages[0].content).toContain(
        '[S1] 文档: 规划规范.md',
      );
    });

    it('should handle RAG retrieval failure gracefully', async () => {
      mockRAGService.retrieve.mockRejectedValue(new Error('知识库不存在'));

      mockProvider.chat.mockResolvedValue({
        content: '无法获取知识库信息',
        toolCalls: undefined,
      });

      const failConfig = {
        ...ragConfig,
        singleAgent: { ...ragConfig.singleAgent!, knowledgeBaseIds: ['kb_404'] },
      };

      const result = await agentExecutor.execute(failConfig, '查询', {
        context: { _userId: 'user-1' },
      });

      expect(result.success).toBe(true);
      expect(result.ragCallCount).toBe(0);
    });
  });

  // ============================================================
  // 错误处理
  // ============================================================

  describe('Error Handling', () => {
    it('should handle LLM API failure', async () => {
      mockProvider.chat.mockRejectedValue(new Error('API 限流'));

      const config: AgentNodeConfig = {
        mode: 'single',
        strategy: 'react',
        maxIterations: 10,
        memoryEnabled: false,
        memoryWindowSize: 10,
        singleAgent: {
          id: 'err_agent',
          name: '错误助手',
          description: '',
          systemPrompt: '',
          model: 'qwen-turbo',
          temperature: 0.7,
          maxTokens: 2048,
          toolIds: [],
          knowledgeBaseIds: [],
          ragEnabled: false,
        },
      };

      const result = await agentExecutor.execute(config, '触发错误');

      expect(result.success).toBe(false);
      expect(result.error).toContain('API 限流');
    });

    it('should handle tool execution failure', async () => {
      mockProvider.chat.mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'calculator', arguments: { expression: 'bad' } },
        ],
      });

      mockSkillService.executeSkill.mockRejectedValue(new Error('工具执行失败'));

      mockProvider.chat.mockResolvedValueOnce({
        content: '工具调用失败了',
        toolCalls: undefined,
      });

      const config: AgentNodeConfig = {
        mode: 'single',
        strategy: 'react',
        maxIterations: 10,
        memoryEnabled: false,
        memoryWindowSize: 10,
        singleAgent: {
          id: 'tool_err_agent',
          name: '工具错误助手',
          description: '',
          systemPrompt: '',
          model: 'qwen-turbo',
          temperature: 0.7,
          maxTokens: 2048,
          toolIds: ['builtin:calculator'],
          knowledgeBaseIds: [],
          ragEnabled: false,
        },
      };

      const result = await agentExecutor.execute(config, '调用坏工具');

      expect(result.success).toBe(true);
      expect(result.toolCallCount).toBe(1);
    });
  });

  // ============================================================
  // 多模型路由
  // ============================================================

  describe('Multi-Model Routing', () => {
    it('should route to correct provider based on model ID', async () => {
      const openaiProvider = {
        ...mockProvider,
        name: 'openai',
        chat: jest.fn().mockResolvedValue({
          content: 'GPT-4o 回答',
          toolCalls: undefined,
        }),
      };

      mockProviderFactory.getProviderForModel.mockReturnValue(openaiProvider);

      const config: AgentNodeConfig = {
        mode: 'single',
        strategy: 'react',
        maxIterations: 10,
        memoryEnabled: false,
        memoryWindowSize: 10,
        singleAgent: {
          id: 'gpt_agent',
          name: 'GPT 助手',
          description: '',
          systemPrompt: '',
          model: 'gpt-4o',
          temperature: 0.7,
          maxTokens: 2048,
          toolIds: [],
          knowledgeBaseIds: [],
          ragEnabled: false,
        },
      };

      const result = await agentExecutor.execute(config, '你好');

      expect(mockProviderFactory.getProviderForModel).toHaveBeenCalledWith('gpt-4o');
      expect(openaiProvider.chat).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });
});
