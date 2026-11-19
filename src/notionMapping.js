/**
 * Which Notion columns Breakpoint reads, guessed from the database's own column names.
 * The sheet shows the guess to the user before importing, and lets them pick the deadline column when there are several.
 * `db.properties` is the API's [{ name, type }] list.
 */
export function deriveMapping(db) {
  const p = db.properties || [];
  const find = (types, re) => p.find((x) => types.includes(x.type) && (!re || re.test(x.name)));
  const m = {
    title: find(['title'])?.name,
    date: (find(['date'], /due|deadline|finish|\bend\b|\bby\b|submit|turn in/i) || find(['date']))?.name,
    duration: find(['number'], /min|dur|estimate|effort|time|length/i)?.name,
    priority: find(['select', 'number'], /prior|import|urgen/i)?.name,
    status: (find(['status']) || find(['select', 'checkbox'], /status|done|complete/i))?.name,
    category: find(['select', 'multi_select'], /categ|subject|course|class|area|type/i)?.name,
  };
  return Object.fromEntries(Object.entries(m).filter(([, v]) => v));
}
