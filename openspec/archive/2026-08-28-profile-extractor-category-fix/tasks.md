# Tasks: profile-extractor-category-fix

> 每个任务完成后勾选；全部完成后 apply（合并 spec）→ archive。

## 实现任务

- [ ] T1 ProfileExtractor prompt：category 枚举加中文语义 + "必须从这五个值中选择"强约束
- [ ] T2 提取器容错映射：CATEGORY_SYNONYMS 同义词表（location→identity / interest,hobby→preference / current,recent→status / friend,relation→relationship）
- [ ] T3 测试：同义词映射 5 例 + 未命中回落 general

## Apply 任务（实现完成后）

- [ ] 合并 spec.md 到 `openspec/specs/memory-system/spec.md`（★ 从主 spec 拷贝后追加，勿只写新增）
- [ ] 更新 `openspec/specs/index.md`
- [ ] build + 重新部署服务器镜像
- [ ] 服务器复验：真实提取一次，category 非全 general
