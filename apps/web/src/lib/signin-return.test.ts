import { beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeSignInReturn, rememberSignInReturn } from './signin-return';
beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
describe('same-device invitation return', () => {
  it('returns to the invitation once after sign-in', () => {
    rememberSignInReturn('?next=%2Finvite%2Fabc_123-xyz');
    expect(consumeSignInReturn()).toBe('/invite/abc_123-xyz');
    expect(consumeSignInReturn()).toBe('/requests');
  });
  it.each(['https://other.example', '//other.example', '/admin', '/invite/x?next=evil', '/invite/../admin'])('rejects an unrelated or unsafe return: %s', path => {
    rememberSignInReturn(`?next=${encodeURIComponent(path)}`);
    expect(consumeSignInReturn()).toBe('/requests');
  });
  it('expires an abandoned invitation', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    rememberSignInReturn('?next=/invite/abc');
    vi.mocked(Date.now).mockReturnValue(1000 + 31 * 60 * 1000);
    expect(consumeSignInReturn()).toBe('/requests');
  });
  it('clears an old invitation when a fresh ordinary sign-in starts', () => {
    rememberSignInReturn('?next=/invite/abc');
    rememberSignInReturn('');
    expect(consumeSignInReturn()).toBe('/requests');
  });
});
