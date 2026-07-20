export class TokenBudget {
  private used: number;

  constructor(private maxTokens: number) {
    this.used = 0;
  }

  remaining(): number {
    return Math.max(0, this.maxTokens - this.used);
  }

  estimateTokens(text: string): number {
    // Approximate: ~3.5 characters per token for CJK+English mixed
    // CJK characters count as ~1.5 tokens each, English ~0.25 per char
    const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
    const otherCount = text.length - cjkCount;
    return Math.ceil(cjkCount * 1.5 + otherCount * 0.25);
  }

  canFit(text: string): boolean {
    return this.estimateTokens(text) <= this.remaining();
  }

  reserve(text: string): boolean {
    const tokens = this.estimateTokens(text);
    if (this.used + tokens > this.maxTokens) return false;
    this.used += tokens;
    return true;
  }
}
