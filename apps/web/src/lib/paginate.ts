/** Pack measured blocks into two columns per sheet, preserving reading order. */
export function paginateBlocks(heights: number[], firstCapacity: number, capacity: number): number[][][] {
  const pages: number[][][] = [[[], []]];
  let page = 0, column = 0, used = 0;
  for (const [index, height] of heights.entries()) {
    const limit = page === 0 ? firstCapacity : capacity;
    if (used && used + height > limit) {
      column++;
      if (column === 2) { page++; pages.push([[], []]); column = 0; }
      used = 0;
    }
    pages[page]![column]!.push(index);
    used += height;
  }
  return pages;
}
