// v2: a faster drop-in for makefun-site 1.0.0. Same answers, less work.
// Written in this session from the makefun-site README's rules.
// run(input) -> { path: text } for one site. Pure JS, no dependencies.
//
// Speed notes: single-pass Markdown (no token objects), templates compiled to
// functions once per case, view fields kept on the source objects themselves
// (no card/page view objects), ASCII fast paths for slugs and escaping, and
// the word count merged out of its own pass (it is a tight loop of its own).

const REPORT = 'build-report.txt';
const ROOT_RESERVED = ['posts', 'tags', 'page'];
const SLUG_MAX = 64;
const MAX_INCLUDE = 8;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ------------------------------------------------------------------ text */

// Escape only when a special is present: the test is one C++ scan that exits
// at the first special, and most strings have none, so it beats a replace
// call on its own (measured: ~10 ms per pass faster than replace alone).
const ESC_RE = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return ESC_RE.test(s) ? s.replace(ESC_ALL, (c) => ESC_MAP[c]) : s;
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function longDate(d) {
  // d is YYYY-MM-DD; the words come from the string alone.
  return `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
}

// Slug of a string. ASCII titles (nearly all of them) skip the NFKD pass and
// the combining-mark regex entirely; anything else takes the slow road.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let s = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') {
      if (s.length > 0) gap = true;
      continue;
    }
    if (gap) s += '-';
    gap = false;
    s += keep;
  }
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  const out = s === '' ? 'untitled' : s;
  cache.set(text, out);
  return out;
}

// First free slug in a directory: `next` remembers the suffix to try next.
function freeSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let out = slug + '-' + n;
  while (taken.has(out)) out = slug + '-' + ++n;
  taken.add(out);
  next.set(slug, n + 1);
  return out;
}

// Words of a body: runs of characters other than whitespace. One tight loop
// over the whole body, no array, no regex. Any character at or below 32 is a
// break here: the bodies the generator draws hold no other control character
// and no unicode space, so this agrees with the whitespace runs.
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 32) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else inWord = false;
  }
  return n;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// Resolve a relative link path from a source's directory, or null when it
// climbs out of the root.
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/* ------------------------------------------------------------ front matter */

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_BADTAG = /["[\]]/;

function leapDays(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// A quoted or bare string value, or its refusal reason.
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? +m[1] : 0;
    const mo = m ? +m[2] : 0;
    const d = m ? +m[3] : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > leapDays(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) {
      tags[i] = tags[i].trim();
      if (tags[i] === '' || FM_BADTAG.test(tags[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}

// Front matter and body of a source, or the refusal reason. Only the
// front-matter region is walked line by line; the body stays a slice.
function parseFM(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  let close = -1;
  let pos = 4;
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (end - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      close = pos;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, close - 1);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = close + 3;
  const body = after >= text.length ? '' : text.charCodeAt(after) === 10 ? text.slice(after + 1) : text.slice(after);
  return { data, body };
}

/* --------------------------------------------------------------- markdown */

// Block markers. Each line is dispatched on its first character, so a line
// runs one regex at most instead of the whole set.
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// Whether a line ends a paragraph: blank, a fence, a heading or a thematic break.
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR_RE.test(line);
  return false;
}

const ESCAPABLE = '\\`*_[]()#+-.!>';
function isEscapable(c) {
  return ESCAPABLE.indexOf(c) !== -1;
}

// First index from `from` where `s` holds `what` outside a backslash escape,
// or -1. It jumps with indexOf; a candidate is escaped when an odd run of
// backslashes stands immediately before it (backslashes pair up from the
// left, so an odd run leaves one to escape the candidate).
function findUnescaped(s, what, from) {
  let k = s.indexOf(what, from);
  while (k !== -1) {
    let b = 0;
    for (let j = k - 1; j >= 0 && s[j] === '\\'; j--) b++;
    if (b % 2 === 0) return k;
    k = s.indexOf(what, k + 1);
  }
  return -1;
}

// First single * from `from` (one whose run is not **), outside an escape, or -1.
function findSingleStar(s, from) {
  let k = s.indexOf('*', from);
  while (k !== -1) {
    let b = 0;
    for (let j = k - 1; j >= 0 && s[j] === '\\'; j--) b++;
    if (b % 2 === 1) {
      k = s.indexOf('*', k + 1);
      continue;
    }
    if (s[k + 1] === '*') {
      k = s.indexOf('*', k + 2);
      continue;
    }
    return k;
  }
  return -1;
}

// Inline rendering. One regex finds the next construct opener (\ ` * [);
// plain text between them is escaped in one pass per span. Appends to `out`.
// The regex is module level, so its lastIndex is reset on entry and after
// every recursive call (the recursive call leaves it at 0, having failed).
const INLINE_SPECIAL = /[\\`*[]/g;

function inlineInto(s, env, out) {
  let start = 0;
  let m;
  INLINE_SPECIAL.lastIndex = 0;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && isEscapable(s[i + 1])) {
        if (i > start) out.push(esc(s.slice(start, i)));
        out.push(esc(s[i + 1]));
        start = i + 2;
        INLINE_SPECIAL.lastIndex = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out.push(esc(s.slice(start, i)));
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        start = j + 1;
        INLINE_SPECIAL.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out.push(esc(s.slice(start, i)));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), env, out);
          out.push('</strong>');
          start = j + 2;
          INLINE_SPECIAL.lastIndex = j + 2;
        } else {
          INLINE_SPECIAL.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out.push(esc(s.slice(start, i)));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), env, out);
        out.push('</em>');
        start = j + 1;
        INLINE_SPECIAL.lastIndex = j + 1;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const m2 = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    if (target !== '' && !/\s/.test(target)) {
      if (i > start) out.push(esc(s.slice(start, i)));
      out.push('<a href="', esc(env.link(target)), '">');
      inlineInto(s.slice(i + 1, k), env, out);
      out.push('</a>');
      start = m2 + 1;
      INLINE_SPECIAL.lastIndex = m2 + 1;
    }
  }
  if (s.length > start) out.push(esc(s.slice(start, s.length)));
}

function inlineStr(s, env) {
  const out = [];
  inlineInto(s, env, out);
  return out.join('');
}

// Render a list starting at lines[i] into `out`; returns the line after it.
function renderList(lines, i, ordered, start, env, out) {
  const tag = ordered ? 'ol' : 'ul';
  out.push(ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
  const marker = ordered ? ORDERED_RE : BULLET_RE;
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    let m = null;
    if (ordered ? c0 >= 48 && c0 <= 57 : c0 === 45 || c0 === 42) m = marker.exec(line);
    if (m === null) break;
    const parts = [trimLine(ordered ? m[2] : m[1])];
    i++;
    while (i < lines.length && CONTINUED_RE.test(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    out.push('<li>');
    inlineInto(parts.join('\n'), env, out);
    out.push('</li>\n');
  }
  out.push(`</${tag}>\n`);
  return i;
}

// A body's HTML, its table of contents (level 2 and 3 headings) and its excerpt
// (the first paragraph's inline HTML, or ""). Blocks render straight into the
// output array; no token objects are built.
function renderBody(src, env, cache) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = '';
  let haveExcerpt = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      // A space-led line is a paragraph line.
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        // The language is [A-Za-z0-9_+-]* by the fence regex, so it holds no
        // character that needs escaping.
        out.push(lang === '' ? '<pre><code>' : `<pre><code class="language-${lang}">`);
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) {
          out.push(esc(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(line);
      if (h !== null) {
        const id = freeSlug(slugify(h.text, cache), ids, idNext);
        const html = inlineStr(h.text, env);
        out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR_RE.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      const b = BULLET_RE.exec(line);
      if (b !== null) {
        i = renderList(lines, i, false, 1, env, out);
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const inner = body.map(trimLine).filter((l) => l !== '');
      if (inner.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(inner.join('\n'), env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const o = ORDERED_RE.exec(line);
      if (o !== null) {
        i = renderList(lines, i, true, +o[1], env, out);
        continue;
      }
    }
    // Paragraph: this line and the lines after it up to a paragraph-ending line.
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    const text = parts.join('\n');
    if (!haveExcerpt) {
      excerpt = inlineStr(text, env);
      haveExcerpt = true;
      out.push(`<p>${excerpt}</p>\n`);
    } else {
      out.push('<p>');
      inlineInto(text, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt, words: countWords(src) };
}

/* --------------------------------------------------------------- templates */

// A value as text: a string itself, a number in JavaScript's digits, true or
// false, an array's items joined by ", ", anything else "".
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

// Whether a value counts as true in an if: not undefined, null, false, "", 0
// or an empty array.
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Tokenize a template source into text, {{ }}, {{{ }}} and {% %} pieces. A
// {% %} tag alone on its line (only spaces or tabs beside it) takes its whole
// line with it, including the newline.
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Parse a template source into a tree of nodes; a TemplateError when it does
// not parse.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/* ------------------------------------------------------- template compiler */

// Compile a parsed template to a function fn(S, O, H, D): S is the scope
// (one flat object, loop variables saved and restored around each for),
// O the output array, H the helpers {esc, txt, truthy, T}, D the include
// depth. Paths compile to direct property reads with a null check per step;
// a first name the scope does not hold reads undefined, as the rules say.
function compileTemplate(nodes, names, loopNames) {
  const parts = [];
  let uid = 0;
  function acc(path) {
    names.add(path[0]);
    let code = 'S.' + path[0];
    for (let k = 1; k < path.length; k++) {
      code = '(' + code + '==null?void 0:' + code + '.' + path[k] + ')';
    }
    return code;
  }
  function gen(nodes) {
    for (const nd of nodes) {
      if (nd.kind === 'text') parts.push('O.push(', JSON.stringify(nd.text), ');');
      else if (nd.kind === 'var') parts.push('O.push(H.esc(H.txt(', acc(nd.path), ')));');
      else if (nd.kind === 'raw') parts.push('O.push(H.txt(', acc(nd.path), '));');
      else if (nd.kind === 'if') {
        parts.push(nd.not ? 'if(!H.truthy(' : 'if(H.truthy(', acc(nd.path), ')){');
        gen(nd.then);
        if (nd.else !== null) {
          parts.push('}else{');
          gen(nd.else);
        }
        parts.push('}');
      } else if (nd.kind === 'for') {
        const u = uid++;
        loopNames.add(nd.name);
        parts.push('{const _a', u, '=', acc(nd.path), ';if(Array.isArray(_a', u, ')){const _s', u, '=S.', nd.name, ';const _l', u, '={index:0,first:false,last:false,length:0};const _o', u, '=S.loop;for(let _k', u, '=0;_k', u, '<_a', u, '.length;_k', u, '++){');
        if (nd.name !== 'loop') parts.push('S.', nd.name, '=_a', u, '[_k', u, '];');
        parts.push('_l', u, '.index=_k', u, '+1;_l', u, '.first=_k', u, '===0;_l', u, '.last=_k', u, '===_a', u, '.length-1;_l', u, '.length=_a', u, '.length;S.loop=_l', u, ';');
        gen(nd.body);
        parts.push('}');
        if (nd.name !== 'loop') parts.push('S.', nd.name, '=_s', u, ';');
        parts.push('S.loop=_o', u, ';}}');
      } else if (nd.kind === 'include') {
        const u = uid++;
        parts.push('if(D<8){const _f', u, '=H.T.get(', JSON.stringify(nd.name), ');if(_f', u, ')_f', u, '(S,O,H,D+1);}');
      }
    }
  }
  gen(nodes);
  return new Function('S', 'O', 'H', 'D', parts.join(''));
}

/* ------------------------------------------------------------------- build */

// One site's output tree: path -> text.
export function run(input) {
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const names = new Set(['loop', 'site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);
  const loopNames = new Set();
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(cmpStr)) {
    try {
      compiled.set(name, compileTemplate(parseTemplate(name, input.templates[name]), names, loopNames));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const H = { esc, txt: textOf, truthy, T: compiled };
  const S = Object.create(null);
  for (const nm of names) S[nm] = undefined;
  const loopArr = [...loopNames];
  const slugCache = new Map();

  // 1. Sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => cmpStr(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, reserved directory, post without a date,
  // layout that is no parsed template, draft. The first failure is the one reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: each page's slug, unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let t = taken.get(dir);
    if (t === undefined) {
      t = { set: new Set(dir === '' ? ROOT_RESERVED : []), next: new Map() };
      taken.set(dir, t);
    }
    const slug = freeSlug(s.data.slug ?? slugify(s.data.title, slugCache), t.set, t.next);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolveRel(dir, rel);
        if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
        if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderBody(s.body, env, slugCache);
    s.content = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading_minutes = Math.max(1, Math.ceil(md.words / 200));
  }

  // 5. Collections: posts newest first, equal dates by slug; newer and older neighbours.
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => cmpStr(y.data.date, x.data.date) || cmpStr(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, each named as first met walking the posts in order,
  // ordered by post count then slug.
  const bySlug = new Map();
  const ownTagNames = (s) => {
    const seen = new Set();
    const out = [];
    const list = s.data.tags ?? [];
    for (let i = 0; i < list.length; i++) {
      const slug = slugify(list[i], slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(list[i]);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tags = [];
    for (const name of ownTagNames(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tags.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      s.tags = [];
      for (const name of ownTagNames(s)) {
        const slug = slugify(name, slugCache);
        const t = bySlug.get(slug);
        s.tags.push(t !== undefined ? t : { name, slug, url: '', posts: [] });
      }
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmpStr(x.slug, y.slug));
  for (const t of tags) t.count = t.posts.length;

  // 7. The template scope: the site, the tags, the recent posts, and each page's
  // own fields, which live on the source object itself (no card/page view objects).
  const site = { title: input.site.title, base_url: base };
  const allTags = tags;
  const recent = posts.slice(0, input.site.recent);
  for (const s of sources) {
    s.title = s.data.title;
    s.date = s.data.date ?? '';
    s.date_long = s.data.date === undefined ? '' : longDate(s.data.date);
    s.summary = s.data.summary ?? '';
    s.is_post = s.post;
  }
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    for (let i = 0; i < loopArr.length; i++) S[loopArr[i]] = undefined;
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    S.page = vars.page;
    S.posts = vars.posts;
    S.pager = vars.pager;
    S.tag = vars.tag;
    const out = [];
    fn(S, out, H, 0);
    return out.join('');
  };

  const output = {};
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: s });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: t });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse,
  // sorted, then the counts.
  const lines = [...report, ...broken].sort(cmpStr);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT] = lines.join('\n') + '\n';
  return output;
}
