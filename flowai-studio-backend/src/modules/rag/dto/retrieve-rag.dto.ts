import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class RetrieveRagDto {
  @IsString({ message: 'Query must be a string' })
  query: string;

  @IsString({ message: 'Knowledge base ID must be a string' })
  knowledgeBaseId: string;

  @IsOptional()
  @IsNumber({}, { message: 'TopK must be a number' })
  @Min(1, { message: 'TopK must be at least 1' })
  @Max(20, { message: 'TopK must not exceed 20' })
  topK?: number;

  @IsOptional()
  @IsIn(['vector', 'keyword', 'hybrid'], {
    message: 'Retrieval mode must be vector, keyword, or hybrid',
  })
  retrievalMode?: 'vector' | 'keyword' | 'hybrid';

  @IsOptional()
  @IsNumber({}, { message: 'Vector weight must be a number' })
  @Min(0, { message: 'Vector weight must be at least 0' })
  @Max(1, { message: 'Vector weight must not exceed 1' })
  vectorWeight?: number;

  @IsOptional()
  @IsNumber({}, { message: 'RRF K must be a number' })
  @Min(1, { message: 'RRF K must be at least 1' })
  @Max(200, { message: 'RRF K must not exceed 200' })
  rrfK?: number;
}
