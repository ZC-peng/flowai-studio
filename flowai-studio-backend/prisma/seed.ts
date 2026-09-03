import { Prisma, PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log(`Start seeding ...`);

  const allowDemoSeed = process.env.ALLOW_DEMO_SEED === 'true';
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  if (!allowDemoSeed) {
    console.log(
      'Demo seed skipped. Set ALLOW_DEMO_SEED=true in a local development environment to enable it.',
    );
    return;
  }

  if (nodeEnv === 'production') {
    throw new Error('Demo seed is disabled when NODE_ENV=production.');
  }

  const seedAdminUsername = process.env.SEED_ADMIN_USERNAME?.trim() || 'admin';
  const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!seedAdminPassword || seedAdminPassword.length < 12) {
    throw new Error(
      'SEED_ADMIN_PASSWORD must be set to at least 12 characters before demo seeding.',
    );
  }

  // 0. 确保 pgvector 扩展已启用
  try {
    await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector;`);
    console.log('✅ pgvector extension enabled');
  } catch (error) {
    console.warn('⚠️  pgvector extension could not be enabled:', error instanceof Error ? error.message : error);
  }

  // 1. 创建或更新仅用于本地演示的用户
  const hashedPassword = await bcrypt.hash(seedAdminPassword, 10);
  const adminUser = await prisma.user.upsert({
    where: { username: seedAdminUsername },
    update: { password: hashedPassword },
    create: {
      username: seedAdminUsername,
      password: hashedPassword,
    },
  });
  console.log(`✅ Created or found user: ${adminUser.username}`);

  // 2. 创建或更新默认知识库
  const defaultKb = await prisma.knowledgeBase.upsert({
    where: { name_userId: { name: '默认知识库', userId: adminUser.id } },
    update: {},
    create: {
      name: '默认知识库',
      description: '系统自动创建的默认知识库，包含 FlowAI Studio 的功能介绍。',
      embeddingModel: 'text-embedding-v3',
      embeddingDimension: 1024,
      chunkSize: 500,
      chunkOverlap: 50,
      retrievalMode: 'vector',
      userId: adminUser.id,
    },
  });
  console.log(`✅ Created or found knowledge base: ${defaultKb.name}`);

  // 3. 为默认知识库创建一篇文档
  const docContent = `
FlowAI Studio 是一个面向空间分析场景的可视化 AI 工作流项目。它通过可编辑的 DAG 组织输入、模型、检索、工具、Agent 与输出节点，并将确定性的空间计算结果以 GeoJSON 形式交给地图展示。

核心特性包括：
- 可视化工作流编排：基于 React Flow 构建，支持节点拖拽、连线、配置、保存和运行状态展示。
- 串行 DAG 执行：由 NestJS Runtime 完成图校验、依赖调度、条件分支、重试、超时和取消。
- 受控 Tool Agent：Single ReAct Agent 通过模型 Function Calling 选择已授权工具，工具参数在运行前校验。
- Hybrid RAG：支持文档解析、切分、向量检索、关键词检索和加权 RRF 融合。
- GIS 工具与地图展示：使用 Turf.js 执行空间计算，并将结构化 GeoJSON 结果交给 Cesium 展示。

当前边界：工作流 SSE 传输的是节点状态和执行事件，不是模型 Token 流；Memory、Plan-and-Execute 和 Reflection 尚未接入完整执行链路；MCP 工具已进入 Agent 授权调用链，但当前只支持可信本地 stdio transport。

技术栈：
- 前端: React 18 + Vite + Zustand + Ant Design + React Flow
- 后端: NestJS + PostgreSQL + pgvector + Prisma ORM
- 向量存储: pgvector (PostgreSQL 原生向量扩展)
- AI: 通义千问 API (Qwen)
  `;
  const docName = 'FlowAI Studio 功能介绍.md';

  const document = await prisma.document.upsert({
    where: { name_knowledgeBaseId: { name: docName, knowledgeBaseId: defaultKb.id } },
    update: {
      content: docContent,
      size: Buffer.from(docContent).length,
    },
    create: {
      name: docName,
      content: docContent,
      knowledgeBaseId: defaultKb.id,
      size: Buffer.from(docContent).length,
    },
  });

  // 删除旧分块并创建新分块（使用 raw query 插入 vector 类型）
  await prisma.documentChunk.deleteMany({
    where: { documentId: document.id },
  });

  // 分块
  const chunkSize = 500;
  const overlap = 50;
  const chunks: string[] = [];
  let start = 0;
  while (start < docContent.length) {
    const end = Math.min(start + chunkSize, docContent.length);
    chunks.push(docContent.substring(start, end));
    start += chunkSize - overlap;
  }

  // 使用 raw query 插入带 vector 类型的分块
  // seed 时使用空向量，实际运行时会通过 RAG 服务重新生成
  for (let i = 0; i < chunks.length; i++) {
    const zeroVector = Array(1024).fill(0);
    const vectorStr = `[${zeroVector.join(',')}]`;

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO document_chunks
        (content, embedding, "chunkIndex", "startIndex", "endIndex", "documentId", "createdAt")
      VALUES (
        ${chunks[i]},
        CAST(${vectorStr} AS vector),
        ${i},
        0,
        ${chunks[i].length},
        ${document.id}::uuid,
        NOW()
      )
    `);
  }
  console.log(`✅ Created ${chunks.length} chunks for default document`);

  // 4. 创建演示应用和工作流
  const demoAppName = '默认RAG演示应用';
  let demoApp = await prisma.application.findFirst({
    where: {
      name: demoAppName,
      userId: adminUser.id,
    },
  });

  if (!demoApp) {
    demoApp = await prisma.application.create({
      data: {
        name: demoAppName,
        description: '内置示例应用，可直接用于验证默认知识库与 RAG 工作流。',
        status: 'published',
        userId: adminUser.id,
      },
    });
  } else {
    demoApp = await prisma.application.update({
      where: { id: demoApp.id },
      data: {
        description: '内置示例应用，可直接用于验证默认知识库与 RAG 工作流。',
        status: 'published',
      },
    });
  }
  console.log(`✅ Created or updated demo application: ${demoApp.name}`);

  const demoWorkflowName = '默认RAG工作流';
  const demoNodes = [
    {
      id: 'start_demo',
      type: 'start',
      position: { x: 80, y: 180 },
      data: {
        label: '开始',
        variables: [
          {
            key: 'question',
            value: 'FlowAI Studio 有什么核心特性？',
          },
        ],
      },
    },
    {
      id: 'rag_demo',
      type: 'rag',
      position: { x: 340, y: 180 },
      data: {
        label: 'RAG检索',
        knowledgeBaseId: defaultKb.id,
        query: '{{question}}',
        topK: 3,
        similarityThreshold: 0.7,
      },
    },
    {
      id: 'output_demo',
      type: 'output',
      position: { x: 620, y: 180 },
      data: {
        label: '输出',
        outputValue: '{{rag_demo.documents}}',
      },
    },
  ];

  const demoEdges = [
    {
      id: 'edge_start_rag',
      source: 'start_demo',
      target: 'rag_demo',
    },
    {
      id: 'edge_rag_output',
      source: 'rag_demo',
      target: 'output_demo',
    },
  ];

  const existingWorkflow = await prisma.workflow.findFirst({
    where: {
      name: demoWorkflowName,
      applicationId: demoApp.id,
    },
  });

  if (!existingWorkflow) {
    await prisma.workflow.create({
      data: {
        name: demoWorkflowName,
        description: '内置示例工作流：开始 → RAG检索 → 输出',
        applicationId: demoApp.id,
        nodes: JSON.stringify(demoNodes),
        edges: JSON.stringify(demoEdges),
      },
    });
  } else {
    await prisma.workflow.update({
      where: { id: existingWorkflow.id },
      data: {
        description: '内置示例工作流：开始 → RAG检索 → 输出',
        nodes: JSON.stringify(demoNodes),
        edges: JSON.stringify(demoEdges),
      },
    });
  }
  console.log(`✅ Created or updated demo workflow: ${demoWorkflowName}`);

  // 5. 创建 GIS 单 Agent + Cesium 演示应用，保证重建数据库后仍可复现。
  const gisDemoAppName = '城市公共服务设施选址 Agent';
  let gisDemoApp = await prisma.application.findFirst({
    where: {
      name: gisDemoAppName,
      userId: adminUser.id,
    },
  });

  if (!gisDemoApp) {
    gisDemoApp = await prisma.application.create({
      data: {
        name: gisDemoAppName,
        description: '单 Agent 调用 GIS 距离排序工具，并在 Cesium 中展示候选点。',
        status: 'published',
        icon: 'environment',
        userId: adminUser.id,
      },
    });
  } else {
    gisDemoApp = await prisma.application.update({
      where: { id: gisDemoApp.id },
      data: {
        description: '单 Agent 调用 GIS 距离排序工具，并在 Cesium 中展示候选点。',
        status: 'published',
        icon: 'environment',
      },
    });
  }

  const gisCandidates = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'site-a',
        properties: { name: '候选点 A', category: '社区服务中心' },
        geometry: { type: 'Point', coordinates: [116.401, 39.909] },
      },
      {
        type: 'Feature',
        id: 'site-b',
        properties: { name: '候选点 B', category: '社区服务中心' },
        geometry: { type: 'Point', coordinates: [116.43, 39.92] },
      },
      {
        type: 'Feature',
        id: 'site-c',
        properties: { name: '候选点 C', category: '社区服务中心' },
        geometry: { type: 'Point', coordinates: [116.405, 39.915] },
      },
    ],
  };
  const gisAgentPrompt =
    '必须调用 geo_rank_by_distance 工具，计算候选点到目标点 [116.397,39.908] 的球面距离，' +
    '按从近到远返回前 3 个，不要自行估算。工具参数使用 kilometers。候选点 GeoJSON：' +
    `${JSON.stringify(gisCandidates)}。工具完成后，用中文按距离从近到远说明结果。`;
  const gisDemoWorkflowName = 'GIS Agent 候选点距离排序';
  const gisDemoNodes = [
    {
      id: 'start-gis-demo',
      type: 'start',
      position: { x: 80, y: 180 },
      data: { label: '开始', variables: [] },
    },
    {
      id: 'gis-agent',
      type: 'agent',
      position: { x: 360, y: 150 },
      data: {
        label: 'GIS 选址 Agent',
        description: '调用 GIS 工具完成候选点距离排序',
        agentMode: 'single',
        strategy: 'react',
        model: 'qwen-turbo',
        systemPrompt:
          '你是 GIS 选址分析助手。必须优先使用获得授权的空间分析工具，以工具返回结果为准，禁止自行编造距离。',
        userPrompt: gisAgentPrompt,
        temperature: 0,
        maxTokens: 768,
        maxIterations: 4,
        toolIds: ['builtin:geo_rank_by_distance'],
        knowledgeBaseIds: [],
        ragEnabled: false,
        memoryEnabled: false,
        memoryWindowSize: 5,
      },
    },
    {
      id: 'output-gis-demo',
      type: 'output',
      position: { x: 720, y: 180 },
      data: { label: '输出选址结论', outputValue: '{{gis-agent.result}}' },
    },
  ];
  const gisDemoEdges = [
    {
      id: 'edge-start-agent',
      source: 'start-gis-demo',
      target: 'gis-agent',
      type: 'smoothstep',
    },
    {
      id: 'edge-agent-output',
      source: 'gis-agent',
      target: 'output-gis-demo',
      type: 'smoothstep',
    },
  ];
  const existingGisWorkflow = await prisma.workflow.findFirst({
    where: {
      name: gisDemoWorkflowName,
      applicationId: gisDemoApp.id,
    },
  });

  if (!existingGisWorkflow) {
    await prisma.workflow.create({
      data: {
        name: gisDemoWorkflowName,
        description: '真实 Function Calling + GIS 工具结果 + Cesium 地图展示',
        applicationId: gisDemoApp.id,
        nodes: JSON.stringify(gisDemoNodes),
        edges: JSON.stringify(gisDemoEdges),
      },
    });
  } else {
    await prisma.workflow.update({
      where: { id: existingGisWorkflow.id },
      data: {
        description: '真实 Function Calling + GIS 工具结果 + Cesium 地图展示',
        nodes: JSON.stringify(gisDemoNodes),
        edges: JSON.stringify(gisDemoEdges),
      },
    });
  }
  console.log(`✅ Created or updated GIS Agent demo: ${gisDemoWorkflowName}`);

  console.log(`Seeding finished.`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
