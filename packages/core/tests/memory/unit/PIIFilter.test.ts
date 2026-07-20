// tests/memory/unit/PIIFilter.test.ts
import { describe, it, expect } from 'vitest';
import { filterPII } from '../../../src/memory/PIIFilter';

describe('PIIFilter', () => {
  it('should redact Chinese mobile phone numbers', () => {
    const input = '我的电话是13812345678';
    const output = filterPII(input);
    expect(output).not.toContain('13812345678');
    expect(output).toContain('[REDACTED]');
  });

  it('should redact Chinese ID numbers (18 digits)', () => {
    const input = '身份证号是110101199001011234';
    const output = filterPII(input);
    expect(output).not.toContain('110101199001011234');
  });

  it('should redact bank card numbers', () => {
    const input = '卡号是6222021234567890123';
    const output = filterPII(input);
    expect(output).not.toContain('6222021234567890123');
  });

  it('should pass through clean text unchanged', () => {
    const input = '今天天气很好';
    expect(filterPII(input)).toBe('今天天气很好');
  });

  it('should handle empty string', () => {
    expect(filterPII('')).toBe('');
  });
});
