// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks,
// V4A patches and JSON text-editor tool calls; finds the lines an edit names
// at the first of three matching tiers (exact, trailing whitespace, both sides
// stripped); and changes every file or none. Node 22, standard library only,
// run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// the last lines below hand over to runner.ts: keep that hand-over and
// runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 error: the line printed on stdout, nothing else. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  without the empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---- files: lines, line break, final break (SPEC.md section 3) ----

interface Split {
  br: string;
  lines: string[];
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinText(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.final ? s.br : '');
}

// ---- matching tiers (SPEC.md section 5) ----

function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** Positions where O occurs in `lines` at one tier, at or after `from`. When
 *  `eofOnly`, only an occurrence ending at the file's last line counts. */
function occurrences(lines: string[], o: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const fl = lines.map((l) => norm(l, tier));
  const ol = o.map((l) => norm(l, tier));
  const end = fl.length - ol.length;
  if (end < 0) return out;
  const start = Math.max(from, 0);
  for (let i = start; i <= end; i++) {
    if (eofOnly && i !== end) continue;
    let ok = true;
    for (let j = 0; j < ol.length; j++) {
      if (fl[i + j] !== ol[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions, or null when it
 *  occurs at no tier. `--strict` tries tier 0 only. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const pos = occurrences(lines, o, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// ---- bodies: one line of a unified hunk or a V4A chunk ----

type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };

/**
 * Replace O (the ctx and old items) at `at` with N (the ctx and new items).
 * A context line is written as the file's own matched line, never the
 * patch's. At tier 2 every other line of N is re-indented: a non-empty,
 * non-whitespace-only line starting with P, the leading whitespace of O's
 * first line, has that P replaced by F, the leading whitespace of the file's
 * first matched line.
 */
function applyItems(lines: string[], at: number, items: BodyItem[], tier: number): string[] {
  const oCount = items.reduce((n, it) => n + (it.kind === 'ctx' || it.kind === 'old' ? 1 : 0), 0);
  const firstOld = items.find((it) => it.kind === 'ctx' || it.kind === 'old');
  const f = leadingWs(lines[at] ?? '');
  const p = firstOld === undefined ? '' : leadingWs(firstOld.text);
  const repl: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      repl.push(lines[at + oIdx]!);
      oIdx += 1;
    } else if (it.kind === 'old') {
      oIdx += 1;
    } else if (it.kind === 'new') {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      repl.push(t);
    }
  }
  return [...lines.slice(0, at), ...repl, ...lines.slice(at + oCount)];
}

// ---- the tree as the edits leave it ----

/** Changed paths in `now` (null: deleted); the rest are read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- format detection (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- unified diffs (SPEC.md section 6) ----

interface Hunk {
  a: number;
  items: BodyItem[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path a `--- ` or `+++ ` line names: after the four characters, up to
 *  the first tab, surrounding spaces removed, one leading `a/` or `b/` off. */
function diffPath(raw: string): string {
  let p = raw.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const pathOrNull = (p: string): string | null => (p === '/dev/null' ? null : p);

/** The path a `rename from ` or `rename to ` line names. */
function renamePath(raw: string, prefix: string): string {
  let p = raw.slice(prefix.length).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function finishHunk(a: number, raw: string[]): Hunk {
  const items: BodyItem[] = [];
  for (const l of raw) {
    if (l === '') items.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) items.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) items.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) items.push({ kind: 'new', text: l.slice(1) });
    else if (l.startsWith('\\')) items.push({ kind: 'bs', text: l.slice(1) });
  }
  let noEol = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') {
      noEol = k + 1 < items.length && items[k + 1]!.kind === 'bs';
      break;
    }
  }
  return { a, items, noEol };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: { a: number; raw: string[] } | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';

  const closeHunk = (): void => {
    if (sec !== null && hunk !== null) {
      const raw = hunk.raw;
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sec.hunks.push(finishHunk(hunk.a, raw));
    }
    hunk = null;
  };

  const hunkA = (l: string): number | null => {
    const m = HUNK_HEAD.exec(l);
    return m === null ? null : parseInt(m[1]!, 10);
  };
  const diffGit = (l: string): [string, string] | null => {
    if (!l.startsWith('diff --git ')) return null;
    const m = DIFF_GIT.exec(l);
    return m === null ? null : [m[1]!, m[2]!];
  };
  const isPair = (idx: number): boolean =>
    lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');

  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'body') {
      if (l.startsWith('diff --git ') || isPair(i)) {
        closeHunk();
        state = 'after';
        continue;
      }
      const a = hunkA(l);
      if (a !== null) {
        closeHunk();
        hunk = { a, raw: [] };
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        hunk!.raw.push(l);
        i += 1;
        continue;
      }
      closeHunk();
      state = 'after';
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const g = diffGit(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      sec = { gitOld: g[0], gitNew: g[1], newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      state = 'header';
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (state === 'header' && sec !== null) {
        sec.hdrOld = pathOrNull(diffPath(l));
        sec.hdrNew = pathOrNull(diffPath(lines[i + 1]!));
      } else {
        closeHunk();
        sec = {
          hdrOld: pathOrNull(diffPath(l)),
          hdrNew: pathOrNull(diffPath(lines[i + 1]!)),
          newFile: false,
          deletedFile: false,
          hunks: [],
        };
        sections.push(sec);
        state = 'header';
      }
      i += 2;
      continue;
    }
    const a = hunkA(l);
    if (a !== null) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a, raw: [] };
      state = 'body';
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (state === 'header' && sec !== null) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        sec.hdrNew = pathOrNull(diffPath(l));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renOld = pathOrNull(renamePath(l, 'rename from '));
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renNew = pathOrNull(renamePath(l, 'rename to '));
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  closeHunk();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks, in order, to a file's text. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const s = splitText(text);
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
    const nItems = h.items.filter((it) => it.kind === 'ctx' || it.kind === 'new');
    const O = oItems.map((it) => it.text);
    if (O.length === 0) {
      const preLen = s.lines.length;
      const at = Math.min(Math.max(h.a + d, 0), preLen);
      const N = nItems.map((it) => it.text);
      s.lines = [...s.lines.slice(0, at), ...N, ...s.lines.slice(at)];
      if (at === preLen) s.final = !h.noEol;
      d += N.length;
      continue;
    }
    const found = findTier(s.lines, O, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + O.length === s.lines.length;
    s.lines = applyItems(s.lines, best, h.items, found.tier);
    if (runsToEnd) s.final = !h.noEol;
    d += nItems.length - O.length;
  }
  return joinText(s);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  // null is meaningful here (/dev/null), so do not use ??, which would fall
  // through it: only undefined means "this source did not name a path".
  const oldP = sec.hdrOld !== undefined ? sec.hdrOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
  const newP = sec.hdrNew !== undefined ? sec.hdrNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
  if (oldP === undefined || newP === undefined) throw new Error('section without a path');
  if (oldP === null || sec.newFile) {
    const target = newP;
    return (tree) => {
      if (target === null) throw new Fail('unsafe', '/dev/null');
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let sawPlus = false;
      let lastPlusBs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.items.length; k++) {
          if (h.items[k]!.kind === 'new') {
            out.push(h.items[k]!.text);
            sawPlus = true;
            lastPlusBs = k + 1 < h.items.length && h.items[k + 1]!.kind === 'bs';
          }
        }
      }
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (!sawPlus || lastPlusBs ? '' : '\n'));
    };
  }
  if (newP === null || sec.deletedFile) {
    const target = oldP;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== newP) {
    const from = oldP;
    const to = newP;
    return (tree) => {
      if (!safe(from)) throw new Fail('unsafe', from);
      if (!safe(to)) throw new Fail('unsafe', to);
      const cur = tree.get(from);
      if (cur === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      tree.now.set(to, applyHunks(cur, sec.hunks, strict, from));
      tree.now.set(from, null);
      tree.moves.push({ old: from, new: to });
    };
  }
  const target = oldP;
  return (tree) => {
    if (!safe(target)) throw new Fail('unsafe', target);
    const cur = tree.get(target);
    if (cur === null) throw new Fail('missing', target);
    tree.now.set(target, applyHunks(cur, sec.hunks, strict, target));
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  const items: BodyItem[] = [
    ...oldLines.map((t): BodyItem => ({ kind: 'old', text: t })),
    ...newLines.map((t): BodyItem => ({ kind: 'new', text: t })),
  ];
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const s = splitText(cur);
    const found = findTier(s.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    s.lines = applyItems(s.lines, found.pos[0]!, items, found.tier);
    tree.now.set(path, joinText(s));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4AChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionKind = (l: string): string | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionKind(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    const startLine = i + 1;
    const raw: { text: string; no: number }[] = [];
    i += 1;
    while (i < last && sectionKind(lines[i]!) === null) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const out: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) out.push(r.text.slice(1));
        else if (r.text === '') out.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind: 'add', path, lines: out });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      sections.push({ kind: 'delete', path });
    } else {
      sections.push(parseV4AUpdate(path, raw, startLine));
    }
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function parseV4AUpdate(path: string, raw: { text: string; no: number }[], updateLine: number): V4ASection {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4AChunk[] = [];
  let cur: V4AChunk | null = null;
  const close = (eof: boolean): void => {
    if (cur !== null) {
      cur.eof = eof;
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx]!;
    const t = r.text;
    if (t.startsWith('@@')) {
      close(false);
      const anchor = t.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
    } else if (t === '*** End of File') {
      close(true);
    } else if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
      if (cur === null) cur = { anchor: null, items: [], eof: false };
      if (t === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (t.startsWith(' ')) cur.items.push({ kind: 'ctx', text: t.slice(1) });
      else if (t.startsWith('-')) cur.items.push({ kind: 'old', text: t.slice(1) });
      else cur.items.push({ kind: 'new', text: t.slice(1) });
    } else {
      throw new Exit2(`error: parse ${r.no}`);
    }
  }
  close(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return { kind: 'update', path, moveTo, chunks };
}

function v4aSectionEdit(s: V4ASection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const path = s.path;
    const lines = s.lines;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = s.path;
  const moveTo = s.moveTo;
  const chunks = s.chunks;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const sp = splitText(cur);
    let lines = sp.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        const top = strict ? 0 : 2;
        for (let t = 0; t <= top && found < 0; t++) {
          const want = norm(ch.anchor, t);
          for (let k = cursor; k < lines.length; k++) {
            if (norm(lines[k]!, t) === want) {
              found = k;
              break;
            }
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const oItems = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'old');
      const nItems = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'new');
      const O = oItems.map((it) => it.text);
      if (O.length === 0) {
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        const N = nItems.map((it) => it.text);
        lines = [...lines.slice(0, at), ...N, ...lines.slice(at)];
        cursor = at + N.length;
      } else {
        const found = findTier(lines, O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const at = found.pos[0]!;
        lines = applyItems(lines, at, ch.items, found.tier);
        cursor = at + nItems.length;
      }
    }
    const out = joinText({ br: sp.br, lines, final: sp.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const crlf = splitText(before).br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const s = splitText(before);
      if (line < 0 || line > s.lines.length) throw new Fail('no-match', p);
      s.lines.splice(line, 0, ...add);
      tree.now.set(p, joinText(s));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- the command line (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      rows.push({ key: m.new, line: `R ${m.old} -> ${m.new}` });
      covered.add(m.old);
      covered.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    const changed = [...tree.now.keys()]
      .filter((p) => tree.original(p) !== tree.now.get(p))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
