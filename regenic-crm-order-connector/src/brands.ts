/** 安装表单里选中的品牌 id。可以一个，也可以多个。空着表示还没选。 */
export function brandIdsOf(config: Record<string, unknown>): string[] {
  return uniqueStrings(config.brand_ids);
}

export function uniqueStrings(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const text = typeof item === "string" ? item.trim() : "";
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function pageChoices<T extends { value: string; label: { literal: string } }>(
  options: T[],
  query: string | undefined,
  cursor: string | undefined,
  limit: number | undefined,
  selected?: readonly string[],
): { options: T[]; next_cursor?: string } {
  const size = limit && limit > 0 ? limit : 50;
  const needle = query?.trim().toLowerCase() ?? "";
  const filtered = needle
    ? options.filter((option) =>
      option.label.literal.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle))
    : options;
  const ordered = needle ? filtered : echoSelected(filtered, selected);
  const offset = cursor && /^(0|[1-9]\d*)$/.test(cursor) ? Number(cursor) : 0;
  const slice = ordered.slice(offset, offset + size);
  const next = offset + slice.length;
  return {
    options: slice,
    ...(next < ordered.length ? { next_cursor: String(next) } : {}),
  };
}

/** 已保存的编号放到最前，名称仍用数据库里的那条。搜索时不打乱结果。 */
function echoSelected<T extends { value: string }>(options: T[], selected: readonly string[] | undefined): T[] {
  const wanted = uniqueStrings(selected);
  if (wanted.length === 0) {
    return options;
  }
  const byValue = new Map(options.map((option) => [option.value, option]));
  const pinned = wanted.flatMap((id) => {
    const option = byValue.get(id);
    return option ? [option] : [];
  });
  if (pinned.length === 0) {
    return options;
  }
  const pinnedIds = new Set(pinned.map((option) => option.value));
  return [...pinned, ...options.filter((option) => !pinnedIds.has(option.value))];
}
