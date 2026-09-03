import { AgentEvaluatorService } from './agent-evaluator.service';

describe('AgentEvaluatorService', () => {
  const service = new AgentEvaluatorService();

  it('calculates deterministic tool, citation, latency and token metrics', () => {
    const report = service.evaluate(
      [
        {
          id: 'school-site-selection',
          input: '筛选学校候选点',
          expectedTools: ['geo_points_within_polygon', 'geo_rank_by_distance'],
          requiredOutputKeywords: ['候选点'],
          citationRequired: true,
          maxLatencyMs: 5000,
        },
      ],
      [
        {
          caseId: 'school-site-selection',
          result: '候选点 A 排名第一 [S1]',
          toolResults: [],
          messages: [],
          trace: [
            {
              type: 'tool_call',
              content: 'call',
              timestamp: 1,
              data: { toolName: 'geo_points_within_polygon' },
            },
            {
              type: 'tool_call',
              content: 'call',
              timestamp: 2,
              data: { toolName: 'geo_rank_by_distance' },
            },
          ],
          toolCallCount: 2,
          ragCallCount: 1,
          ragResults: [
            {
              knowledgeBaseId: 'kb-1',
              documents: [
                {
                  citationId: 'S1',
                  documentId: 'doc-1',
                  documentName: '规范.md',
                  chunkIndex: 0,
                  content: '规范内容',
                  score: 0.9,
                  source: 'hybrid',
                },
              ],
            },
          ],
          iterations: 2,
          tokenUsage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 },
          duration: 1200,
          success: true,
        },
      ],
    );

    expect(report).toMatchObject({
      caseCount: 1,
      observedCaseCount: 1,
      taskCompletionRate: 1,
      toolSelectionAccuracy: 1,
      toolExecutionPassRate: 1,
      outputKeywordPassRate: 1,
      citationPassRate: 1,
      latencyPassRate: 1,
      averageLatencyMs: 1200,
      totalTokens: 100,
      averageTokens: 100,
    });
  });

  it('marks a missing observation as an evaluation failure', () => {
    const report = service.evaluate(
      [{ id: 'case-1', input: 'test', expectedTools: [] }],
      [],
    );

    expect(report.observedCaseCount).toBe(0);
    expect(report.taskCompletionRate).toBe(0);
    expect(report.toolSelectionAccuracy).toBe(0);
    expect(report.cases[0].missingObservation).toBe(true);
  });

  it('rejects duplicate case ids', () => {
    expect(() =>
      service.evaluate(
        [
          { id: 'duplicate', input: 'a' },
          { id: 'duplicate', input: 'b' },
        ],
        [],
      ),
    ).toThrow('Duplicate evaluation case id');
  });
});
