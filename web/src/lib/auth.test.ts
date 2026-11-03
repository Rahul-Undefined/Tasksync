import { describe, expect, it } from 'vitest';
import { secondsLeft } from './auth';

const jwt = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('ID token refresh timing', () => {
  it('reads the remaining lifetime from an unpadded base64url JWT', () => {
    const now = Date.UTC(2026, 10, 3, 12, 0, 0);
    expect(secondsLeft(jwt({ exp: now / 1000 + 600, name: 'Ünïcode ✓' }), now)).toBe(600);
    expect(secondsLeft(jwt({ exp: now / 1000 - 5 }), now)).toBe(-5);
  });
  it('treats unreadable tokens as expired so they get refreshed', () => {
    expect(secondsLeft(undefined)).toBe(0);
    expect(secondsLeft('not-a-jwt')).toBe(0);
    expect(secondsLeft(jwt({ sub: 'no-exp' }))).toBe(0);
  });
});
