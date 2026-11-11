// A rolling calendar week anchored to the newest published report. Every
// normal content build moves the window from the manifest, without hand edits.
export function recentReportDays(pages) {
 const days=pages.filter(page=>page.kind==='day').sort((a,b)=>b.date.localeCompare(a.date));
 if(!days.length)return [];
 const cutoff=Date.parse(days[0].date+'T00:00:00Z')-6*86400000;
 return days.filter(day=>Date.parse(day.date+'T00:00:00Z')>=cutoff);
}
export function recentNavigationPages(pages,current) {
 const selected=new Set(recentReportDays(pages).map(day=>day.slug));
 // An old search result keeps its own chapter navigation while the sidebar
 // remains bounded to the recent week plus this one currently read report.
 const active=pages.find(page=>page.kind==='day'&&(current===page.slug||current?.startsWith(page.slug+'/')));
 if(active)selected.add(active.slug);
 return pages.filter(page=>selected.has(page.kind==='day'?page.slug:page.parent));
}
