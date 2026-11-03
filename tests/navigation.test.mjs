import test from "node:test";
import assert from "node:assert/strict";
import { archiveGroups } from "../src/data/archive-navigation.mjs";

const day = (date, revision = 1) => ({
  kind: "day", date, revision, slug: `${date}/r${revision}`,
});
const article = (parent, id) => ({
  kind: "article", parent: parent.slug, slug: `${parent.slug}/${id}`, title: id,
});
const allDays = groups => groups.flatMap(year => year.months.flatMap(month => month.days));

test("archive has descending year, month and day groups without mutating the manifest", () => {
  const oldest = day("2025-12-31");
  const newest = day("2026-11-03", 2);
  const october = day("2026-10-31");
  const second = day("2026-11-02");
  const pages = [oldest, article(newest, "first"), october, newest, second, article(newest, "second")];
  const before = structuredClone(pages);
  const groups = archiveGroups(pages);
  assert.deepEqual(groups.map(year => year.year), ["2026", "2025"]);
  assert.deepEqual(groups[0].months.map(month => month.month), ["11", "10"]);
  assert.deepEqual(allDays(groups).map(item => item.date), ["2026-11-03", "2026-11-02", "2026-10-31", "2025-12-31"]);
  assert.deepEqual(allDays(groups)[0].pages.map(page => page.slug), [newest.slug, `${newest.slug}/first`, `${newest.slug}/second`]);
  assert.deepEqual(pages, before);
  assert.equal(allDays(groups).flatMap(item => item.pages).length, pages.length);
});

test("home opens only the latest day and its year and month", () => {
  const groups = archiveGroups([day("2025-12-31"), day("2026-10-31"), day("2026-11-02"), day("2026-11-03")]);
  assert.deepEqual(groups.map(year => year.open), [true, false]);
  assert.deepEqual(groups[0].months.map(month => month.open), [true, false]);
  assert.deepEqual(allDays(groups).map(item => item.open), [true, false, false, false]);
});

test("an older overview or article opens only its exact ancestor chain", () => {
  const old = day("2025-12-31", 10);
  const pages = [day("2026-11-03"), day("2025-11-30"), old, article(old, "old-article")];
  for (const current of [old.slug, `${old.slug}/old-article`]) {
    const groups = archiveGroups(pages, current);
    assert.deepEqual(groups.map(year => year.open), [false, true]);
    assert.deepEqual(groups[1].months.map(month => month.open), [true, false]);
    assert.deepEqual(allDays(groups).filter(item => item.open).map(item => item.slug), [old.slug]);
  }
});

test("revision prefixes and unknown routes do not open an unrelated day", () => {
  const pages = [day("2026-11-03")];
  for (const current of ["2026-11-03/r10/topic", "2026-11-03/r1-other", "unknown"]) {
    const groups = archiveGroups(pages, current);
    assert.equal(groups[0].open, false);
    assert.equal(groups[0].months[0].open, false);
    assert.equal(allDays(groups)[0].open, false);
  }
});

test("empty archives produce no calendar groups", () => {
  assert.deepEqual(archiveGroups([]), []);
});
