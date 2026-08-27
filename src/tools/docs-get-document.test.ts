import { describe, expect, it } from 'vitest';
import type { docs_v1 } from 'googleapis';
import { flattenStructuralElements } from './docs-get-document.js';

/** A paragraph as the Docs API returns it: textRun content carries its own \n. */
function para(text: string): docs_v1.Schema$StructuralElement {
  return { paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } };
}

function cell(text: string): docs_v1.Schema$TableCell {
  return { content: [para(text)] };
}

function table(rows: string[][]): docs_v1.Schema$StructuralElement {
  return {
    table: {
      tableRows: rows.map(cells => ({ tableCells: cells.map(cell) })),
    },
  };
}

describe('flattenStructuralElements', () => {
  it('keeps paragraphs on their own lines', () => {
    expect(flattenStructuralElements([para('one'), para('two')])).toBe('one\ntwo\n');
  });

  it('puts each table row on its own line', () => {
    const out = flattenStructuralElements([
      table([
        ['Name', 'Qty'],
        ['Widget', '3'],
        ['Sprocket', '7'],
      ]),
    ]);
    expect(out).toBe('Name\tQty\nWidget\t3\nSprocket\t7\n');
    expect(out.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('does not glue a five-row table into one line', () => {
    const rows = Array.from({ length: 5 }, (_, i) => [`r${i}`, `v${i}`]);
    const out = flattenStructuralElements([table(rows)]);
    expect(out.split('\n').filter(Boolean)).toHaveLength(5);
  });

  it('separates a table from the paragraphs around it', () => {
    const out = flattenStructuralElements([
      para('before'),
      table([['a', 'b']]),
      para('after'),
    ]);
    expect(out).toBe('before\na\tb\nafter\n');
  });

  it('flattens a nested table inside a cell', () => {
    const nested: docs_v1.Schema$TableCell = { content: [table([['x', 'y']])] };
    const out = flattenStructuralElements([
      { table: { tableRows: [{ tableCells: [nested, cell('z')] }] } },
    ]);
    expect(out).toBe('x\ty\tz\n');
  });

  it('returns an empty string for no elements', () => {
    expect(flattenStructuralElements(undefined)).toBe('');
    expect(flattenStructuralElements([])).toBe('');
  });

  it('ignores sectionBreak and tableOfContents elements', () => {
    expect(
      flattenStructuralElements([{ sectionBreak: {} }, para('body'), { tableOfContents: {} }]),
    ).toBe('body\n');
  });
});
