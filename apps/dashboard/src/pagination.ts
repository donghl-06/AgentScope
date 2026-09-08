export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export async function loadAllPages<T>(
  load: (cursor?: string) => Promise<CursorPage<T>>,
): Promise<readonly T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= 1000) throw new Error('Dashboard pagination exceeded the safe page limit.');
    const result = await load(cursor);
    items.push(...result.items);
    if (result.nextCursor === undefined) return items;
    cursor = result.nextCursor;
  }
}
