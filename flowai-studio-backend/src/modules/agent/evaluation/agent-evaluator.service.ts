import { Injectable } from '@nestjs/common';
import { AgentExecutionResult } from '../interfaces/agent.interface';

export interface AgentEvaluationCase {
  id: string;
  input: string;
  expectedTools?: string[];
  requiredOutputKeywords?: string[];
  citationRequired?: boolean;
  maxLatencyMs?: number;
}

export interface AgentEvaluationObservation extends AgentExecutionResult {
  caseId: string;
}

export interface AgentEvaluationCaseResult {
  caseId: string;
  completed: boolean;
  toolSelectionScore: number | null;
  toolExecutionPassed: boolean | null;
  outputKeywordPassed: boolean | null;
  citationPassed: boolean | null;
  latencyPassed: boolean | null;
  durationMs: number | null;
  totalTokens: number | null;
  selectedTools: string[];
  missingObservation: boolean;
  iterations: number | null;
  toolCallCount: number | null;
  ragCallCount: number | null;
  error?: string;
  outputPreview?: string;
  steps: Array<{ type: string; content: string }>;
}

export interface AgentEvaluationReport {
  generatedAt: string;
  caseCount: number;
  observedCaseCount: number;
  taskCompletionRate: number;
  toolSelectionAccuracy: number | null;
  toolExecutionPassRate: number | null;
  outputKeywordPassRate: number | null;
  citationPassRate: number | null;
  latencyPassRate: number | null;
  averageLatencyMs: number | null;
  totalTokens: number;
  averageTokens: number | null;
  cases: AgentEvaluationCaseResult[];
}

/**
 * 对真实 AgentExecutionResult 做确定性离线评测。
 *
 * 本服务不调用模型，也不使用另一个 LLM 充当裁判，先提供面试中容易解释、
 * 可以稳定回归的任务完成率、工具选择、引用、时延与 Token 指标。
 */
@Injectable()
export class AgentEvaluatorService {
  evaluate(
    cases: AgentEvaluationCase[],
    observations: AgentEvaluationObservation[],
  ): AgentEvaluationReport {
    this.validateCases(cases);
    const observationByCase = new Map(
      observations.map((observation) => [observation.caseId, observation]),
    );
    const caseResults = cases.map((evaluationCase) =>
      this.evaluateCase(evaluationCase, observationByCase.get(evaluationCase.id)),
    );
    const observed = caseResults.filter((result) => !result.missingObservation);

    return {
      generatedAt: new Date().toISOString(),
      caseCount: cases.length,
      observedCaseCount: observed.length,
      taskCompletionRate: this.rate(caseResults.map((result) => result.completed)),
      toolSelectionAccuracy: this.averageNullable(
        caseResults.map((result) => result.toolSelectionScore),
      ),
      toolExecutionPassRate: this.rateNullable(
        caseResults.map((result) => result.toolExecutionPassed),
      ),
      outputKeywordPassRate: this.rateNullable(
        caseResults.map((result) => result.outputKeywordPassed),
      ),
      citationPassRate: this.rateNullable(
        caseResults.map((result) => result.citationPassed),
      ),
      latencyPassRate: this.rateNullable(
        caseResults.map((result) => result.latencyPassed),
      ),
      averageLatencyMs: this.averageNullable(
        observed.map((result) => result.durationMs),
      ),
      totalTokens: observed.reduce(
        (sum, result) => sum + (result.totalTokens || 0),
        0,
      ),
      averageTokens: this.averageNullable(
        observed.map((result) => result.totalTokens),
      ),
      cases: caseResults,
    };
  }

  private evaluateCase(
    evaluationCase: AgentEvaluationCase,
    observation?: AgentEvaluationObservation,
  ): AgentEvaluationCaseResult {
    if (!observation) {
      return {
        caseId: evaluationCase.id,
        completed: false,
        toolSelectionScore: evaluationCase.expectedTools !== undefined ? 0 : null,
        toolExecutionPassed: evaluationCase.expectedTools !== undefined ? false : null,
        outputKeywordPassed:
          evaluationCase.requiredOutputKeywords !== undefined ? false : null,
        citationPassed: evaluationCase.citationRequired ? false : null,
        latencyPassed: evaluationCase.maxLatencyMs !== undefined ? false : null,
        durationMs: null,
        totalTokens: null,
        selectedTools: [],
        missingObservation: true,
        iterations: null,
        toolCallCount: null,
        ragCallCount: null,
        steps: [],
      };
    }

    const selectedTools = [
      ...new Set(
        observation.trace
          .filter((entry) => entry.type === 'tool_call')
          .map((entry) => String(entry.data?.toolName || ''))
          .filter(Boolean),
      ),
    ];
    const expectedTools = evaluationCase.expectedTools;
    const requiredKeywords = evaluationCase.requiredOutputKeywords;
    const toolCalls = observation.trace.filter((entry) => entry.type === 'tool_call');
    const toolExecutionPassed =
      toolCalls.length === 0
        ? expectedTools === undefined || expectedTools.length === 0
        : toolCalls.every((entry) => entry.data?.result !== '失败');

    return {
      caseId: evaluationCase.id,
      completed: Boolean(observation.success) && toolExecutionPassed,
      toolSelectionScore:
        expectedTools === undefined
          ? null
          : this.f1Score(new Set(expectedTools), new Set(selectedTools)),
      toolExecutionPassed:
        expectedTools === undefined && toolCalls.length === 0
          ? null
          : toolExecutionPassed,
      outputKeywordPassed:
        requiredKeywords === undefined
          ? null
          : requiredKeywords.every((keyword) =>
              observation.result.toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
            ),
      citationPassed: evaluationCase.citationRequired
        ? this.hasValidCitation(observation)
        : null,
      latencyPassed:
        evaluationCase.maxLatencyMs === undefined
          ? null
          : observation.duration <= evaluationCase.maxLatencyMs,
      durationMs: observation.duration,
      totalTokens: observation.tokenUsage?.totalTokens ?? null,
      selectedTools,
      missingObservation: false,
      iterations: observation.iterations,
      toolCallCount: observation.toolCallCount,
      ragCallCount: observation.ragCallCount,
      error: observation.error,
      outputPreview: observation.result.slice(0, 300),
      steps: observation.trace.slice(0, 50).map((entry) => ({
        type: entry.type,
        content: entry.content.slice(0, 300),
      })),
    };
  }

  private hasValidCitation(observation: AgentEvaluationObservation): boolean {
    const citationIds = new Set(
      (observation.ragResults || []).flatMap((result) =>
        result.documents.map((document) => document.citationId),
      ),
    );
    const referenced = [...observation.result.matchAll(/\[(S\d+)\]/g)].map(
      (match) => match[1],
    );
    return referenced.length > 0 && referenced.every((id) => citationIds.has(id));
  }

  private f1Score(expected: Set<string>, actual: Set<string>): number {
    if (expected.size === 0 && actual.size === 0) return 1;
    if (expected.size === 0 || actual.size === 0) return 0;
    const truePositives = [...actual].filter((tool) => expected.has(tool)).length;
    if (truePositives === 0) return 0;
    const precision = truePositives / actual.size;
    const recall = truePositives / expected.size;
    return (2 * precision * recall) / (precision + recall);
  }

  private rate(values: boolean[]): number {
    return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
  }

  private rateNullable(values: Array<boolean | null>): number | null {
    const present = values.filter((value): value is boolean => value !== null);
    return present.length === 0 ? null : this.rate(present);
  }

  private averageNullable(values: Array<number | null>): number | null {
    const present = values.filter((value): value is number => value !== null);
    return present.length === 0
      ? null
      : present.reduce((sum, value) => sum + value, 0) / present.length;
  }

  private validateCases(cases: AgentEvaluationCase[]): void {
    if (cases.length === 0) {
      throw new Error('Evaluation dataset must contain at least one case');
    }
    const ids = new Set<string>();
    for (const evaluationCase of cases) {
      if (!evaluationCase.id?.trim() || !evaluationCase.input?.trim()) {
        throw new Error('Every evaluation case requires a non-empty id and input');
      }
      if (ids.has(evaluationCase.id)) {
        throw new Error(`Duplicate evaluation case id: ${evaluationCase.id}`);
      }
      ids.add(evaluationCase.id);
    }
  }
}
