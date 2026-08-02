# 知识库导入 — 设计文档

> 日期: 2026-07-31
> 状态: 草稿
> 参考: AstrBot knowledge_base 模块（chunk 512/overlap 50、元数据与向量分离、agentic/非 agentic 双触发）

---

## 1. 背景与决策

### 1.1 为什么做

服务端 QQ 机器人目前只能靠内置工具（搜索/天气/提醒）回答，**无法引用用户自己的文档知识**（设定资料、FAQ、产品手册）。知识库 RAG 是对聊天体验增值最大的服务端增强。

### 1.2 决策：表情包/预设不放知识库

调研 AstrBot 后确认：**知识库是语义检索（向量相似度），表情包/预设需要的是关键词精确触发**。两者匹配模型不同。

| 内容 | 匹配方式 | 存储 | 状态 |
|------|----------|------|------|
| 文档知识 | 语义检索（向量 + LIKE 兜底） | knowledge_docs + knowledge_chunks | 本次实现 |
| 表情包/预设回复 | 关键词精确触发 | Worldbook 扩展（素材字段） | 后续（复用 WorldbookMatcher） |

### 1.3 参考 AstrBot 的取舍

| AstrBot 方案 | 我们的取舍 | 理由 |
|--------------|-----------|------|
| chunk 512/overlap 50 | 同样采用（~500/50） | 中文场景合适 |
| BM25 + FAISS 双路 | 暂用 SQLite LIKE，vectorStore 就绪后加向量 | LanceDB 未部署 |
| 元数据 DB + 向量索引分离 | knowledge_docs（元数据）+ knowledge_chunks（内容） | 表结构分离，向量化时每 chunk 一个向量 |
| 会话级 kb 配置 | 暂用全局知识库 | MVP 简化 |
| agentic 工具触发 | 非 agentic：read() 自动检索注入 | 与现有 MemoryRetrievalStage 集成 |

---

## 2. 数据模型

```sql
-- 新增表：文档块（支持未来逐块向量化）
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          TEXT PRIMARY KEY,      -- chunk_{doc_id}_{index}
  doc_id      TEXT NOT NULL,         -- 关联 knowledge_docs.id
  chunk_index INTEGER NOT NULL,
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON knowledge_chunks(doc_id);
```

`knowledge_docs` 表已有字段（id/title/source/file_path/content_hash/chunk_count/status/created_at/updated_at），不变。

---

## 3. 接口设计

### 3.1 `MemoryManager.importKnowledge()` — 导入入口（Web 端 P1 接口）

```typescript
// core/src/memory/MemoryManager.ts
async importKnowledge(input: {
  title: string;
  content: string;         // 纯文本（PDF/URL 解析后续加）
  source?: 'imported' | 'url' | 'note' | 'generated';
}): Promise<{
  docId: string;
  chunks: number;
  deduplicated: boolean;   // true = hash 已存在，跳过
}>
```

**流程**：
1. `content_hash = sha256(title + content)`
2. `knowledgeStore.getByHash()` 去重 → 已存在返回 `deduplicated: true`
3. 分块：~500 字符/块，overlap 50（中文按字符切，避免切碎句子）
4. 插入 `knowledge_docs`（chunk_count = 块数）
5. 每块插入 `knowledge_chunks`
6. 若 vectorStore 可用 → 逐块嵌入 + 存向量（当前 null，跳过）

### 3.2 KnowledgeStore 新增

```typescript
insertChunk(chunk: { id: string; doc_id: string; chunk_index: number; content: string }): void;
getChunksByDoc(docId: string): Array<{ chunk_index: number; content: string }>;
/** 全文检索：搜 chunk 内容（替代原来只搜标题） */
searchChunksByText(query: string, limit: number): SearchResult[];
```

### 3.3 检索升级

`MemoryManager.read()` 的 fallback 路径（无向量时）：
```
原来: knowledgeStore.searchByText(query)      // 只搜标题，几乎搜不到
现在: knowledgeStore.searchChunksByText(query) // 搜 chunk 全文，真正的文本检索
```

返回 `SearchResult`：`text = [标题] chunk 内容`，metadata 带 docId。

### 3.4 管理接口（后续 Web 用）

| 方法 | 用途 |
|------|------|
| `listKnowledgeDocs()` | 文档列表（Web 展示） |
| `archiveKnowledgeDoc(docId)` | 归档（删除入口） |
| `deleteKnowledgeDoc(docId)` | 彻底删除 + 删 chunks |

---

## 4. 分块算法

```typescript
function chunkText(text: string, size = 500, overlap = 50): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - overlap;
  }
  return chunks;
}
```

---

## 5. 实施计划

- [ ] 5.1 `database.ts` 新增 `knowledge_chunks` 表 + 索引
- [ ] 5.2 `KnowledgeStore` 新增 insertChunk / getChunksByDoc / searchChunksByText
- [ ] 5.3 `MemoryManager.importKnowledge()` + 管理接口（list/archive/delete）
- [ ] 5.4 `read()` fallback 升级为 searchChunksByText
- [ ] 5.5 测试：分块正确性、导入去重、检索命中
- [ ] 5.6 更新 Web 档案（`POST /api/knowledge/import` 标 🟢）
- [ ] 5.7 rebuild + 手动验证：导入一段文档 → 让昔涟回答文档内容

---

## 6. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-07-31 | 初始设计。参考 AstrBot：chunk 方案、元数据/内容分离、决策表情包不走知识库 |
