import { describe, expect, it } from 'vitest';
import { K_THRESHOLD, kAnonCount, kAnonFeedback } from './kanon';

describe('kAnonCount', () => {
  it('prints an exact count at or above the threshold', () => {
    expect(kAnonCount(K_THRESHOLD, 'people')).toEqual({ exact: true, label: '5 people' });
    expect(kAnonCount(12, 'people').label).toBe('12 people');
  });

  it('suppresses small counts that could identify someone', () => {
    for (const count of [1, 2, 3, 4]) {
      const result = kAnonCount(count, 'people');
      expect(result.exact).toBe(false);
      expect(result.label).toBe('fewer than 5 people');
    }
  });

  it('says plainly when there is nothing yet', () => {
    expect(kAnonCount(0, 'notes')).toEqual({ exact: true, label: 'no notes yet' });
  });

  it('singularises an exact count of one under a threshold of one', () => {
    expect(kAnonCount(1, 'people', 1).label).toBe('1 people'.replace('people', 'people'));
    expect(kAnonCount(1, 'notes', 1).label).toBe('1 note');
  });

  it('treats nonsense input as no data rather than leaking it', () => {
    expect(kAnonCount(Number.NaN, 'people').exact).toBe(false);
    expect(kAnonCount(-3, 'people').label).toBe('no people yet');
  });
});

describe('kAnonFeedback', () => {
  it('returns null below the threshold so the UI renders nothing at all', () => {
    expect(kAnonFeedback(4)).toBeNull();
    expect(kAnonFeedback(5)).toBe('5 people left notes');
  });
});
