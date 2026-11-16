// parse.js — a fast Markdown renderer whose parse(markdown) returns exactly the HTML
// that marked 18.1.3 renders with its default options (gfm on, breaks off).
// Written from scratch as a single-pass scanner: an index-based block scanner and an
// index-based inline scanner, no token tree, no dependencies, no caching across calls.

/* ---------------- small helpers ---------------- */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC_TEST = /[&<>"']/;
const RE_ESC_REPLACE = /[&<>"']/g;
const RE_ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ESC_REPLACE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMREF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML. encode=true escapes every &; false leaves & that starts a valid entity.
function esc(s, encode) {
  if (encode) {
    return RE_ESC_TEST.test(s) ? s.replace(RE_ESC_REPLACE, (c) => ESC_MAP[c]) : s;
  }
  return RE_ESC_TEST_NOENC.test(s) ? s.replace(RE_ESC_REPLACE_NOENC, (c) => ESC_MAP[c]) : s;
}

// Decode numeric character references; a bare & that is not a reference becomes &amp;.
function unesc(s) {
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Encode a URL the way a browser address bar would; null when it cannot be encoded.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link reference label: trim, collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing copies of ch from s.
function rtrimChar(s, ch) {
  let i = s.length;
  while (i > 0 && s.charAt(i - 1) === ch) i--;
  return s.slice(0, i);
}

// Strip trailing characters that are not ch from s.
function rtrimNotChar(s, ch) {
  let i = s.length;
  while (i > 0 && s.charAt(i - 1) !== ch) i--;
  return s.slice(0, i);
}

// Drop trailing blank lines when there are more than one of them.
function trimTrailBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Find the index of the close paren/bracket matching the opens in s, skipping
// backslash escapes. -1 when there is none, -2 when an opener is left unclosed.
function findClose(s, open, close) {
  if (s.indexOf(open) === -1 && s.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, counting columns from col.
function expandTabs(s, col) {
  let out = '';
  let n = col;
  for (const ch of s) {
    if (ch === '\t') {
      const r = 4 - (n % 4);
      out += ' '.repeat(r);
      n += r;
    } else {
      out += ch;
      n++;
    }
  }
  return out;
}

const isSpaceTab = (c) => c === ' ' || c === '\t';
const isBlankLine = (line) => /^[ \t]*$/.test(line);

/* ---------------- regex pieces (composed like a grammar) ---------------- */

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// A line that starts a thematic break (capturing, for standalone use).
const SRC_HR = ' {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
// The same, with no capturing group, for use inside lookaheads.
const SRC_HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
// A line that starts an ATX heading.
const SRC_HEADING = ' {0,3}#{1,6}(?:\\s|$)';
// A line that starts a fenced code block, with the rest of its line.
const SRC_FENCES_LINE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
// A line that starts a block quote.
const SRC_BLOCKQUOTE = ' {0,3}>';
// A list marker that interrupts a paragraph at the top level (any bullet, or 1. / 1)).
const SRC_LIST_TOP = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
// A list marker that interrupts a paragraph anywhere.
const SRC_LIST_ANY = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
// A line that starts an HTML block.
const SRC_HTML_BEGIN =
  ' {0,3}(?:</?(?:' +
  BLOCK_TAGS +
  ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
// A paragraph: a run of lines none of which starts another block.
function paraSrc(listSrc, tableSrc) {
  return (
    '([^\\n]+(?:\\n(?!' +
    SRC_HR_NC +
    '|' +
    SRC_HEADING +
    '|' +
    SRC_BLOCKQUOTE +
    '|' +
    SRC_FENCES_LINE +
    '|' +
    listSrc +
    '|' +
    SRC_HTML_BEGIN +
    (tableSrc ? '|' + tableSrc : '') +
    '|[ \\t]+\\n)[^\\n]+)*)'
  );
}

// A setext heading: text lines, then a line of = or -.
function lheadingSrc(tableSrc) {
  const bull = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
  const blockCode = '(?: {4}| {0,3}\\t)';
  const fences = ' {0,3}(?:`{3,}|~{3,})';
  const html1 = ' {0,3}<[^\\n>]+>\\n';
  const inner =
    '(?:.|\\n(?!\\s*?\\n|' +
    bull +
    ' |' +
    fences +
    '|' +
    SRC_BLOCKQUOTE +
    '|' +
    SRC_HEADING +
    '|' +
    SRC_HR_NC +
    '|' +
    html1 +
    (tableSrc ? '|' + tableSrc : '') +
    '))+?';
  return (
    '(?!' +
    bull +
    ' |' +
    blockCode +
    '|' +
    fences +
    '|' +
    SRC_BLOCKQUOTE +
    '|' +
    SRC_HEADING +
    '|' +
    html1 +
    (tableSrc ? '|' + tableSrc : '') +
    ')(' +
    inner +
    ')' +
    '\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)'
  );
}

// A table: header line, delimiter line, body lines.
function tableSrc() {
  const bodyLine =
    '(?:(?! *\\n|' +
    SRC_HR_NC +
    '|' +
    SRC_HEADING +
    '|' +
    SRC_BLOCKQUOTE +
    '|(?: {4}| {0,3}\\t)[^\\n]|' +
    SRC_FENCES_LINE +
    '|' +
    SRC_LIST_TOP.replace('[ \\t]+[^ \\t\\n]', '[ \\t]') +
    '|' +
    SRC_HTML_BEGIN +
    ').*(?:\\n|$))*';
  return (
    ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n(' +
    bodyLine +
    ')\\n*|$)'
  );
}
const SRC_TABLE = tableSrc();

// Block-quote lines: a run of > lines, where a > line's paragraph may swallow
// following lazy lines.
const SRC_PARA_IN_BQ = paraSrc(SRC_LIST_ANY, null);
const SRC_BLOCKQUOTE_RUN =
  '( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))' +
  SRC_PARA_IN_BQ +
  '|[^\\n]*)(?:\\n|$))+';

// An HTML block, all seven kinds.
const SRC_HTML_COMMENT = '<!--(?:-?>|[\\s\\S]*?(?:-->|$))';
const SRC_HTML_ATTR = ' +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?';
const SRC_HTML_BLOCK =
  ' {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
  '|' +
  SRC_HTML_COMMENT +
  '[^\\n]*(\\n+|$)' +
  '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
  '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
  '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
  '|</?(?:' +
  BLOCK_TAGS +
  ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:' +
  SRC_HTML_ATTR +
  ')*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)' +
  '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))';

// A link reference definition: [label]: destination "title".
const SRC_LABEL_INNER = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const SRC_DEF_TITLE = '(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))';
const SRC_DEF =
  ' {0,3}\\[' + '(' + SRC_LABEL_INNER + ')' + '\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' +
  SRC_DEF_TITLE +
  '))? *(?:\\n+|$)';

// A list item's first line.
const SRC_LIST_START = '( {0,3}(?:[*+-]|\\d{1,9}[.)]))([ \\t][^\\n]*?)?(?:\\n|$)';

/* Block regexes. Sticky (y): they match at the current position only, with no
   string slicing, so the ^ anchor is unnecessary. */
const B_NEWLINE = /(?:[ \t]*(?:\n|$))+/y;
const B_CODE = /((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/y;
const B_FENCES =
  / {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/y;
const B_HR = new RegExp(SRC_HR, 'y');
const B_HEADING = / {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/y;
const B_BLOCKQUOTE = new RegExp(SRC_BLOCKQUOTE_RUN, 'y');
const B_LIST = new RegExp(SRC_LIST_START, 'y');
const B_HTML = new RegExp(SRC_HTML_BLOCK, 'iy');
const B_DEF = new RegExp(SRC_DEF, 'y');
const B_TABLE = new RegExp(SRC_TABLE, 'y');
const B_LHEADING = new RegExp(lheadingSrc(' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n'), 'y');
const B_PARA = new RegExp(paraSrc(SRC_LIST_TOP, SRC_TABLE), 'y');
const B_TEXT = /[^\n]+/y;

// List item helpers, built per indentation. The block-start checks only ever
// see 0..3 spaces of indent (marked's D helper clamps there), so one regex
// per indent is built once and reused instead of compiled per list item.
const RE_LIST_ITEM = (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
const _at = (n, fn) => [0, 1, 2, 3].map(fn);
const RE_NEXT_BULLET = _at(0, (n) =>
  new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const RE_HR_AT = _at(0, (n) =>
  new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const RE_FENCES_AT = _at(0, (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const RE_HEADING_AT = _at(0, (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const RE_HTML_AT = _at(0, (n) =>
  new RegExp(
    `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
    'i',
  ));
const RE_BLOCKQUOTE_AT = _at(0, (n) => new RegExp(`^ {0,${n}}>`));
const ITEM_RE_CACHE = new Map();
// ASCII char-class table for the email-local check that runs on every
// character of plain text (a regex .test there is the hottest spot).
const CC_EMAIL_LOCAL = new Uint8Array(128);
for (const _c of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-")
  CC_EMAIL_LOCAL[_c.charCodeAt(0)] = 1;
const isEmailLocalCh = (ch) => {
  const c = ch.charCodeAt(0);
  return c < 128 && CC_EMAIL_LOCAL[c] === 1;
};
const RE_LHEADING_PLAIN = /^(.*)\n {0,3}(=+|-+) *(?:\n+|$)/;

/* Inline regexes. */
const I_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const I_CODE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const I_BR = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const I_TAG =
  /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const I_AUTOLINK =
  /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const RE_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const SRC_LINK_LABEL =
  '(?:\\[(?:' +
  RE_BRACKETS.source +
  '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const SRC_LINK_HREF = '<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\))';
const SRC_LINK_TITLE = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)';
const I_LINK = new RegExp(
  '!?\\[(' + SRC_LINK_LABEL + ')\\]\\([ \\t\\n]*(' + SRC_LINK_HREF + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + SRC_LINK_TITLE + '))?[ \\t\\n]*\\)',
  'y',
);
const I_REFLINK = new RegExp(
  '!?\\[(' + SRC_LINK_LABEL + ')\\]\\[(' + SRC_LABEL_INNER + ')\\]',
  'y',
);
const I_NOLINK = new RegExp('!?\\[(' + SRC_LABEL_INNER + ')\\](?:\\[\\])?', 'y');
// Emphasis delimiters. The left one matches a run of * or _ plus the next char;
// the right ones scan for a run that can close, with groups marking what it can do.
const I_EM_L =
  /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/yu;
const RE_R_AST =
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const RE_R_UND =
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const RE_R_DEL =
  '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
function rDelim(template, notPunctSpace, punctSpace, punct) {
  return new RegExp(
    template
      .replace(/notPunctSpace/g, notPunctSpace)
      .replace(/punctSpace/g, punctSpace)
      .replace(/punct/g, punct),
    'gu',
  );
}
// GFM: a ~ never counts as punctuation or as a word character for emphasis.
const I_EM_R_AST = rDelim(RE_R_AST, '(?:[^\\s\\p{P}\\p{S}]|~)', '(?!~)[\\s\\p{P}\\p{S}]', '(?!~)[\\p{P}\\p{S}]');
const I_EM_R_UND = rDelim(RE_R_UND, '(?:[^\\s\\p{P}\\p{S}]|~)', '(?!~)[\\s\\p{P}\\p{S}]', '(?!~)[\\p{P}\\p{S}]');
const I_DEL_L = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/yu;
const I_DEL_R = rDelim(RE_R_DEL, '[^\\s\\p{P}\\p{S}]', '[\\s\\p{P}\\p{S}]', '[\\p{P}\\p{S}]');
const I_URL = new RegExp(
  '(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))',
  'y',
);
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const I_ANY_PUNCT = /\\([\p{P}\p{S}])/gu;
const I_ANY_PUNCT_OUT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const I_PUNCT = /((?![*_])[\s\p{P}\p{S}])/u;
const I_PUNCT_CHAR = /[\p{P}\p{S}]/u;
const RE_ALNUM = /[\p{L}\p{N}]/u;
// Patterns used to mask links, code spans and punctuation before scanning for
// emphasis closers, so a * inside a code span or a link never counts as one.
const I_BLOCKSKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(`+)[^`]+\\1(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)(`+)[^`]+\\2(?!`)|<(?! )[^<>]*?>',
  'g',
);
const SRC_LONG_LABEL =
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:' +
  RE_BRACKETS.source +
  '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
const SRC_REF_SHORT = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const I_REFLINK_SEARCH = new RegExp(
  '!?\\[(' +
  SRC_LONG_LABEL +
  ')\\]\\[(' +
  SRC_REF_SHORT +
  ')\\]|!?\\[(' +
  SRC_REF_SHORT +
  ')\\](?:\\[\\])?(?!\\()',
  'g',
);
const RE_EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]/;
const RE_SCHEME = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;
const RE_WWW = /^www\./;

/* ---------------- inline rendering ---------------- */

// Run a sticky regex at position pos of s. Always sets lastIndex first.
function at(re, s, pos) {
  re.lastIndex = pos;
  return re.exec(s);
}

const RE_ALNUM_CHAR = /[a-zA-Z0-9]/;
const RE_WORD_CHAR = /[A-Za-z0-9_]/;
const RE_DOMAIN_CHAR = /[a-zA-Z0-9-_]/;
const RE_WS = /\s/;

// Does a URL scheme (http://, https://, ftp://) start at i?
function isSchemeAt(s, i) {
  const c0 = s[i];
  if (c0 === 'h' || c0 === 'H') {
    if (
      (s[i + 1] === 't' || s[i + 1] === 'T') &&
      (s[i + 2] === 't' || s[i + 2] === 'T') &&
      (s[i + 3] === 'p' || s[i + 3] === 'P')
    ) {
      if (s[i + 4] === ':' && s[i + 5] === '/' && s[i + 6] === '/') return true;
      if (
        (s[i + 4] === 's' || s[i + 4] === 'S') &&
        s[i + 5] === ':' &&
        s[i + 6] === '/' &&
        s[i + 7] === '/'
      )
        return true;
    }
  } else if (c0 === 'f' || c0 === 'F') {
    if (
      (s[i + 1] === 't' || s[i + 1] === 'T') &&
      (s[i + 2] === 'p' || s[i + 2] === 'P') &&
      s[i + 3] === ':' &&
      s[i + 4] === '/' &&
      s[i + 5] === '/'
    )
      return true;
  }
  return false;
}

// Does a link start inside s (used while masking link text for emphasis)?
function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(I_BLOCKSKIP)) {
    I_LINK.lastIndex = 0;
    if (I_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(I_REFLINK_SEARCH)) {
    const r = m[0];
    const o = r.lastIndexOf('[');
    if (
      !(r.charAt(0) === '!' || !Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) &&
      !(o > 1 && linkInText(r.slice(1, o - 1), links))
    )
      return true;
  }
  return false;
}

// Mask links, code spans and punctuation in src so that a * or _ inside one of
// them is never mistaken for an emphasis delimiter. Length-preserving.
function maskSource(src, links) {
  // Nothing to mask unless the source holds a backtick, backslash, [ or <.
  if (!/[`\\[<]/.test(src)) return src;
  let t = src;
  if (links && src.includes('[')) {
    const replaceFn = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(I_REFLINK_SEARCH, replaceFn) + '][' + 'a'.repeat(m.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(I_REFLINK_SEARCH, replaceFn);
  }
  t = t.replace(I_ANY_PUNCT_OUT, (n, s, r) =>
    r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n,
  );
  t = t.replace(I_BLOCKSKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  return t;
}

// Scan the masked source for the last delimiter run of each kind that could
// close an emphasis or a strikethrough: a run whose preceding character is not
// a space, tab, newline, carriage return or form feed.
function lastCloserScan(mask) {
  const out = { '*': -1, _: -1, del: -1 };
  for (const d of ['*', '_', '~']) {
    let idx = mask.lastIndexOf(d);
    while (idx !== -1) {
      let start = idx;
      while (start > 0 && mask[start - 1] === d) start--;
      // A run at position 0 is preceded by a newline (not a valid closer),
      // and it is also the only run, so there is nothing earlier to try.
      if (start === 0) break;
      const prev = mask[start - 1];
      if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
        out[d === '~' ? 'del' : d] = start;
        break;
      }
      idx = mask.lastIndexOf(d, start - 1);
    }
  }
  return out;
}

// Try to read an emphasis span starting at pos. Returns {end, inner, strong}
// or null. mask is the masked source, lastEm the last-possible-closer indexes.
function tryEmStrong(src, pos, mask, prevCh, lastEm) {
  const m = at(I_EM_L, src, pos);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const dch = m[0][0];
  const samePrev = prevCh === dch;
  const i = pos;
  let l = i;
  while (l > 0 && mask[l - 1] === dch) l--;
  const p = [...mask.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const isPunctP = p === '*' || p === '_' || I_PUNCT.test(p);
  let n = prevCh;
  if (l < i) n = p;
  const u = l < i ? isPunctP : I_PUNCT.test(n);
  if (m[4] && RE_ALNUM.test(n)) return null;
  const d = m[1] || m[3] || '';
  if (!d || !n || u) {
    const k = [...m[0]].length - 1;
    let mm = k;
    let f = 0;
    const y = i - l + k;
    const canOpen = !!p.trim() && (!!d || (dch === '*' && !isPunctP));
    if (dch !== '*' && dch !== '_') return null;
    const rDelim = dch === '*' ? I_EM_R_AST : I_EM_R_UND;
    const v = lastEm[dch];
    const q = i + k;
    if (v < q) return null;
    const sub = mask.slice(q);
    const ee = v - q;
    rDelim.lastIndex = 0;
    let s;
    while ((s = rDelim.exec(sub)) !== null && !(s.index > ee)) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b = [...g].length;
      if (s[3] || s[4]) {
        mm += b;
        continue;
      } else if (s[5] || s[6] || canOpen) {
        if (samePrev && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          f += b;
          continue;
        }
      }
      mm -= b;
      if (mm > 0) continue;
      const bb = Math.min(b, b + mm + f);
      const te = [...s[0]][0].length;
      const span = src.slice(pos, pos + k + s.index + te + bb);
      if (Math.min(k, bb) % 2) {
        return { end: pos + span.length, inner: span.slice(1, -1), strong: false };
      }
      return { end: pos + span.length, inner: span.slice(2, -2), strong: true };
    }
  }
  return null;
}

// Try to read a strikethrough span starting at pos.
function tryDel(src, pos, mask, prevCh, lastDel) {
  const m = at(I_DEL_L, src, pos);
  if (!m) return null;
  if (!((m[1] || '') || !prevCh || I_PUNCT.test(prevCh))) return null;
  const o = [...m[0]].length - 1;
  let p = o;
  const u = lastDel;
  const d = pos + o;
  if (u < d) return null;
  const sub = mask.slice(d);
  const k = u - d;
  I_DEL_R.lastIndex = 0;
  let s;
  while ((s = I_DEL_R.exec(sub)) !== null && !(s.index > k)) {
    const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
    if (!g) continue;
    const l = [...g].length;
    if (l !== o) continue;
    if (s[3] || s[4]) {
      p += l;
      continue;
    }
    p -= l;
    if (p > 0) continue;
    const ll = Math.min(l, l + p);
    const te = [...s[0]][0].length;
    const span = src.slice(pos, pos + o + s.index + te + ll);
    return { end: pos + span.length, inner: span.slice(o, -o) };
  }
  return null;
}

// Does the link text (label) contain an < that starts an HTML tag or autolink
// reaching past the end of the label? Such a link is not emitted.
function hasHtmlAhead(src, pos, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') {
      s++;
      continue;
    }
    if (label[s] === '`') {
      const m = at(I_CODE, label, s);
      if (m) {
        s += m[0].length - 1;
        continue;
      }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(pos + off + s);
    const o = at(I_TAG, r, 0) || at(I_AUTOLINK, r, 0);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Build the HTML for a link or image whose label text is match[1]. Returns null
// when a link is suppressed because its label already contains a link.
function outputLink(match, dest, raw, ctx, lpp, plain) {
  const isImage = match[0].charCodeAt(0) === 33;
  const text = match[1].replace(/\\([\[\]])/g, '$1');
  const prevInLink = ctx.inLink;
  const prevEmitted = ctx.linkEmitted;
  const prevRaw = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = inlineHtml(text, ctx, plain || isImage, lpp && text.includes(')'));
  const emitted = ctx.linkEmitted;
  ctx.linkEmitted = prevEmitted;
  ctx.inLink = prevInLink;
  if (!isImage) {
    if (emitted) {
      ctx.inRawBlock = prevRaw;
      return null;
    }
    ctx.linkEmitted = true;
  }
  if (plain) return inner;
  const href = cleanUrl(dest.href);
  if (isImage) {
    if (href === null) return esc(inner);
    let out = '<img src="' + esc(href) + '" alt="' + esc(inner) + '"';
    if (dest.title) out += ' title="' + esc(dest.title) + '"';
    return out + '>';
  }
  if (href === null) return inner;
  let out = '<a href="' + esc(href) + '"';
  if (dest.title) out += ' title="' + esc(dest.title) + '"';
  return out + '>' + inner + '</a>';
}

// Render an autolink (<scheme:...> or <email>), or an extended autolink.
function renderAutolink(text, href, plain) {
  if (plain) return text;
  const inner = esc(text, true);
  const cleaned = cleanUrl(href);
  if (cleaned === null) return inner;
  return '<a href="' + esc(cleaned, true) + '">' + inner + '</a>';
}

// Find where the plain-text run starting at pos ends. It stops before any
// character that can start an inline construct, before a hard break, and
// Find the first word at or after pos that is followed by @ (an email
// candidate). Walks back from the first @ instead of scanning every word.
function emailStart(src, pos, n) {
  let at = src.indexOf('@', pos);
  while (at !== -1 && at < n) {
    let w = at;
    while (w > pos && isEmailLocalCh(src[w - 1])) w--;
    if (w > pos || pos === 0 || !isEmailLocalCh(src[pos - 1])) return w;
    at = src.indexOf('@', at + 1);
  }
  return -1;
}

const RE_TEXT_STOP = /[\\<!\[`*_~]| {2,}\n|www\.|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|mailto:|xmpp:/g;

// End of the plain-text run starting at pos: the next special character, hard
// break, or URL/email start. One regex scan replaces the per-character loop.
function scanTextEnd(src, pos, n, inLink) {
  let end = n;
  if (!inLink) {
    const em = emailStart(src, pos, n);
    if (em !== -1) end = em;
  }
  RE_TEXT_STOP.lastIndex = pos;
  let m;
  while ((m = RE_TEXT_STOP.exec(src)) !== null) {
    const idx = m.index;
    if (idx >= end) break;
    const tok = m[0];
    if (tok.length === 1) {
      end = idx;
      break;
    }
    if (tok.charCodeAt(0) === 32) {
      // Hard break: 2+ spaces + newline, remainder not blank.
      let k = idx + tok.length;
      while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
      if (k < n) {
        end = idx;
        break;
      }
      RE_TEXT_STOP.lastIndex = idx + tok.length;
      continue;
    }
    if (inLink) {
      RE_TEXT_STOP.lastIndex = idx + tok.length;
      continue;
    }
    if (tok === 'www.') {
      const prev = idx === 0 ? '' : src[idx - 1];
      if (
        idx === 0 ||
        RE_WS.test(prev) ||
        prev === '*' ||
        prev === '_' ||
        prev === '~' ||
        prev === '(' ||
        prev === ']'
      ) {
        end = idx;
        break;
      }
      RE_TEXT_STOP.lastIndex = idx + tok.length;
      continue;
    }
    if (tok === 'mailto:' || tok === 'xmpp:') {
      if (idx > 0 && !RE_ALNUM_CHAR.test(src[idx - 1])) {
        end = idx;
        break;
      }
      RE_TEXT_STOP.lastIndex = idx + tok.length;
      continue;
    }
    // Scheme (http://, https://, ftp://): always a stop.
    end = idx;
    break;
  }
  return end;
}

// Render inline markdown to HTML. ctx carries the lexer state shared with
// nested renders (inLink, inRawBlock, linkEmitted) and the link definitions.
// plain renders to plain text (image alt text). lpp says a link may follow.
function inlineHtml(src, ctx, plain, lpp) {
  const n = src.length;
  if (n === 0) return '';
  const linkParen = lpp === undefined ? src.includes(')') : lpp;
  let mask = null;
  let lastEm = null;
  let lastDel = -1;
  if (/[*_~]/.test(src)) {
    mask = maskSource(src, ctx.links);
    lastEm = lastCloserScan(mask);
    lastDel = lastEm.del;
  }
  const out = [];
  let pos = 0;
  let textStart = 0;
  const flush = (end) => {
    if (end <= textStart) {
      textStart = end;
      return;
    }
    const raw = src.slice(textStart, end);
    if (plain) out.push(ctx.inRawBlock || !raw.includes('&') ? raw : unesc(raw));
    else
      out.push(
        ctx.inRawBlock || !RE_ESC_TEST.test(raw) ? raw : esc(unesc(raw)),
      );
    textStart = end;
  };
  // The last character of the text run just before this position, or ''.
  const prevChar = () => {
    if (textStart >= pos) return '';
    const c = src[pos - 1];
    return c === '_' ? '' : c;
  };
  while (pos < n) {
    const c = src[pos];
    // --- escape: \ followed by ASCII punctuation ---
    if (c === '\\') {
      const m = at(I_ESCAPE, src, pos);
      if (m) {
        flush(pos);
        out.push(plain ? m[1] : esc(m[1]));
        pos += m[0].length;
        textStart = pos;
        continue;
      }
    }
    // --- inline HTML tag ---
    if (c === '<') {
      const m = at(I_TAG, src, pos);
      if (m) {
        flush(pos);
        if (!ctx.inLink && /^<a /i.test(m[0])) ctx.inLink = true;
        else if (ctx.inLink && /^<\/a>/i.test(m[0])) ctx.inLink = false;
        if (!ctx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = true;
        else if (ctx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) ctx.inRawBlock = false;
        out.push(m[0]);
        pos += m[0].length;
        textStart = pos;
        continue;
      }
    }
    // --- links and images: [text](href), ![alt](href) ---
    if (c === '[' || (c === '!' && src[pos + 1] === '[')) {
      if (linkParen) {
        const m = at(I_LINK, src, pos);
        if (m) {
          const off = m[0].charCodeAt(0) === 33 ? 2 : 1;
          if (!hasHtmlAhead(src, pos, m[1], off)) {
            let hrefPart = m[2].trim();
            let bad = false;
            if (hrefPart.charCodeAt(0) === 60) {
              if (!hrefPart.endsWith('>')) bad = true;
              else {
                const l = rtrimChar(hrefPart.slice(0, -1), '\\');
                if ((hrefPart.length - l.length) % 2 === 0) bad = true;
              }
            } else {
              const l = findClose(m[2], '(', ')');
              if (l === -2) bad = true;
              else if (l > -1) {
                const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + l;
                m[2] = m[2].substring(0, l);
                m[0] = m[0].substring(0, h).trim();
                m[3] = '';
              }
            }
            if (!bad) {
              const r = rtrimChar(m[0].slice(0, -1), '\\');
              if ((m[0].length - r.length) % 2 === 0) bad = true;
            }
            if (!bad) {
              let href = m[2].trim();
              if (href.charCodeAt(0) === 60) href = href.slice(1, -1);
              const title = m[3] ? m[3].slice(1, -1) : '';
              const html = outputLink(
                m,
                { href: href.replace(I_ANY_PUNCT, '$1'), title: title.replace(I_ANY_PUNCT, '$1') },
                m[0],
                ctx,
                linkParen,
                plain,
              );
              if (html !== null) {
                flush(pos);
                out.push(html);
                pos += m[0].length;
                textStart = pos;
                continue;
              }
            }
          }
        }
      }
      // --- reference links: [text][label], [text][], [text] ---
      const m2 = at(I_REFLINK, src, pos) || at(I_NOLINK, src, pos);
      if (m2) {
        const off = m2[0].charCodeAt(0) === 33 ? 2 : 1;
        if (!hasHtmlAhead(src, pos, m2[1], off)) {
          const dest = ctx.links[normLabel(m2[2] || m2[1])];
          if (!dest) {
            // No such definition: only the first character is literal text.
            pos += 1;
            continue;
          }
          const html = outputLink(m2, dest, m2[0], ctx, linkParen, plain);
          if (html !== null) {
            flush(pos);
            out.push(html);
            pos += m2[0].length;
            textStart = pos;
            continue;
          }
        }
      }
    }
    // --- emphasis and strong ---
    if (c === '*' || c === '_') {
      if (mask !== null) {
        const em = tryEmStrong(src, pos, mask, prevChar(), lastEm);
        if (em) {
          flush(pos);
          const inner = inlineHtml(em.inner, ctx, plain, linkParen && em.inner.includes(')'));
          out.push(plain ? inner : em.strong ? '<strong>' + inner + '</strong>' : '<em>' + inner + '</em>');
          pos = em.end;
          textStart = pos;
          continue;
        }
      }
    }
    // --- code span ---
    if (c === '`') {
      const m = at(I_CODE, src, pos);
      if (m) {
        flush(pos);
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32) {
          text = text.substring(1, text.length - 1);
        }
        out.push(plain ? text : '<code>' + esc(text, true) + '</code>');
        pos += m[0].length;
        textStart = pos;
        continue;
      }
      // No closing run: the whole backtick run is literal text.
      let j = pos;
      while (j < n && src[j] === '`') j++;
      pos = j;
      continue;
    }
    // --- hard break: two or more spaces, or a backslash, before a newline ---
    if (c === ' ' || c === '\\') {
      const m = at(I_BR, src, pos);
      if (m) {
        flush(pos);
        if (!plain) out.push('<br>');
        pos += m[0].length;
        textStart = pos;
        continue;
      }
    }
    // --- strikethrough ---
    if (c === '~') {
      if (mask !== null) {
        const d = tryDel(src, pos, mask, prevChar(), lastDel);
        if (d) {
          flush(pos);
          const inner = inlineHtml(d.inner, ctx, plain, linkParen && d.inner.includes(')'));
          out.push(plain ? inner : '<del>' + inner + '</del>');
          pos = d.end;
          textStart = pos;
          continue;
        }
      }
      let j = pos;
      while (j < n && src[j] === '~') j++;
      pos = j;
      continue;
    }
    // --- autolinks: <scheme:...> and <email> ---
    if (c === '<') {
      const m = at(I_AUTOLINK, src, pos);
      if (m) {
        flush(pos);
        const text = m[1];
        const href = m[2] === '@' ? 'mailto:' + text : text;
        out.push(renderAutolink(text, href, plain));
        pos += m[0].length;
        textStart = pos;
        continue;
      }
    }
    // --- extended autolinks: www., http://, emails ---
    if (!ctx.inLink && isEmailLocalCh(c)) {
      const m = at(I_URL, src, pos);
      if (m) {
        flush(pos);
        let text, href;
        if (m[2] === '@') {
          text = m[0];
          href = 'mailto:' + text;
        } else {
          let raw = m[0];
          let prev = raw;
          do {
            prev = raw;
            const b = I_BACKPEDAL.exec(raw);
            raw = b ? b[0] : '';
          } while (raw !== prev);
          text = raw;
          href = m[1] === 'www.' ? 'http://' + raw : raw;
        }
        out.push(renderAutolink(text, href, plain));
        pos += text.length;
        textStart = pos;
        continue;
      }
    }
    // --- plain text run ---
    const end = scanTextEnd(src, pos, n, ctx.inLink);
    if (end > pos) {
      pos = end;
    } else {
      pos += 1;
    }
  }
  flush(n);
  return out.join('');
}

// Render inline markdown to HTML with fresh lexer state.
function renderInline(src, ctx) {
  // Top-level inline render: inRawBlock is reset, inLink persists across
  // renders within one parse (an opening <a> tag suppresses autolinks until
  // a closing </a>), exactly like marked's lexer state.
  ctx.inRawBlock = false;
  return inlineHtml(src, ctx, false, undefined);
}

/* ---------------- block scanning ---------------- */

// Split a table row into cells, handling escaped pipes. With count, the row is
// truncated or padded with empty cells to that many.
function splitCells(s, count) {
  const t = s.replace(/\|/g, (ch, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove the indentation of a fenced code block's opening fence from its lines.
function indentCompensate(fenceBlock, content) {
  const m = /^(\s+)(?:```)/.exec(fenceBlock);
  if (!m) return content;
  const ind = m[1];
  return content
    .split('\n')
    .map((line) => {
      const ws = /^\s+/.exec(line);
      if (!ws) return line;
      return line.slice(Math.min(ws[0].length, ind.length));
    })
    .join('\n');
}

const RE_CHECKBOX = /\[[ xX]\]/;
const RE_TASK_MARKER = /^\[[ xX]\][ \t]+/;
const RE_TASK_TEST = /^\[[ xX]\][ \t]+\S/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANY_LINE = /\n.*\n/;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_STRIP = /^ {0,3}>[ \t]?/gm;
const RE_BQ_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const RE_LEADING_WS = /^[ \t]+/;
const RE_NON_SPACE = /[^ ]/;
const RE_LIST_NEST = /^ {1,4}(?=( {4})*[^ ])/g;
const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_ENDING_HASH = /#$/;
const RE_ENDING_WS = /[ \t]$/;
const RE_TABLE_DELIM = /[:|]/;
const RE_TABLE_ALIGN_CHARS = /^\||\| *$/g;
const RE_TABLE_ROW_BLANK = /\n[ \t]*$/;
const RE_ALIGN_RIGHT = /^ *-+: *$/;
const RE_ALIGN_CENTER = /^ *:-+: *$/;
const RE_ALIGN_LEFT = /^ *:-+ *$/;
const RE_HREF_BRACKETS = /^<(.*)>$/;
const RE_ANGLE_START = /^</;
const RE_ANGLE_END = />$/;

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// Scan src into block records, appended to out. ctx carries the link
// definitions, the inline-source list (for task-marker stripping) and the
// top flag (paragraphs only lex at the top of a block context). merge joins
// a paragraph into the previous paragraph record (inside block quotes).
function scanBlocks(src, ctx, out, merge) {
  const links = ctx.links;
  let pos = 0;
  const n = src.length;
  let prevLen = Infinity;
  while (pos < n) {
    if (n - pos >= prevLen) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    prevLen = n - pos;
    let m;
    // Blank lines.
    if ((m = at(B_NEWLINE, src, pos))) {
      pos += m[0].length;
      if (m[0].length !== 1) out.push({ k: 'space', raw: m[0] });
      continue;
    }
    // Indented code. After a paragraph it is absorbed into that paragraph.
    if ((m = at(B_CODE, src, pos))) {
      const raw = trimTrailBlanks(m[0]);
      const text = raw.replace(RE_CODE_INDENT, '');
      pos += raw.length;
      const prev = out[out.length - 1];
      if (prev && (prev.k === 'para' || prev.k === 'text')) {
        prev.src += '\n' + text;
      } else {
        out.push({ k: 'code', text, lang: '' });
      }
      continue;
    }
    // Fenced code.
    if ((m = at(B_FENCES, src, pos))) {
      pos += m[0].length;
      const text = indentCompensate(m[0], m[3] || '');
      const lang = m[2] ? m[2].trim().replace(I_ANY_PUNCT, '$1') : '';
      out.push({ k: 'code', text, lang });
      continue;
    }
    // ATX heading.
    if ((m = at(B_HEADING, src, pos))) {
      let text = m[2].trim();
      if (RE_ENDING_HASH.test(text)) {
        const stripped = rtrimChar(text, '#');
        if (!stripped || RE_ENDING_WS.test(stripped)) text = stripped.trim();
      }
      pos += rtrimChar(m[0], '\n').length;
      const rec = { k: 'heading', depth: m[1].length, src: text };
      out.push(rec);
      ctx.srcList.push(rec);
      continue;
    }
    // Thematic break.
    if ((m = at(B_HR, src, pos))) {
      pos += rtrimChar(m[0], '\n').length;
      out.push({ k: 'hr' });
      continue;
    }
    // Block quote.
    const bq = scanBlockquote(src, pos, ctx);
    if (bq) {
      pos = bq.end;
      out.push(bq.record);
      continue;
    }
    // List.
    const lst = scanList(src, pos, ctx);
    if (lst) {
      pos = lst.end;
      out.push(lst.record);
      continue;
    }
    // HTML block.
    if ((m = at(B_HTML, src, pos))) {
      const text = trimTrailBlanks(m[0]);
      pos += text.length;
      out.push({ k: 'html', text });
      continue;
    }
    // Link reference definition. After a paragraph it is absorbed as text.
    if ((m = at(B_DEF, src, pos))) {
      const raw = rtrimChar(m[0], '\n');
      if (!RE_ANGLE_START.test(m[2]) && findClose(m[2], '(', ')') !== -1) {
        // Not a definition: try the remaining rules at this position.
      } else {
        pos += raw.length;
        const prev = out[out.length - 1];
        if (prev && (prev.k === 'para' || prev.k === 'text')) {
          prev.src += '\n' + raw;
        } else {
          const tag = normLabel(m[1]);
          if (!Object.hasOwn(links, tag)) {
            links[tag] = {
              href: m[2] ? m[2].replace(RE_HREF_BRACKETS, '$1').replace(I_ANY_PUNCT, '$1') : '',
              title: m[3] ? m[3].substring(1, m[3].length - 1).replace(I_ANY_PUNCT, '$1') : m[3],
            };
          }
          out.push({ k: 'def' });
        }
        continue;
      }
    }
    // Table.
    if ((m = at(B_TABLE, src, pos))) {
      if (RE_TABLE_DELIM.test(m[2])) {
        const headerCells = splitCells(m[1]);
        const delimCells = m[2].replace(RE_TABLE_ALIGN_CHARS, '').split('|');
        const bodyLines = m[3] && m[3].trim() ? m[3].replace(RE_TABLE_ROW_BLANK, '').split('\n') : [];
        if (headerCells.length === delimCells.length) {
          pos += rtrimChar(m[0], '\n').length;
          const align = delimCells.map((c) =>
            RE_ALIGN_RIGHT.test(c)
              ? 'right'
              : RE_ALIGN_CENTER.test(c)
                ? 'center'
                : RE_ALIGN_LEFT.test(c)
                  ? 'left'
                  : null,
          );
          const header = headerCells.map((cell, i) => {
            const rec = { src: cell, align: align[i] };
            ctx.srcList.push(rec);
            return rec;
          });
          const rows = bodyLines.map((line) =>
            splitCells(line, headerCells.length).map((cell, i) => {
              const rec = { src: cell, align: align[i] };
              ctx.srcList.push(rec);
              return rec;
            }),
          );
          out.push({ k: 'table', header, rows });
          continue;
        }
      }
      // Not a table: try the remaining rules at this position.
    }
    // Setext heading.
    if ((m = at(B_LHEADING, src, pos))) {
      const text = m[1].trim();
      pos += rtrimChar(m[0], '\n').length;
      const rec = { k: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, src: text };
      out.push(rec);
      ctx.srcList.push(rec);
      continue;
    }
    // Paragraph (only at the top of a block context).
    if (ctx.top && (m = at(B_PARA, src, pos))) {
      let text = m[1];
      if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
      pos += m[0].length;
      const prev = out[out.length - 1];
      if (merge && prev && prev.k === 'para') {
        prev.src += '\n' + text;
      } else {
        const rec = { k: 'para', src: text };
        out.push(rec);
        ctx.srcList.push(rec);
      }
      continue;
    }
    // A single line of text (inside list items and similar).
    if ((m = at(B_TEXT, src, pos))) {
      pos += m[0].length;
      const prev = out[out.length - 1];
      if (prev && prev.k === 'text') {
        prev.src += '\n' + m[0];
      } else {
        const rec = { k: 'text', src: m[0] };
        out.push(rec);
        ctx.srcList.push(rec);
      }
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  ctx.top = true;
  return out;
}

// Scan a block quote starting at pos. Returns {record, end} or null.
function scanBlockquote(src, pos, ctx) {
  const m = at(B_BLOCKQUOTE, src, pos);
  if (!m) return null;
  let lines = rtrimChar(m[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let seen = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) {
        chunk.push(lines[p]);
        seen = true;
      } else if (!seen) {
        chunk.push(lines[p]);
      } else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h
      .replace(RE_BQ_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_STRIP, '');
    raw = raw ? raw + '\n' + h : h;
    text = text ? text + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    scanBlocks(u, ctx, tokens, true);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.k === 'code' || last.k === 'heading' || last.k === 'hr' || last.k === 'html' || last.k === 'table')
      break;
    if (last.k === 'bq') {
      const b = lines.join('\n');
      const mm = last.raw + '\n' + b.replace(RE_BQ_STRIP, '');
      const f = scanBlockquote(mm, 0, ctx);
      if (!f) break;
      tokens[tokens.length - 1] = f.record;
      const y = mm.substring(f.record.raw.length).replace(/^\n/, '');
      const rCount = y ? y.split('\n').length : 0;
      const consumed = rCount ? lines.slice(0, -rCount) : lines;
      if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
      text = text.substring(0, text.length - last.text.length) + f.record.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (last.k === 'list') {
      const b = last.raw + '\n' + lines.join('\n');
      const f = scanList(b, 0, ctx);
      if (!f) break;
      tokens[tokens.length - 1] = f.record;
      let fCount = 0;
      if (f.record.raw.length > last.raw.length) {
        fCount = b.slice(last.raw.length + 1, f.record.raw.length).split('\n').length;
      }
      if (fCount > 0) {
        const y = lines.slice(0, fCount).join('\n');
        raw = raw + '\n' + y;
        text = text + '\n' + y;
      }
      lines = lines.slice(fCount);
      continue;
    }
  }
  return { record: { k: 'bq', blocks: tokens, raw, text }, end: pos + raw.length };
}

// The next line of src starting at pos, without its newline.
// True when a line's first non-space character (within 3 leading spaces) can
// begin a fence, heading, HTML block, blockquote, list item or thematic break.
// Used to skip six regex tests on ordinary continuation lines.
const BLOCK_START_CC = new Uint8Array(128);
for (const _c of '`~#<>*+-0123456789_') BLOCK_START_CC[_c.charCodeAt(0)] = 1;
function mayStartBlock(line) {
  let k = 0;
  while (k < 3 && line.charCodeAt(k) === 32) k++;
  const c = line.charCodeAt(k);
  return c < 128 && BLOCK_START_CC[c] === 1;
}
function lineAt(src, pos) {
  const nl = src.indexOf('\n', pos);
  if (nl === -1) return src.slice(pos);
  return src.slice(pos, nl);
}

// Scan a list starting at pos. Returns {record, end} or null.
function scanList(src, pos, ctx) {
  const m = at(B_LIST, src, pos);
  if (!m) return null;
  const startPos = pos;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    k: 'list',
    ordered,
    start: ordered ? +bullet.slice(0, -1) : '',
    loose: false,
    items: [],
    raw: '',
  };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  let itemRe = ITEM_RE_CACHE.get(bulletPat);
  if (!itemRe) {
    itemRe = new RegExp(`( {0,3}${bulletPat})((?:[\\t ][^\\n]*)?(?:\\n|$))`, 'y');
    ITEM_RE_CACHE.set(bulletPat, itemRe);
  }
  let p = pos;
  let loosePending = false;
  while (p < src.length) {
    let emptyItem = false;
    const itemLines = [];
    const t = at(itemRe, src, p);
    if (!t || at(B_HR, src, p)) break;
    const itemStart = p;
    p += t[0].length;
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let line = g.includes('\t') ? g.replace(RE_LEADING_WS, (v) => expandTabs(v, b)) : g;
    let f = lineAt(src, p);
    const y0 = !line.trim();
    let indent;
    if (y0) {
      indent = b + 1;
    } else {
      indent = line.search(RE_NON_SPACE);
      indent = indent > 4 ? 1 : indent;
      itemLines.push(line.slice(indent));
      indent += b;
    }
    if (y0 && /^[ \t]*$/.test(f)) {
      p += f.length + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      // The block-start checks see at most 3 spaces of indent: a line
      // indented further is item content, not a new block.
      const rn = Math.max(0, Math.min(3, indent - 1));
      const nextBullet = RE_NEXT_BULLET[rn];
      const hrAt = RE_HR_AT[rn];
      const fencesAt = RE_FENCES_AT[rn];
      const headingAt = RE_HEADING_AT[rn];
      const htmlAt = RE_HTML_AT[rn];
      const bqAt = RE_BLOCKQUOTE_AT[rn];
      let y = y0;
      let cur = line;
      while (p < src.length) {
        const u = lineAt(src, p);
        f = u;
        const z = u.includes('\t') ? u.replace(RE_LEADING_WS, (ws) => expandTabs(ws, 0)) : u;
        if (mayStartBlock(f) && (fencesAt.test(f) || headingAt.test(f) || htmlAt.test(f) || bqAt.test(f) || nextBullet.test(f) || hrAt.test(f)))
          break;
        if (z.search(RE_NON_SPACE) >= indent || !f.trim()) {
          itemLines.push(z.slice(indent));
        } else {
          if (
            y ||
            (cur.includes('\t') ? cur.replace(/\t/g, '    ') : cur).search(RE_NON_SPACE) >= 4 ||
            (mayStartBlock(cur) && (fencesAt.test(cur) || headingAt.test(cur) || htmlAt.test(cur) || hrAt.test(cur)))
          )
            break;
          const qe =
            /^ {0,3}(?:=+|-+) *$/.test(f) && at(B_LHEADING, cur + '\n' + f, 0)
              ? '    ' + z.replace(/^ {0,3}/, '')
              : f;
          itemLines.push(qe);
        }
        y = !f.trim();
        p += u.length + 1;
        cur = z.slice(indent);
      }
    }
    const itemRaw = src.slice(itemStart, p);
    const itemText = itemLines.join('\n');
    if (list.loose || (loosePending ? (list.loose = true) : RE_DOUBLE_BLANK.test(itemRaw) && (loosePending = true))) {
      // loose flag updated
    }
    list.items.push({
      task: RE_TASK_TEST.test(itemText),
      loose: false,
      text: itemText,
      raw: itemRaw,
      blocks: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = src.slice(startPos, p).trimEnd();
  // Lex each item's content (not at the top level), and spot blank lines.
  for (const item of list.items) {
    ctx.top = false;
    item.blocks = scanBlocks(item.text, ctx, [], false);
    if (!list.loose) {
      for (const b of item.blocks) {
        if (b.k === 'space' && RE_ANY_LINE.test(b.raw)) {
          list.loose = true;
          break;
        }
      }
    }
  }
  // Task list items: strip the marker and add a checkbox to the first block.
  for (const item of list.items) {
    const first = item.blocks[0];
    if (item.task && first && (first.k === 'text' || first.k === 'para')) {
      for (let g = ctx.srcList.length - 1; g >= 0; g--) {
        if (RE_TASK_TEST.test(ctx.srcList[g].src)) {
          ctx.srcList[g].src = ctx.srcList[g].src.replace(RE_TASK_MARKER, '');
          break;
        }
      }
      const ck = RE_CHECKBOX.exec(item.raw);
      if (ck) {
        item.checked = ck[0] !== '[ ]';
        first.cb = true;
        first.checked = item.checked;
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const b of item.blocks) if (b.k === 'text') b.k = 'para';
    }
  }
  return { record: list, end: startPos + list.raw.length };
}

/* ---------------- rendering ---------------- */

function renderBlocks(blocks, ictx) {
  let out = '';
  for (const b of blocks) {
    switch (b.k) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        const langWord = (b.lang || '').match(/^\S*/)?.[0] || '';
        const body = b.text ? esc(b.text.replace(/\n$/, '') + '\n', true) : '';
        out += langWord
          ? '<pre><code class="language-' + esc(langWord) + '">' + body + '</code></pre>\n'
          : '<pre><code>' + body + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + b.depth + '>' + renderInline(b.src, ictx) + '</h' + b.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'bq':
        out += '<blockquote>\n' + renderBlocks(b.blocks, ictx) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        let items = '';
        for (const it of b.items) items += '<li>' + renderBlocks(it.blocks, ictx) + '</li>\n';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'html':
        out += b.text;
        break;
      case 'table': {
        let head = '';
        for (const c of b.header)
          head +=
            '<th' +
            (c.align ? ' align="' + c.align + '"' : '') +
            '>' +
            renderInline(c.src, ictx) +
            '</th>\n';
        let body = '';
        for (const row of b.rows) {
          let cells = '';
          for (const c of row)
            cells +=
              '<td' +
              (c.align ? ' align="' + c.align + '"' : '') +
              '>' +
              renderInline(c.src, ictx) +
              '</td>\n';
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out +=
          '<table>\n<thead>\n<tr>\n' +
          head +
          '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') +
          '</table>\n';
        break;
      }
      case 'para':
        out += '<p>' + (b.cb ? checkboxHtml(b.checked) : '') + renderInline(b.src, ictx) + '</p>\n';
        break;
      case 'text':
        out += (b.cb ? checkboxHtml(b.checked) : '') + renderInline(b.src, ictx);
        break;
    }
  }
  return out;
}

/* ---------------- entry point ---------------- */

export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const ctx = { links: Object.create(null), srcList: [], top: true };
  const blocks = scanBlocks(src, ctx, [], false);
  // One inline state for the whole document: inLink (and linkEmitted) persist
  // across every inline render, like marked's lexer state.
  const ictx = { links: ctx.links, inLink: false, inRawBlock: false, linkEmitted: false };
  return renderBlocks(blocks, ictx);
}
