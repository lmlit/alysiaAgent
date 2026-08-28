# Tasks: persona-overlay-perspective

- [x] T1 database.ts:persona 加 overlay_notes 列(ALTER + try-catch)
- [x] T2 PersonaStore:overlay 读写(appendOverlayNote/listOverlayNotes)
- [x] T3 PersonaAdapter:同向 ≥3 次 → 固化 overlay 备注;regressIfStale 跳过已固化参数
- [x] T4 PromptAssembler:注入【你的稳定变化】块
- [x] T5 getPersonaSnapshot 加 overlayNotes;测试:固化/注入/回归豁免

## Apply
- [x] 合并 spec + index + Web-API + 测试 + 归档
