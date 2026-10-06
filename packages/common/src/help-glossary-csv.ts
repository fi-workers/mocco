// A help center glossary as CSV (#214): the console reads a spreadsheet export in the
// browser and sends the parsed terms to `help.importGlossary`, and writes the glossary
// back out the same way.
//
// The first row names the columns. `term` is required; `rule` is `keep` or `fixed` (left
// empty, a row with a translation is `fixed`, one without is `keep`); `note` is optional;
// every other column is a language code (`de`, `ko`, …) holding that language's fixed
// translation. Fields follow RFC 4180: commas, quotes and line breaks inside "quotes",
// a quote inside written twice.
/* eslint-disable sonarjs/null-dereference -- every value here is a string from the file, never null */
import { GlossaryLimits, GlossaryRules, glossaryTermInputSchema, HELP_LOCALES } from './help';

import type { GlossaryRule, GlossaryTermInput, HelpLocale } from './help';

/** A row that couldn't be read, by its line in the file (1 is the header). */
export interface GlossaryCsvProblem {
  readonly line: number;
  readonly message: string;
}

export interface GlossaryCsv {
  readonly terms: GlossaryTermInput[];
  readonly problems: GlossaryCsvProblem[];
}

interface Row {
  readonly line: number;
  readonly fields: string[];
}

const BYTE_ORDER_MARK = '\u{FEFF}';

/** Reads CSV one character at a time: a small state machine over fields and rows. */
class CsvReader {
  #rows: Row[] = [];

  #fields: string[] = [];

  #field = '';

  #line = 1;

  #rowLine = 1;

  #isQuoted = false;

  constructor(private readonly source: string) {}

  #endRow() {
    this.#fields.push(this.#field);
    if (this.#fields.some(value => value.trim() !== '')) {
      this.#rows.push({ line: this.#rowLine, fields: this.#fields });
    }
    this.#fields = [];
    this.#field = '';
  }

  /** One character inside quotes; returns how many it consumed. */
  #quoted(char: string, next: string): number {
    if (char === '"') {
      if (next === '"') {
        this.#field += '"';
        return 2;
      }
      this.#isQuoted = false;
      return 1;
    }
    if (char === '\n') {
      this.#line += 1;
    }
    this.#field += char;
    return 1;
  }

  /** One character outside quotes; returns how many it consumed. */
  #plain(char: string, next: string): number {
    if (char === '"' && this.#field === '') {
      this.#isQuoted = true;
    } else if (char === ',') {
      this.#fields.push(this.#field);
      this.#field = '';
    } else if (char === '\n' || char === '\r') {
      this.#endRow();
      this.#line += 1;
      this.#rowLine = this.#line;
      return char === '\r' && next === '\n' ? 2 : 1;
    } else {
      this.#field += char;
    }
    return 1;
  }

  read(): Row[] {
    let i = 0;
    while (i < this.source.length) {
      const char = this.source.charAt(i);
      const next = this.source.charAt(i + 1);
      i += this.#isQuoted ? this.#quoted(char, next) : this.#plain(char, next);
    }
    this.#endRow();
    return this.#rows;
  }
}

const isLocale = (value: string): value is HelpLocale => (HELP_LOCALES as readonly string[]).includes(value);

const KNOWN_COLUMNS: ReadonlySet<string> = new Set(['term', 'rule', 'note']);

/** Why the header can't be read, or null. */
function headerProblem(columns: readonly string[]): string | null {
  const unknown = columns.filter(name => !KNOWN_COLUMNS.has(name) && !isLocale(name));
  if (unknown.length > 0) {
    return `Unknown columns: ${unknown.join(', ')}. Use term, rule, note and language codes (${HELP_LOCALES.join(', ')}).`;
  }
  return columns.includes('term') ? null : 'The first row needs a "term" column';
}

/** A row's rule: as written, or from whether it has a translation. */
const ruleOf = (written: string, hasTranslation: boolean): string => {
  if (written !== '') {
    return written.toLowerCase();
  }
  const rule: GlossaryRule = hasTranslation ? GlossaryRules.fixed : GlossaryRules.keep;
  return rule;
};

/** One row as a term, or why it can't be one. */
function termOf(columns: readonly string[], row: Row): { term: GlossaryTermInput | null; problem: string | null } {
  const value = (name: string) => {
    const index = columns.indexOf(name);
    return index === -1 ? '' : (row.fields[index] ?? '').trim();
  };
  const translations = Object.fromEntries(
    columns.flatMap(name => (isLocale(name) && value(name) !== '' ? [[name, value(name)]] : [])),
  );
  const parsed = glossaryTermInputSchema.safeParse({
    term: value('term'),
    rule: ruleOf(value('rule'), Object.keys(translations).length > 0),
    translations,
    note: value('note'),
  });
  if (parsed.success) {
    return { term: parsed.data, problem: null };
  }
  const [issue] = parsed.error.issues;
  const where = issue?.path.join('.') ?? '';
  const message = issue?.message ?? 'Invalid row';
  return { term: null, problem: where === '' ? message : `${where}: ${message}` };
}

/** The terms of a glossary CSV, and the rows that couldn't be read. */
export function parseGlossaryCsv(text: string): GlossaryCsv {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  const [header, ...rows] = new CsvReader(source).read();
  if (header === undefined) {
    return { terms: [], problems: [{ line: 1, message: 'The file is empty' }] };
  }
  const columns = header.fields.map(name => name.trim().toLowerCase());
  const problem = headerProblem(columns);
  if (problem !== null) {
    return { terms: [], problems: [{ line: header.line, message: problem }] };
  }
  if (rows.length > GlossaryLimits.termsMax) {
    const message = `A glossary holds up to ${String(GlossaryLimits.termsMax)} terms`;
    return { terms: [], problems: [{ line: header.line, message }] };
  }
  const read = rows.map(row => ({ line: row.line, ...termOf(columns, row) }));
  return {
    terms: read.flatMap(entry => (entry.term === null ? [] : [entry.term])),
    problems: read.flatMap(entry => (entry.problem === null ? [] : [{ line: entry.line, message: entry.problem }])),
  };
}

const csvField = (value: string) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);

/** The glossary as CSV, with a column for each language any term translates into. */
export function glossaryCsv(terms: readonly GlossaryTermInput[]): string {
  const locales = HELP_LOCALES.filter(locale => terms.some(term => term.translations?.[locale] !== undefined));
  const header = ['term', 'rule', ...locales, 'note'];
  const lines = terms.map(term =>
    [term.term, term.rule, ...locales.map(locale => term.translations?.[locale] ?? ''), term.note ?? '']
      .map(value => csvField(value))
      .join(','),
  );
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
