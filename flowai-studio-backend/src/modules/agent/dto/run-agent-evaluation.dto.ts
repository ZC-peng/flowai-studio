import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AgentNodeConfig } from '../interfaces/agent.interface';

export class AgentEvaluationCaseDto {
  @IsString()
  id: string;

  @IsString()
  input: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  expectedTools?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  requiredOutputKeywords?: string[];

  @IsOptional()
  @IsBoolean()
  citationRequired?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(300000)
  maxLatencyMs?: number;
}

export class RunAgentEvaluationDto {
  @IsObject()
  config: AgentNodeConfig;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AgentEvaluationCaseDto)
  cases: AgentEvaluationCaseDto[];
}
