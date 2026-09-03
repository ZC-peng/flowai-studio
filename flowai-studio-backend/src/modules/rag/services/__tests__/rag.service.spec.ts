import { BadRequestException } from '@nestjs/common';
import { RAGService } from '../rag.service';

describe('RAGService retrieval contract', () => {
  const createService = (overrides: Record<string, any> = {}) => {
    const prisma = {
      knowledgeBase: {
        findUnique: jest.fn(),
      },
      document: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'doc-1', name: '城市规划规范.md' },
        ]),
      },
      ...overrides.prisma,
    };
    const cacheService = {
      getOrSet: jest.fn().mockResolvedValue({
        id: 'kb-1',
        userId: 'owner-1',
        retrievalMode: 'keyword',
        topK: 5,
        vectorWeight: 0.7,
        rrfK: 60,
        similarityThreshold: 0,
        rerankerEnabled: false,
      }),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      ...overrides.cacheService,
    };
    const bm25Service = {
      search: jest.fn().mockResolvedValue([
        {
          id: 'chunk-1',
          content: '学校选址应满足服务半径要求。',
          score: 0.82,
          metadata: { documentId: 'doc-1', chunkIndex: 3 },
        },
      ]),
      ...overrides.bm25Service,
    };

    const service = new RAGService(
      prisma as any,
      {} as any,
      {} as any,
      bm25Service as any,
      {} as any,
      { create: jest.fn() } as any,
      cacheService as any,
    );

    return { service, prisma, cacheService, bm25Service };
  };

  it('rejects retrieval before search when the knowledge base belongs to another user', async () => {
    const { service, cacheService, bm25Service } = createService();

    await expect(
      service.retrieve('attacker', '学校选址', 'kb-1', 5),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(cacheService.get).not.toHaveBeenCalled();
    expect(bm25Service.search).not.toHaveBeenCalled();
  });

  it('returns a stable citation contract for keyword retrieval', async () => {
    const { service, cacheService } = createService();

    const results = await service.retrieve(
      'owner-1',
      '学校选址',
      'kb-1',
      5,
      'keyword',
    );

    expect(results).toEqual([
      expect.objectContaining({
        id: 'chunk-1',
        documentId: 'doc-1',
        documentName: '城市规划规范.md',
        chunkIndex: 3,
        similarity: 0.82,
        source: 'keyword',
      }),
    ]);
    expect(cacheService.set).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty query', async () => {
    const { service, cacheService } = createService();

    await expect(service.retrieve('owner-1', '   ', 'kb-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(cacheService.getOrSet).not.toHaveBeenCalled();
  });
});
