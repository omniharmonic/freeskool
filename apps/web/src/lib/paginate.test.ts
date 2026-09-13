import { describe, expect, it } from 'vitest';
import { paginateBlocks } from './paginate';
describe('zine pagination', () => {
  it('keeps each class intact and in order across columns and sheets', () => {
    const pages=paginateBlocks([100,100,100,100,100,100,100],250,300);
    expect(pages).toEqual([[[0,1],[2,3]],[[4,5,6],[]]]);
    expect(pages.flat(2)).toEqual([0,1,2,3,4,5,6]);
  });
  it('handles a busy day without treating the entire day as one unbreakable block', () => {
    const pages=paginateBlocks(Array(50).fill(120),600,700);
    expect(pages.length).toBe(5);
    expect(new Set(pages.flat(2)).size).toBe(50);
  });
});
