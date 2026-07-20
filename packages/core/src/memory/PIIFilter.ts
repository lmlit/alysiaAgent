// src/memory/PIIFilter.ts

// Chinese phone: 1[3-9]XXXXXXXXX
const PHONE_RE = /1[3-9]\d{9}/g;

// Chinese ID: 6-digit region + 8-digit birthday + 4-digit sequence
const ID_RE = /\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g;

// Bank card: 16-19 digits
const BANK_CARD_RE = /\b\d{16,19}\b/g;

export function filterPII(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(PHONE_RE, '[REDACTED]');
  cleaned = cleaned.replace(ID_RE, '[REDACTED]');
  cleaned = cleaned.replace(BANK_CARD_RE, '[REDACTED]');
  return cleaned;
}
