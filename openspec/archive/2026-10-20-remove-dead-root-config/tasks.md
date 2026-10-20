# Tasks: remove-dead-root-config

- [x] 确认 `git ls-files config.yml` 无输出 —— **它从未被跟踪**
      （`.gitignore` 的 `config.yml` 模式无斜杠 ⇒ 任意层级忽略；只有 `config.example.yml` 是模板）
- [x] 确认根 `package.json` **没有 `start` 脚本**（没人从根目录启动）
- [x] 删除根目录 `config.yml`
- [x] 确认 `packages/server/config.yml` 未被触碰
- [x] `alysia-architecture` §7.3 补「配置文件只有一份」契约（⭐ 这是**能传播**的那一半：
      删文件只影响本机，因为该文件不在版本控制里）
- [x] 全量测试（Node 24，免 API 一遍）：135 文件 / 1716 测试全绿
- [x] 归档 + 更新 `openspec/specs/index.md` + `docs/KNOWN-ISSUES.md`（KI-8）+ `docs/TODO.md` 销账
