/**
 * All calculations needed for lazy loading pages of data
 *
 */
export const PAGESIZE = 1024;
export const pageNum = (rowNum: number) => Math.floor(rowNum / PAGESIZE);
export const pageStart = (pageNum: number) => pageNum * PAGESIZE;
/*
 * clamp the viewport top and bottom based on the total row count.
 * Tries to do the minimal adjustment necessary to the location
 * and size of the viewport to keep it within bounds; makes
 * no attempt to adjust to page boundaries or extend for
 * pre-fetching.
 */

export const clampViewport = (
  rowCount: number,
  inTop: number,
  inBottom: number
): [number, number] => {
  const inSize = inBottom - inTop;
  const outBottom = Math.min(rowCount, inBottom);
  const outTop = Math.max(0, outBottom - inSize);
  /*
    if ((outTop !== inTop) || (outBottom !== inBottom)) {
      console.log('clamped viewport: [%d,%d] --> [%d,%d]', inTop, inBottom, outTop, outBottom)
    }
  */

  return [outTop, outBottom];
};
/*
 * calculate and return row offset and limit to obtain a viewport including
 * the specified top and bottom rows, aligned to page boundaries.
 *
 * Includes one extra page of margin above and below the viewport so that
 * scrolling into an adjacent page finds its rows already loaded, and the
 * next fetch (triggered on entering the margin) completes before the
 * viewport reaches unloaded rows.
 */

export const fetchParams = (top: number, bottom: number): [number, number] => {
  const startPage = Math.max(0, pageNum(top) - 1);
  const endPage = pageNum(bottom) + 1;
  const offset = pageStart(startPage);
  const limit = (endPage - startPage + 1) * PAGESIZE;
  return [offset, limit];
};
/*
 * Rows fetched above and below the viewport for the *first* page of a newly
 * opened view. Generous enough to cover the visible rows of a tall window
 * (and a little scrolling), but far smaller than the full prefetch window.
 */

export const INITIAL_FETCH_MARGIN = 256;
/*
 * calculate offset and limit for the first data request of a new view.
 *
 * The full fetchParams window is thousands of rows; serializing and rendering
 * it is what the user waits on when opening or switching datasets, even though
 * only the visible rows matter for the first paint. So the first request covers
 * just the viewport plus a small margin; the regular prefetch window is
 * requested immediately afterwards (see PivotRequester.onStateChange, which
 * notices that the desired range isn't loaded yet) and lands in the background.
 */

export const initialFetchParams = (
  top: number,
  bottom: number
): [number, number] => {
  const offset = Math.max(0, top - INITIAL_FETCH_MARGIN);
  const limit = bottom + INITIAL_FETCH_MARGIN - offset + 1;
  return [offset, limit];
};
/*
 * offset and limit of the data request for the current viewport: the small
 * initial window while the view has no data yet, the full prefetch window after.
 *
 * PivotRequester must use this both to issue requests and to decide whether
 * the viewport needs a new one. If the trigger compared against the full window
 * while the request was still the initial one, every state change during a slow
 * first fetch (e.g. the 200ms loading timer tick) would fire another initial
 * fetch that supersedes the one in flight, and a first fetch slower than that
 * tick (wide tables) would never land.
 */

export const requestParams = (
  hasData: boolean,
  top: number,
  bottom: number
): [number, number] =>
  hasData ? fetchParams(top, bottom) : initialFetchParams(top, bottom);
/*
 * returns true iff the interval [top,bottom] entirely contained in the specified
 * offset and limit
 */

export const contains = (
  offset: number,
  limit: number,
  top: number,
  bottom: number
): boolean => (top >= offset && bottom < offset + limit) || bottom - top === 0;
