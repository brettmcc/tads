import * as paging from "../src/paging";

const { PAGESIZE } = paging;

describe("fetchParams", () => {
  test("clamps the leading margin page at row 0", () => {
    const [offset, limit] = paging.fetchParams(0, 50);
    expect(offset).toBe(0);
    // page 0 (viewport) + one trailing margin page
    expect(limit).toBe(2 * PAGESIZE);
  });

  test("includes one margin page on each side of the viewport", () => {
    const top = 5 * PAGESIZE + 100;
    const bottom = top + 50;
    const [offset, limit] = paging.fetchParams(top, bottom);
    expect(offset).toBe(4 * PAGESIZE);
    // pages 4..6: margin, viewport, margin
    expect(limit).toBe(3 * PAGESIZE);
  });

  test("viewport spanning a page boundary covers both pages plus margins", () => {
    const top = 3 * PAGESIZE - 10;
    const bottom = 3 * PAGESIZE + 10;
    const [offset, limit] = paging.fetchParams(top, bottom);
    expect(offset).toBe(1 * PAGESIZE);
    // pages 1..4
    expect(limit).toBe(4 * PAGESIZE);
  });
});

describe("prefetch trigger", () => {
  // mirrors the check in PivotRequester.onStateChange: a new fetch fires
  // when the desired (margin-inclusive) range escapes the fetched range
  const needsFetch = (
    fetchedOffset: number,
    fetchedLimit: number,
    top: number,
    bottom: number
  ): boolean => {
    const [dOffset, dLimit] = paging.fetchParams(top, bottom);
    return !paging.contains(
      fetchedOffset,
      fetchedLimit,
      dOffset,
      dOffset + dLimit - 1
    );
  };

  test("no fetch while viewport stays in the central page", () => {
    // fetched pages 4..6 (from a viewport in page 5)
    const fetchedOffset = 4 * PAGESIZE;
    const fetchedLimit = 3 * PAGESIZE;
    const top = 5 * PAGESIZE + 200;
    expect(needsFetch(fetchedOffset, fetchedLimit, top, top + 50)).toBe(false);
  });

  test("fetch fires when viewport enters a margin page (rows still loaded)", () => {
    const fetchedOffset = 4 * PAGESIZE;
    const fetchedLimit = 3 * PAGESIZE;
    // viewport now inside page 6 — the trailing margin page
    const top = 6 * PAGESIZE + 10;
    expect(needsFetch(fetchedOffset, fetchedLimit, top, top + 50)).toBe(true);
  });
});
