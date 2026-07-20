import { describe, it, expect } from 'vitest';
import { TokenBudget } from '../../../src/memory/TokenBudget';

describe('TokenBudget', () => {
  it('should report remaining tokens', () => {
    const budget = new TokenBudget(100);
    expect(budget.remaining()).toBe(100);
  });

  it('should estimate tokens (approx chars / 3.5)', () => {
    const budget = new TokenBudget(1000);
    // "hello" = 5 chars, approx 2 tokens
    const tokens = budget.estimateTokens('hello');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(5);
  });

  it('should check if text fits within budget', () => {
    const budget = new TokenBudget(100);
    const shortText = 'short';
    expect(budget.canFit(shortText)).toBe(true);

    const longText = 'x'.repeat(10000);
    expect(budget.canFit(longText)).toBe(false);
  });

  it('should reserve tokens', () => {
    const budget = new TokenBudget(1000);
    const success = budget.reserve('need about 50 tokens worth of text here');
    expect(success).toBe(true);
    expect(budget.remaining()).toBeLessThan(1000);
  });

  it('should reject reservation exceeding budget', () => {
    const budget = new TokenBudget(10);
    const hugeText = 'x'.repeat(10000);
    expect(budget.reserve(hugeText)).toBe(false);
  });
});
