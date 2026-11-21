/** tiny dom builder. strings become text nodes, never html, so anything from outside is safe to pass in. */
export const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(3)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

const SVG = 'http://www.w3.org/2000/svg';
export const icon = (id, cls = '') => {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', `ico ${cls}`.trim());
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
};

/** wraps durations and clock times in <mark> so the numbers in a sentence stand out. text only, never html. */
export function emphasize(text) {
  const out = [];
  const re = /(\d+ hours?(?: \d+ minutes?)?|\d+ minutes?|\d+h(?: \d+m)?|\d+m|\d{1,2}:\d{2} [AP]M)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('mark', {}, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
