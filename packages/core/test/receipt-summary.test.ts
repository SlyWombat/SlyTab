import { describe, expect, it } from 'vitest';
import { foldSummaryLines, summaryRole } from '../src/receipt-summary.js';

describe('summaryRole', () => {
  it('recognises the rows a card slip prints', () => {
    expect(summaryRole('MONTO VENTA:')).toBe('net');
    expect(summaryRole('IVA:')).toBe('tax');
    expect(summaryRole('PROPINA:')).toBe('tip');
    expect(summaryRole('TOTAL:')).toBe('total');
    expect(summaryRole('SUBTOTAL')).toBe('net');
  });

  it('leaves real purchases alone', () => {
    for (const name of ['Pisco Sour', 'Aqcua Panna', 'Lift pass', '2 x Empanada']) {
      expect(summaryRole(name), name).toBeNull();
    }
  });

  it('does not mistake a purchase whose name contains a keyword', () => {
    // Dropping a real drink is worse than leaving a summary row visible, so
    // the patterns match a whole name and never a fragment of one.
    for (const name of [
      'Total Recall Cocktail', 'Pasta with servicio sauce', 'Taxi to the hotel',
      'Tax advice book', 'Propina Especial Burger', 'Subtotal Stout',
    ]) {
      expect(summaryRole(name), name).toBeNull();
    }
  });
});

describe('foldSummaryLines', () => {
  // The exact payload from the scan reported on 2026-08-02, against a slip
  // printing MONTO VENTA 6.723 / IVA 1.277 / SUBTOTAL 8.000 / PROPINA 800 /
  // TOTAL 8.800.
  const slip = [
    { name: 'MONTO VENTA:', totalMinor: 6723 },
    { name: 'IVA:', totalMinor: 1277 },
  ];

  it('empties the item list and rescues the real tax', () => {
    // The parser had put the PROPINA into taxMinor; here the tax comes from
    // the IVA line instead, which is where it actually was.
    const f = foldSummaryLines(slip, null, null);
    expect(f.items).toEqual([]);
    expect(f.allSummary).toBe(true);
    expect(f.taxMinor).toBe(1277);
    expect(f.removed.map((r) => r.role)).toEqual(['net', 'tax']);
  });

  it('does not overwrite a figure the parser read from its own field', () => {
    // A value read off the slip beats one inferred from a row's name.
    const f = foldSummaryLines(slip, 999, null);
    expect(f.taxMinor).toBe(999);
  });

  it('keeps real items and folds only the summary rows', () => {
    const f = foldSummaryLines(
      [
        { name: 'Pisco Sour', totalMinor: 5500 },
        { name: 'Empanada', totalMinor: 3200 },
        { name: 'PROPINA:', totalMinor: 800 },
      ],
      null,
      null,
    );
    expect(f.items.map((i) => i.name)).toEqual(['Pisco Sour', 'Empanada']);
    expect(f.tipMinor).toBe(800);
    expect(f.allSummary).toBe(false);
  });

  it('changes no amounts', () => {
    const f = foldSummaryLines(slip, null, null);
    const before = slip.reduce((a, i) => a + i.totalMinor, 0);
    const after = f.items.reduce((a, i) => a + i.totalMinor, 0)
      + f.removed.reduce((a, r) => a + r.totalMinor, 0);
    expect(after).toBe(before);
  });

  it('leaves an ordinary receipt untouched', () => {
    const items = [{ name: 'Groceries', totalMinor: 8210 }];
    const f = foldSummaryLines(items, 500, 100);
    expect(f.items).toEqual(items);
    expect(f.removed).toEqual([]);
    expect(f.taxMinor).toBe(500);
    expect(f.tipMinor).toBe(100);
  });
});
