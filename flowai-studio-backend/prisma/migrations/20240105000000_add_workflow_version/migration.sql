-- Phase 4.2: 工作流版本管理
-- 添加 WorkflowVersion 表用于版本快照、回滚、差异对比

-- 添加工作流当前版本号字段
ALTER TABLE "workflows" ADD COLUMN "currentVersion" INTEGER NOT NULL DEFAULT 1;

-- 创建版本快照表
CREATE TABLE "workflow_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflowId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "description" TEXT,
    "nodes" TEXT NOT NULL DEFAULT '[]',
    "edges" TEXT NOT NULL DEFAULT '[]',
    "variables" TEXT,
    "createdBy" TEXT,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workflow_versions_pkey" PRIMARY KEY ("id")
);

-- 唯一约束：同一工作流内版本号唯一
CREATE UNIQUE INDEX "workflow_versions_workflowId_version_key" ON "workflow_versions"("workflowId", "version");

-- 外键约束
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 索引：按工作流查版本列表
CREATE INDEX "workflow_versions_workflowId_idx" ON "workflow_versions"("workflowId");
