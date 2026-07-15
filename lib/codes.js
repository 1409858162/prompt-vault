// Generates invite codes from [A-Z0-9] (no I/O/0/1 to avoid confusion).
// Pure function — testable in isolation.
import crypto from 'node:crypto';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no ambiguous
export const DEFAULT_CODE_LENGTH = 32;
export const LEGACY_CODE_LENGTH = 50;

export function generateCode(length = DEFAULT_CODE_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Format as 5 groups of 10 for human readability: "ABCDE-FGHIJ-..." — easier to copy
export function formatCode(code) {
  return code.match(/.{1,10}/g).join('-');
}
