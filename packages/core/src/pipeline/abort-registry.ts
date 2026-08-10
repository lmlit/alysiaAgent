// ★ 8-10 输入合并 + 打断（input-coalescing-and-abort）
// 按 session 的 AbortController 注册表：新消息到达 → abort 旧 controller（打断在飞 LLM 请求），
// llm-agent 构造请求时从注册表取当前 signal → 一路透传到 fetch。
// 只调 .abort() 而 signal 没到 fetch = 假打断（后端继续烧 token + 竞态）——signal 必须进 openai.ts 的 fetch。

export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  /** 取（或创建）该 session 当前生效的 controller */
  getOrCreate(sessionId: string): AbortController {
    let ctrl = this.controllers.get(sessionId);
    if (!ctrl) {
      ctrl = new AbortController();
      this.controllers.set(sessionId, ctrl);
    }
    return ctrl;
  }

  /** 打断该 session 在飞请求（新消息到达时调用）；controller 从注册表移除，下次请求新建 */
  abort(sessionId: string): void {
    const ctrl = this.controllers.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      this.controllers.delete(sessionId);
      return;
    }
    // 没有在飞请求也预占一个已中止的？不——直接无操作，下次 getOrCreate 新建即可
  }

  /** 请求正常完成后调用（清理防泄漏；不 abort） */
  release(sessionId: string): void {
    this.controllers.delete(sessionId);
  }

  get size(): number {
    return this.controllers.size;
  }
}
