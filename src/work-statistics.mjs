// Local calendar boundaries follow the manager's system timezone, including DST.
export function workStatistics(items, sessions, at = new Date()) {
  const today = new Date(at); today.setHours(0, 0, 0, 0);
  const monday = new Date(today); monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const titles = new Map(items.map(item => [item.id, item.title]));
  const unionSeconds = intervals => {
    let total = 0, end = -Infinity;
    for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
    return Math.floor(total / 1000);
  };
  function period(start, end) {
    const rows = new Map(), intervals = [];
    for (const session of sessions) {
      if (!titles.has(session.work_item_id)) continue;
      const first = Date.parse(session.start_at), last = Date.parse(session.end_at);
      const a = Math.max(first, +start), b = Math.min(last, +end, +at);
      if (first >= +end || first > +at || last < +start || (last === +start && first < +start)) continue;
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
      let row = rows.get(session.work_item_id);
      if (!row) { row = { id: session.work_item_id, title: titles.get(session.work_item_id), sessions: 0, intervals: [] }; rows.set(row.id, row); }
      row.sessions++; row.intervals.push([a, b]); intervals.push([a, b]);
    }
    const work = [...rows.values()].map(({ intervals, ...row }) => ({ ...row, seconds: unionSeconds(intervals) }))
      .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title));
    return { seconds: unionSeconds(intervals), item_count: work.length, session_count: work.reduce((n, row) => n + row.sessions, 0), items: work };
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = new Date(monday); start.setDate(start.getDate() + index);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { label: ['월', '화', '수', '목', '금', '토', '일'][index], date: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`, today: +start === +today, ...period(start, end) };
  });
  return { today: period(today, tomorrow), week: period(monday, tomorrow), days, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
