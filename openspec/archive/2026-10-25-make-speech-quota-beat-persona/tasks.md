# Tasks: make-speech-quota-beat-persona

## 实现
- [x] `persona/soul.md` 语气段改**配额制**（三样合计最多一处）+ 记录 5 条实测数据
- [x] `prompts/chat.ts`：加**优先级声明**（本条优先于人设里的语气描述）
- [x] `prompts/chat.ts`：加「不要复述他说过的话」（真实案例：牛肉丸加个蛋…）

## 测试
- [x] characterization 快照按**有意行为变更**更新；已核对 diff：只多新条目，**丢弃集合未变**
- [x] `talk-style`(6) / `speech-rules-reachable`(6) 仍绿
- [x] 全量 **165 文件 / 1941 用例**

## 部署与验收
- [x] 离线构建 → `deploy.mjs --skip-build`（镜像 7d0e600dabdf，`rollback-20261025-141232`）
- [x] 验收①：compact 7058 字，含「三样合计」「调味料」，「句尾常带」已删
- [x] 验收②：组装 context 3697 字，含「优先于」「合计最多一处」「不要复述他说过的话」
- [ ] 验收③：**下一次真实对话**看四条指标（平均字数 / 语气词起头 / 问号 / 语气词密度）
- [x] 归档到 `openspec/archive/2026-10-25-make-speech-quota-beat-persona/`

## 明确不做
- ❌ 不再往代码侧加语气禁令（冲突在人格端，加这头等于往输的一边加人）
- ❌ 不删「♪」（它不是问题，没有配额才是）