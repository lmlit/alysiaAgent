// src/memory/stores/ProfileStore.ts
import type Database from 'better-sqlite3';
import type { UserProfile, ProfileFact } from '../types.js';
import { FACT_TTL_BY_CATEGORY, FACT_CONFIRM_WINDOW_MS } from '../types.js';
// ★ 2026-10-21（C3）：basics 谱系/stale 的留痕
import { logger } from '../../utils/logger.js';

const NOW = () => new Date().toISOString();

function normalizeKey(fact: string): string {
  return fact
    // ★ 8-09 去重增强：停用字扩表（+在于是和也呀啊哦吧）、去"用户/你"主语前缀、去标点
    .replace(/[的得了吗呢是个了在于是和也呀啊哦吧]/g, '')
    .replace(/[职业开发工程师前端后端架构设计运营产品]/g, '')
    .replace(/^(用户|你)/, '')
    .replace(/[\s，,。！？；;：:、()（）"“”']/g, '')
    .slice(0, 20)
    .toLowerCase();
}

/** ★ 8-09：归一化后包含匹配——"长沙" ⊆ "目前所在城市长沙" 视为同事实。
 *  保护规则：长侧 ≥5 字且短侧 ≥2 字才判定（"长沙"这类 2 字实体是事实核心；
 *  "铁道" ⊆ "星穹铁道" 这种 2字/4字 组合不误合并）。 */
function normContains(a: string, b: string): boolean {
  const [longer, shorter] = a.length >= b.length ? [a, b] : [b, a];
  if (longer.length < 5 || shorter.length < 2) return false;
  return longer.includes(shorter);
}

/** 向后兼容：给旧 facts 补上新字段的默认值 */
function migrateFact(f: Partial<ProfileFact>): ProfileFact {
  return {
    fact: f.fact || '',
    confidence: f.confidence ?? 0.4,
    evidence: f.evidence || '',
    source_event: f.source_event || 'unknown',
    updated_at: f.updated_at || NOW(),
    source: f.source || 'inferred',
    valid_from: f.valid_from || f.updated_at || NOW(),
    valid_until: f.valid_until ?? null,
    status: f.status || 'active',
    // ★ 8-28 分类兜底：存量事实 → general（不强制迁移；新写入由提取器/调用方给分类）
    category: f.category ?? 'general',
  };
}

export class ProfileStore {
  constructor(private db: Database.Database) {}

  private ensureRow(): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO user_profile (id, basics, preferences, facts, updated_at)
      VALUES (1, '{}', '{}', '[]', ?)
    `).run(NOW());
  }

  get(): UserProfile {
    this.ensureRow();
    return this.db.prepare('SELECT * FROM user_profile WHERE id = 1').get() as UserProfile;
  }

  updateBasics(basics: string): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET basics = ?, updated_at = ? WHERE id = 1')
      .run(basics, NOW());
  }

  // ===== ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C3）：basics 的谱系 =====

  /**
   * 重写 `basics` 并**记下谱系**：这次总结用到了哪些事实、什么时候生成的。
   *
   * 为什么要记：`basics` 是**派生**（一次 LLM 总结），不是真相。没有谱系就回答不了
   * "这条旧说法是从哪来的、还成不成立"（E7）。
   *
   * @param factKeys **当次实际喂给 LLM 的**事实键（`factKeyOf`），不是全量
   */
  updateBasicsWithSource(basics: string, factKeys: string[]): void {
    this.ensureRow();
    const source = JSON.stringify({
      factKeys,
      factCount: factKeys.length,
      generatedAt: NOW(),
    });
    this.db.prepare(
      'UPDATE user_profile SET basics = ?, basics_source = ?, basics_stale = 0, updated_at = ? WHERE id = 1'
    ).run(basics, source, NOW());
  }

  /** 读 `basics` 的谱系与新鲜度（只读，纯数据） */
  getBasicsMeta(): {
    stale: boolean;
    factCount: number;
    generatedAt: string | null;
    factKeys: string[];
  } {
    this.ensureRow();
    const row = this.db.prepare(
      'SELECT basics_source, basics_stale FROM user_profile WHERE id = 1'
    ).get() as { basics_source?: string; basics_stale?: number } | undefined;

    let parsed: { factKeys?: unknown; factCount?: unknown; generatedAt?: unknown } = {};
    try {
      parsed = JSON.parse(row?.basics_source || '{}');
    } catch {
      // 坏 JSON：如实当作"没有谱系"，并把 stale 视为 true（宁可说过时，不要假装新鲜）
      logger.warn('[ProfileStore] basics_source 不是合法 JSON —— 谱系视为缺失');
      return { stale: true, factCount: 0, generatedAt: null, factKeys: [] };
    }
    const factKeys = Array.isArray(parsed.factKeys) ? (parsed.factKeys as string[]) : [];
    return {
      stale: (row?.basics_stale ?? 0) !== 0,
      factCount: typeof parsed.factCount === 'number' ? parsed.factCount : factKeys.length,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      factKeys,
    };
  }

  /**
   * 把 `basics` 标记为"可能已过时"（**不同步重建** —— 重建要调 LLM，不能挂在写入路径上）。
   *
   * 触发点：任何事实变成"不再成立"（superseded / expired）。
   */
  markBasicsStale(): void {
    this.ensureRow();
    const r = this.db.prepare('UPDATE user_profile SET basics_stale = 1 WHERE id = 1 AND basics_stale = 0').run();
    if (r.changes > 0) {
      logger.info('[ProfileStore] 事实状态变化 → basics 标记 stale（下次重写或按需重建）');
    }
  }

  updatePreferences(prefs: string): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET preferences = ?, updated_at = ? WHERE id = 1')
      .run(prefs, NOW());
  }

  // ===== Facts v2: 带有效期、来源、状态的 CRUD =====

  /**
   * 返回**全部** facts（含已过期/被替代的）。
   *
   * ★ 2026-10-21（change: `unify-memory-eligibility`，契约 C2）：**仅限审计/调试**。
   *
   * 本方法的名字在很长一段时间里被当成"读事实"的通用入口，于是出现了两类错：
   *   - `CronProcessor.deepProfile` 拿它重写 `basics` ⇒ 被纠正的旧说法**换个形式**回到 prompt（E2）
   *   - 纠正候选池拿它当候选 ⇒ 模型可能去"纠正"一条早就不成立的旧说法（E3）
   *
   * 现在的纪律：
   *   ① **业务读取一律用 `getCurrentFacts()`**（= active 且未过期）
   *   ② 本方法只给审计、数据修复脚本、测试用
   *   ③ `scripts/check-memory-eligibility.cjs --strict` 会拦住 processors/engines 里的调用
   */
  getAllFacts(): ProfileFact[] {
    this.ensureRow();
    const row = this.db.prepare('SELECT facts FROM user_profile WHERE id = 1').get() as { facts: string };
    const raw: Partial<ProfileFact>[] = JSON.parse(row.facts);
    return raw.map(migrateFact);
  }

  /** @deprecated 使用 getAllFacts()（审计）或 getCurrentFacts()（业务） */
  getFacts(): ProfileFact[] {
    return this.getAllFacts();
  }

  /**
   * ★ 2026-10-21（契约 C2）：**当前认知**的唯一读取出口 —— `status='active'` 且未过期。
   *
   * 这是"现在仍然成立的认知"，与 `getAllFacts()`（历史 + 证据链）严格分开：
   * 前者可以**直接陈述**（进画像/进 prompt/当纠正候选），后者只能被**引用为历史**。
   */
  getCurrentFacts(): ProfileFact[] {
    const all = this.getAllFacts();
    const now = NOW();
    return all
      .filter(f => f.status === 'active')
      .filter(f => f.valid_until === null || f.valid_until > now);
  }

  /** @deprecated 用 `getCurrentFacts()`（同语义，旧名保留兼容）。 */
  getActiveFacts(): ProfileFact[] {
    return this.getCurrentFacts();
  }

  /** 插入新 fact，带冲突检测 */
  addFact(fact: ProfileFact): boolean {
    const all = this.getAllFacts();
    const key = normalizeKey(fact.fact);

    // ★ 8-09：同 key **或归一化包含**（"用户在长沙" vs "用户目前所在城市是长沙"）视为冲突
    const existingIdx = all.findIndex(
      f => f.status === 'active' && (normalizeKey(f.fact) === key || normContains(normalizeKey(f.fact), key))
    );

    if (existingIdx >= 0) {
      const existing = all[existingIdx];
      // 如果旧条是 user 来源，inferred 不能覆盖
      if (existing.source === 'user' && fact.source === 'inferred') {
        return false;
      }
      // 旧条 superseded
      all[existingIdx] = {
        ...existing,
        status: 'superseded',
        valid_until: NOW(),
        updated_at: NOW(),
      };
      // ★ C3：有一条事实不再成立 ⇒ 由它派生的 `basics` 可能过时
      this.markBasicsStale();
    }

    // 插入新条
    all.push({
      ...fact,
      status: 'active',
      valid_from: fact.valid_from || NOW(),
      // ★ 8-28 分类过期兜底（profile-facts-classification-confirm）：未显式给 valid_until
      //   且 category 明确 → 按分类 TTL 设过期（身份 365d/偏好 90d/状态 14d/关系 90d/默认 60d）；
      //   旧调用无 category → null 保持旧行为（永不过期）
      valid_until: fact.valid_until ?? (fact.category && FACT_TTL_BY_CATEGORY[fact.category]
        ? new Date(Date.now() + FACT_TTL_BY_CATEGORY[fact.category]).toISOString()
        : null),
      updated_at: NOW(),
    });

    this.writeFacts(all);
    return true;
  }

  /** 批量插入 facts（LLM 提取的），逐个走冲突检测 */
  addFacts(newFacts: ProfileFact[]): ProfileFact[] {
    const all = this.getAllFacts();
    const added: ProfileFact[] = [];

    for (const fact of newFacts) {
      const key = normalizeKey(fact.fact);
      // ★ 8-09：同 key 或归一化包含视为冲突（与 addFact 一致）
      const existingIdx = all.findIndex(
        f => f.status === 'active' && (normalizeKey(f.fact) === key || normContains(normalizeKey(f.fact), key))
      );

      if (existingIdx >= 0) {
        const existing = all[existingIdx];
        if (existing.source === 'user' && (fact.source || 'inferred') === 'inferred') {
          // 用户主动声明不可被 inferred 覆盖，跳过
          continue;
        }
        // supersede 旧条
        all[existingIdx] = {
          ...existing,
          status: 'superseded',
          valid_until: NOW(),
          updated_at: NOW(),
        };
        // ★ C3：同上 —— 事实状态变化要传播到派生结果
        this.markBasicsStale();
      }

      const migrated = migrateFact(fact);
      migrated.status = 'active';
      migrated.valid_from = migrated.valid_from || NOW();
      migrated.updated_at = NOW();
      // ★ 8-28 分类过期兜底（同 addFact）：按**原始** fact.category 判断——
      //   旧调用没传 category → 保持 null（永不过期，向后兼容）；传了 → 按 TTL
      if (!migrated.valid_until && fact.category && FACT_TTL_BY_CATEGORY[fact.category]) {
        migrated.valid_until = new Date(Date.now() + FACT_TTL_BY_CATEGORY[fact.category]).toISOString();
      }
      all.push(migrated);
      added.push(migrated);
    }

    if (added.length > 0) {
      this.writeFacts(all);
    }
    return added;
  }

  /** 快捷：用关键词匹配旧 fact 然后 supersede + 插入新 fact */
  supersede(keyword: string, newFact: ProfileFact): boolean {
    const all = this.getAllFacts();
    let found = false;

    for (let i = 0; i < all.length; i++) {
      if (
        all[i].status === 'active' &&
        all[i].fact.includes(keyword)
      ) {
        all[i] = {
          ...all[i],
          status: 'superseded',
          valid_until: NOW(),
          updated_at: NOW(),
        };
        found = true;
      }
    }

    if (!found) return false;

    // ★ C3：supersede 是"旧说法被推翻"，`basics` 立刻可能过时
    this.markBasicsStale();

    all.push({
      ...migrateFact(newFact),
      source: newFact.source || 'user',
      confidence: newFact.confidence ?? 1.0,
      status: 'active',
      valid_from: NOW(),
      valid_until: null,
      updated_at: NOW(),
    });

    this.writeFacts(all);
    return true;
  }

  /** 逐条过期（按索引，调试用） */
  expireFact(index: number): void {
    const all = this.getAllFacts();
    if (index >= 0 && index < all.length) {
      all[index] = {
        ...all[index],
        status: 'expired',
        valid_until: NOW(),
        updated_at: NOW(),
      };
      // ★ C3：过期也是"不再成立"
      this.markBasicsStale();
      this.writeFacts(all);
    }
  }

  replaceFacts(facts: ProfileFact[]): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET facts = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(facts), NOW());
    // ★ C3：整表替换（恢复备份 / 批量过期）同样会让派生结果过时 ——
    //   不标这一下，就会出现"事实全没了、basics 还当新鲜"的组合。
    this.markBasicsStale();
  }

  /** @deprecated 使用 addFacts() 代替 */
  addFactsLegacy(newFacts: ProfileFact[]): void {
    const current = this.getAllFacts();
    const updated = [...current, ...newFacts];
    this.replaceFacts(updated);
  }

  // ===== ★ 8-28 角色事实（memory-character-perspective）=====
  // 昔涟自己的事，与 facts（用户事实）并列。结构完全复用 ProfileFact（分类/TTL/确认机制）。
  // 冲突检测/过期确认逻辑与用户事实同构（列不同）。

  getAllCharacterFacts(): ProfileFact[] {
    this.ensureRow();
    const row = this.db.prepare('SELECT character_facts FROM user_profile WHERE id = 1').get() as { character_facts: string };
    const raw: Partial<ProfileFact>[] = JSON.parse(row.character_facts || '[]');
    return raw.map(migrateFact);
  }

  /**
   * ★ 2026-10-21（契约 C2）：角色事实的**当前态**出口（与 `getCurrentFacts` 同构）。
   *
   * 角色事实与她"当前对自己的认知"同档：可以直接进【关于我】，但**不参与人格参数**（D2）。
   */
  getCurrentCharacterFacts(): ProfileFact[] {
    const all = this.getAllCharacterFacts();
    const now = NOW();
    return all
      .filter(f => f.status === 'active')
      .filter(f => f.valid_until === null || f.valid_until > now);
  }

  /** @deprecated 用 `getCurrentCharacterFacts()`（同语义，旧名保留兼容）。 */
  getActiveCharacterFacts(): ProfileFact[] {
    return this.getCurrentCharacterFacts();
  }

  /** 批量插入角色事实（同 addFacts 冲突检测：normalizeKey + 子串包含） */
  addCharacterFacts(newFacts: ProfileFact[]): ProfileFact[] {
    const all = this.getAllCharacterFacts();
    const added: ProfileFact[] = [];

    for (const fact of newFacts) {
      const key = normalizeKey(fact.fact);
      const existingIdx = all.findIndex(
        f => f.status === 'active' && (normalizeKey(f.fact) === key || normContains(normalizeKey(f.fact), key))
      );
      if (existingIdx >= 0) {
        all[existingIdx] = { ...all[existingIdx], status: 'superseded', valid_until: NOW(), updated_at: NOW() };
      }
      const migrated = migrateFact(fact);
      migrated.status = 'active';
      migrated.valid_from = migrated.valid_from || NOW();
      migrated.updated_at = NOW();
      if (!migrated.valid_until && fact.category && FACT_TTL_BY_CATEGORY[fact.category]) {
        migrated.valid_until = new Date(Date.now() + FACT_TTL_BY_CATEGORY[fact.category]).toISOString();
      }
      all.push(migrated);
      added.push(migrated);
    }

    if (added.length > 0) {
      this.ensureRow();
      this.db.prepare('UPDATE user_profile SET character_facts = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(all), NOW());
    }
    return added;
  }

  setUpdated(): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET updated_at = ? WHERE id = 1')
      .run(NOW());
  }

  private writeFacts(facts: ProfileFact[]): void {
    this.ensureRow();
    this.db.prepare('UPDATE user_profile SET facts = ?, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(facts), NOW());
  }

  // ===== ★ 8-28 过期确认（profile-facts-classification-confirm）=====

  /** 定位 key：事实归一化文本（normalizeKey），无 schema 改动即可稳定引用单条事实 */
  factKeyOf(factText: string): string {
    return normalizeKey(factText);
  }

  /** 过期清理：valid_until 已过且超过确认窗口（3 天）的 active 事实 → expired（不反复打扰）。
   *  返回清理条数。调用方在读取待确认列表前执行。 */
  expireStaleFacts(): number {
    const all = this.getAllFacts();
    const now = Date.now();
    let n = 0;
    for (const f of all) {
      if (f.status === 'active' && f.valid_until && now - new Date(f.valid_until).getTime() > FACT_CONFIRM_WINDOW_MS) {
        f.status = 'expired';
        n++;
      }
    }
    if (n > 0) {
      // ★ C3：过期清理同样让派生结果过时
      this.markBasicsStale();
      this.writeFacts(all);
    }
    return n;
  }

  /** 确认事实：stillValid=true → 按分类续期一个周期；false → superseded。key 为 factKeyOf 归一化文本 */
  confirmFact(key: string, stillValid: boolean): boolean {
    const all = this.getAllFacts();
    const idx = all.findIndex(f => normalizeKey(f.fact) === key);
    if (idx < 0) return false;
    const f = all[idx];
    if (stillValid) {
      f.status = 'active';
      f.valid_until = new Date(Date.now() + FACT_TTL_BY_CATEGORY[f.category]).toISOString();
      f.updated_at = NOW();
    } else {
      f.status = 'superseded';
      f.valid_until = NOW();
      f.updated_at = NOW();
      // ★ C3：用户确认"这条不再成立" ⇒ basics 可能过时
      this.markBasicsStale();
    }
    this.writeFacts(all);
    return true;
  }

  /** 待确认事实：过期 ≤3 天的 active 事实（先清理超窗事实）。
   *  PromptAssembler 注入【待确认的事实】块 + MemoryManager 工具链路共用 */
  listPendingConfirmFacts(): Array<{ factId: string; fact: string; validFrom: string; category: string }> {
    this.expireStaleFacts();
    const now = Date.now();
    return this.getAllFacts()
      .filter(f => f.status === 'active' && f.valid_until)
      .filter(f => new Date(f.valid_until!).getTime() <= now)
      .filter(f => now - new Date(f.valid_until!).getTime() <= FACT_CONFIRM_WINDOW_MS)
      .map(f => ({
        factId: normalizeKey(f.fact),
        fact: f.fact,
        validFrom: f.valid_from,
        category: f.category,
      }));
  }
}
