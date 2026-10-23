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

describe("initialFetchParams", () => {
  const { INITIAL_FETCH_MARGIN } = paging;

  test("covers the viewport plus a margin, clamped at row 0", () => {
    const [offset, limit] = paging.initialFetchParams(0, 50);
    expect(offset).toBe(0);
    expect(limit).toBe(50 + INITIAL_FETCH_MARGIN + 1);
  });

  test("is much smaller than the full prefetch window", () => {
    const [, initialLimit] = paging.initialFetchParams(0, 50);
    const [, fullLimit] = paging.fetchParams(0, 50);
    expect(initialLimit).toBeLessThan(fullLimit / 2);
  });

  test("brackets a viewport deep in the table", () => {
    const top = 5 * PAGESIZE + 100;
    const bottom = top + 50;
    const [offset, limit] = paging.initialFetchParams(top, bottom);
    expect(offset).toBe(top - INITIAL_FETCH_MARGIN);
    expect(offset + limit - 1).toBe(bottom + INITIAL_FETCH_MARGIN);
  });
});

describe("prefetch trigger", () => {
  // mirrors the check in PivotRequester.onStateChange: a new fetch fires
  // when the desired (margin-inclusive) range escapes the fetched range
  const needsFetch = (
    fetchedOffset: number,
    fetchedLimit: number,
    top: number,
    bottom: number,
    hasData: boolean = true
  ): boolean => {
    const [dOffset, dLimit] = paging.requestParams(hasData, top, bottom);
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

  test("the small initial fetch is followed by the full prefetch window", () => {
    // what a freshly opened view fetches for its first paint...
    const [initialOffset, initialLimit] = paging.initialFetchParams(0, 50);
    // ...leaves the prefetch window outstanding, so a fetch fires as soon
    // as that first page lands
    expect(needsFetch(initialOffset, initialLimit, 0, 50)).toBe(true);
    // and once it lands, nothing further is requested
    const [fullOffset, fullLimit] = paging.fetchParams(0, 50);
    expect(needsFetch(fullOffset, fullLimit, 0, 50)).toBe(false);
  });

  test("no refetch while the initial fetch is still in flight", () => {
    // state changes during a slow first fetch (loading timer ticks) must not
    // restart it: the in-flight initial window is all a data-less view wants
    const [initialOffset, initialLimit] = paging.initialFetchParams(0, 0);
    expect(needsFetch(initialOffset, initialLimit, 0, 0, false)).toBe(false);
    expect(needsFetch(initialOffset, initialLimit, 0, 50, false)).toBe(true);
  });
});
