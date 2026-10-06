import { describe, expect, it } from 'vitest';

import { glossaryCsv, parseGlossaryCsv } from './help-glossary-csv';

describe('glossary CSV', () => {
  it('reads terms, rules, notes and a column per language', () => {
    const csv = [
      'Term,Rule,de,fr,Note',
      'Mocco Gate,keep,,,The product name',
      'widget,fixed,Steuerelement,composant,',
      'workspace,,Arbeitsbereich,,No rule: fixed as it has a translation',
      'Save,,,,',
    ].join('\n');

    expect(parseGlossaryCsv(csv)).toEqual({
      terms: [
        { term: 'Mocco Gate', rule: 'keep', translations: {}, note: 'The product name' },
        { term: 'widget', rule: 'fixed', translations: { de: 'Steuerelement', fr: 'composant' }, note: '' },
        {
          term: 'workspace',
          rule: 'fixed',
          translations: { de: 'Arbeitsbereich' },
          note: 'No rule: fixed as it has a translation',
        },
        { term: 'Save', rule: 'keep', translations: {}, note: '' },
      ],
      problems: [],
    });
  });

  it('reads quoted fields with commas, quotes and line breaks, CRLF and a byte order mark', () => {
    const csv = '\u{FEFF}term,note\r\n"Sign in, then","Say ""Sign in""\nexactly"\r\nPlan,\r\n';

    expect(parseGlossaryCsv(csv)).toEqual({
      terms: [
        { term: 'Sign in, then', rule: 'keep', translations: {}, note: 'Say "Sign in"\nexactly' },
        { term: 'Plan', rule: 'keep', translations: {}, note: '' },
      ],
      problems: [],
    });
  });

  it('names the line of each row it can’t read, and keeps the rest', () => {
    const csv = ['term,rule,de', ',keep,', 'gate,fixed,', 'ok,keep,', 'odd,maybe,'].join('\n');

    const { terms, problems } = parseGlossaryCsv(csv);

    expect(terms.map(term => term.term)).toEqual(['ok']);
    expect(problems.map(problem => problem.line)).toEqual([2, 3, 5]);
    expect(problems[1]?.message).toContain('A fixed term needs a translation');
  });

  it('refuses a file without a term column, or with a column it doesn’t know', () => {
    expect(parseGlossaryCsv('name,rule\nx,keep').problems).toEqual([
      { line: 1, message: expect.stringContaining('Unknown columns: name') },
    ]);
    expect(parseGlossaryCsv('rule\nkeep').problems).toEqual([
      { line: 1, message: 'The first row needs a "term" column' },
    ]);
    expect(parseGlossaryCsv('').problems).toEqual([{ line: 1, message: 'The file is empty' }]);
  });

  it('writes the glossary back out in a form it reads again', () => {
    const terms = [
      { term: 'Mocco Gate', rule: 'keep' as const, translations: {}, note: 'Say "Gate", not "gate"' },
      { term: 'widget', rule: 'fixed' as const, translations: { fr: 'composant', de: 'Steuer, element' }, note: '' },
    ];

    const csv = glossaryCsv(terms);

    expect(csv.split('\r\n', 1)[0]).toBe('term,rule,fr,de,note');
    expect(parseGlossaryCsv(csv)).toEqual({ terms, problems: [] });
  });
});
