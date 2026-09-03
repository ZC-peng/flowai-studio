import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RunAgentEvaluationDto } from '../dto/run-agent-evaluation.dto';
import { AgentEvaluatorService } from '../evaluation/agent-evaluator.service';
import { AgentExecutorService } from '../services/agent-executor.service';

@Controller('agent/evaluations')
@UseGuards(JwtAuthGuard)
export class AgentEvaluationController {
  constructor(
    private readonly agentExecutor: AgentExecutorService,
    private readonly evaluator: AgentEvaluatorService,
  ) {}

  /**
   * 顺序执行固定评测集，避免并发请求放大模型限流。
   * 工具、MCP 与知识库仍由 AgentExecutor 按当前用户做权限校验。
   */
  @Post('run')
  async run(
    @CurrentUser('userId') userId: string,
    @Body() dto: RunAgentEvaluationDto,
  ) {
    const observations = [];
    for (const evaluationCase of dto.cases) {
      const result = await this.agentExecutor.execute(
        dto.config,
        evaluationCase.input,
        {
          context: { _userId: userId },
          maxIterations: Math.min(dto.config.maxIterations || 10, 15),
        },
      );
      observations.push({ caseId: evaluationCase.id, ...result });
    }

    return this.evaluator.evaluate(dto.cases, observations);
  }
}
