/**
 * Agent 模块
 *
 * 提供:
 * - AgentExecutorService: Agent 执行引擎
 * - LLMProviderFactory: 多模型 Provider 工厂
 * - LLMModelService: 模型管理服务
 * - LLMModelController: 模型管理 API
 * - TokenUsageService: Token 使用量统计 + 成本报表
 * - TokenUsageController: 成本统计 API
 */
import { Module } from '@nestjs/common';
import { AgentExecutorService } from './services/agent-executor.service';
import { LLMModelService } from './services/llm-model.service';
import { TokenUsageService } from './services/token-usage.service';
import { AgentEvaluatorService } from './evaluation/agent-evaluator.service';
import { LLMProviderFactory } from './providers/llm-provider.factory';
import { LLMModelController } from './controllers/llm-model.controller';
import { TokenUsageController } from './controllers/token-usage.controller';
import { AgentEvaluationController } from './controllers/agent-evaluation.controller';
import { SkillModule } from '../skill/skill.module';
import { RAGModule } from '../rag/rag.module';
import { PrismaModule } from '../../common/modules/prisma.module';
import { McpModule } from '../mcp/mcp.module';

@Module({
  imports: [SkillModule, RAGModule, PrismaModule, McpModule],
  controllers: [LLMModelController, TokenUsageController, AgentEvaluationController],
  providers: [
    AgentExecutorService,
    LLMModelService,
    LLMProviderFactory,
    TokenUsageService,
    AgentEvaluatorService,
  ],
  exports: [
    AgentExecutorService,
    LLMModelService,
    LLMProviderFactory,
    TokenUsageService,
    AgentEvaluatorService,
  ],
})
export class AgentModule {}
