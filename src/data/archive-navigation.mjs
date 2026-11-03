// Group the public manifest without changing report order, routes or visibility.
export function archiveGroups(pages, current) {
  const children = new Map();
  for (const page of pages) {
    if (!page.parent) continue;
    if (!children.has(page.parent)) children.set(page.parent, []);
    children.get(page.parent).push(page);
  }
  const days = pages
    .filter(page => page.kind === "day")
    .sort((a, b) => b.date.localeCompare(a.date));
  const years = new Map();
  for (const [index, page] of days.entries()) {
    const [year, month, day] = page.date.split("-");
    const open = current
      ? current === page.slug || current.startsWith(page.slug + "/")
      : index === 0;
    if (!years.has(year)) years.set(year, { year, open: false, months: new Map() });
    const yearGroup = years.get(year);
    if (!yearGroup.months.has(month)) {
      yearGroup.months.set(month, { month, open: false, days: [] });
    }
    const monthGroup = yearGroup.months.get(month);
    yearGroup.open ||= open;
    monthGroup.open ||= open;
    monthGroup.days.push({
      day,
      date: page.date,
      slug: page.slug,
      open,
      pages: [page, ...(children.get(page.slug) || [])],
    });
  }
  return [...years.values()].map(year => ({
    ...year,
    months: [...year.months.values()],
  }));
}
