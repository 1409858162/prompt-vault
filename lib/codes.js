// Generates a 50-character invite code from [A-Z0-9] (no I/O/0/1 to avoid confusion).
// Pure function — testable in isolation.
import crypto from 'node:crypto';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no ambiguous

export function generateCode(length = 50) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Format as 5 groups of 10 for human readability: "ABCDE-FGHIJ-..." — easier to copy
export function formatCode(code) {
  return code.match(/.{1,10}/g).join('-');
}