import type { PlacedItem } from "./types";

/**
 * Side-by-side layout for timed items that share time (like Google Calendar):
 * items that overlap, directly or through a chain, form a group; each gets
 * the first free column in its group, and the group's width is split evenly.
 * An item widens into columns to its right that stay free for its whole span.
 * Very short items count as at least 20 minutes, since that's the smallest
 * box drawn.
 */
export interface ItemLayout {
  col: number;
  span: number;
  cols: number;
}
const MIN_VISUAL_MS = 20 * 60000;
export function layoutColumns(items: PlacedItem[]): ItemLayout[] {
  const out: ItemLayout[] = items.map(() => ({ col: 0, span: 1, cols: 1 }));
  const vEnd = (it: PlacedItem) => Math.max(it.end.getTime(), it.start.getTime() + MIN_VISUAL_MS);
  const order = items
    .map((it, i) => i)
    .sort((a, b) => items[a].start.getTime() - items[b].start.getTime() || vEnd(items[b]) - vEnd(items[a]));
  let group: number[] = [];
  let colEnds: number[] = [];
  let groupEnd = -Infinity;
  const colOf = new Map<number, number>();
  const closeGroup = () => {
    const cols = colEnds.length;
    for (const i of group) {
      const col = colOf.get(i)!;
      let span = 1;
      // Widen into the next columns while nothing there overlaps this item.
      while (col + span < cols) {
        const next = col + span;
        const clash = group.some(
          (j) => colOf.get(j) === next && items[j].start.getTime() < vEnd(items[i]) && items[i].start.getTime() < vEnd(items[j])
        );
        if (clash) break;
        span++;
      }
      out[i] = { col, span, cols };
    }
    group = [];
    colEnds = [];
  };
  for (const i of order) {
    const start = items[i].start.getTime();
    if (group.length && start >= groupEnd) closeGroup();
    let col = colEnds.findIndex((end) => end <= start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(vEnd(items[i]));
    } else {
      colEnds[col] = vEnd(items[i]);
    }
    colOf.set(i, col);
    group.push(i);
    groupEnd = group.length === 1 ? vEnd(items[i]) : Math.max(groupEnd, vEnd(items[i]));
  }
  if (group.length) closeGroup();
  return out;
}

