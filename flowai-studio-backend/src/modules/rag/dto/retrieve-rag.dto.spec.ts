import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RetrieveRagDto } from './retrieve-rag.dto';

describe('RetrieveRagDto', () => {
  const validateInput = (input: Record<string, unknown>) =>
    validate(plainToInstance(RetrieveRagDto, input), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('accepts a valid hybrid retrieval request', async () => {
    const errors = await validateInput({
      query: '候选点距离排序',
      knowledgeBaseId: 'kb_1',
      topK: 3,
      retrievalMode: 'hybrid',
      vectorWeight: 0.6,
      rrfK: 60,
    });

    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown mode field instead of silently using a default', async () => {
    const errors = await validateInput({
      query: '候选点距离排序',
      knowledgeBaseId: 'kb_1',
      mode: 'vector',
    });

    expect(errors.some((error) => error.property === 'mode')).toBe(true);
  });

  it('rejects out-of-range retrieval parameters', async () => {
    const errors = await validateInput({
      query: '候选点距离排序',
      knowledgeBaseId: 'kb_1',
      topK: 100,
      retrievalMode: 'invalid',
      vectorWeight: 1.2,
      rrfK: 0,
    });

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['topK', 'retrievalMode', 'vectorWeight', 'rrfK']),
    );
  });
});
