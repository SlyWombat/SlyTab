import { describe, expect, it } from 'vitest';
import { allAssigned, assignedShares, receiptBill } from '../src/receipt-assign.js';
import { currencyForLocation } from '../src/geo-currency.js';
import { gpsFromJpeg } from '../src/exif-gps.js';

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

describe('receiptBill', () => {
  const uber = { // issue #23: loyalty credit parsed as an item
    items: [{ totalMinor: 19597 }, { totalMinor: 145 }],
    totalMinor: 19597, taxMinor: null, tipMinor: null,
  };

  it('keeps the printed total and reconciles once the credit line is ignored', () => {
    const withCredit = receiptBill(uber);
    expect(withCredit.extraMinor).toBe(-145); // doesn't reconcile
    const ignored = receiptBill(uber, new Set([1]));
    expect(ignored.itemsSum).toBe(19597);
    expect(ignored.totalMinor).toBe(19597);
    expect(ignored.extraMinor).toBe(0); // reconciles
  });

  it('reconstructs a missing total from kept items + tax + tip', () => {
    const b = receiptBill(
      { items: [{ totalMinor: 1000 }, { totalMinor: 500 }], totalMinor: null, taxMinor: 130, tipMinor: 200 },
      new Set([1]),
    );
    expect(b.billTotal).toBe(1330);
    expect(b.extraMinor).toBe(330);
  });

  it('adds the card-slip tip on top', () => {
    const b = receiptBill({ items: [{ totalMinor: 950000 }], totalMinor: 950000, taxMinor: null, tipMinor: null }, new Set(), 95000);
    expect(b.totalMinor).toBe(1045000);
    expect(b.extraMinor).toBe(95000);
  });
});

describe('assignedShares — totals invariant across combinations', () => {
  const members = ['a', 'b', 'c'];

  it('sums exactly to totalMinor for every assignment combination of a 3-item bill', () => {
    const items = [{ totalMinor: 597000 }, { totalMinor: 297000 }, { totalMinor: 56001 }];
    // Every non-empty subset of members per item — 7^3 combinations.
    const subsets: string[][] = [];
    for (let m = 1; m < 8; m++) subsets.push(members.filter((_, i) => m & (1 << i)));
    for (const s0 of subsets) for (const s1 of subsets) for (const s2 of subsets) {
      for (const extra of [0, 95001, -333]) {
        const bill = receiptBill(
          { items, totalMinor: 950001 + extra, taxMinor: null, tipMinor: null },
        );
        const shares = assignedShares(items, { 0: s0, 1: s1, 2: s2 }, new Set(), bill.extraMinor);
        expect(sum(shares)).toBe(bill.totalMinor);
      }
    }
  });

  it('ignored items take no share and unblock Continue', () => {
    const items = [{ totalMinor: 19597 }, { totalMinor: 145 }];
    const assign = { 0: ['a', 'b'] };
    expect(allAssigned(items, assign, new Set())).toBe(false); // credit line unassigned
    expect(allAssigned(items, assign, new Set([1]))).toBe(true); // …until ignored
    const bill = receiptBill({ items, totalMinor: 19597, taxMinor: null, tipMinor: null }, new Set([1]));
    const shares = assignedShares(items, assign, new Set([1]), bill.extraMinor);
    expect(sum(shares)).toBe(19597);
    expect(shares.a! + shares.b!).toBe(19597);
  });

  it('odd cents land deterministically (largest remainder via computeSplit)', () => {
    const items = [{ totalMinor: 101 }];
    const shares = assignedShares(items, { 0: ['a', 'b'] }, new Set(), 0);
    expect(sum(shares)).toBe(101);
    expect(Math.abs(shares.a! - shares.b!)).toBe(1);
  });
});

describe('currencyForLocation', () => {
  it('resolves border-ambiguous points to the nearest box center', () => {
    expect(currencyForLocation(-33.45, -70.66)).toBe('CLP'); // Santiago (also inside AR's box)
    expect(currencyForLocation(-31.42, -64.18)).toBe('ARS'); // Córdoba
    expect(currencyForLocation(45.42, -75.70)).toBe('CAD');  // Ottawa (also inside the US box)
    expect(currencyForLocation(49.28, -123.12)).toBe('CAD'); // Vancouver (ditto)
    expect(currencyForLocation(35.68, 139.69)).toBe('JPY');  // Tokyo
  });

  it('returns null in the open ocean', () => {
    expect(currencyForLocation(-40, -140)).toBeNull();
  });
});

describe('gpsFromJpeg', () => {
  it('reads a synthetic EXIF GPS block (little-endian)', () => {
    // Minimal JPEG: SOI + APP1(Exif, TIFF II) with IFD0 → GPS IFD, lat 33°27'0"S lon 70°39'36"W.
    const tiff = buildTiffWithGps(33, 27, 0, 'S', 70, 39, 36, 'W');
    const app1 = [0xff, 0xe1, 0, tiff.length + 8, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    app1[2] = (tiff.length + 8) >> 8;
    app1[3] = (tiff.length + 8) & 0xff;
    const jpeg = new Uint8Array([0xff, 0xd8, ...app1, 0xff, 0xd9]);
    const gps = gpsFromJpeg(jpeg);
    expect(gps).not.toBeNull();
    expect(gps!.lat).toBeCloseTo(-33.45, 2);
    expect(gps!.lon).toBeCloseTo(-70.66, 2);
  });

  it('returns null for non-JPEG bytes (PNG screenshots)', () => {
    expect(gpsFromJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull();
    expect(gpsFromJpeg(new Uint8Array([]))).toBeNull();
  });
});

/** Little-endian TIFF with IFD0 (one entry: GPS pointer) + GPS IFD. */
function buildTiffWithGps(
  latD: number, latM: number, latS: number, latRef: string,
  lonD: number, lonM: number, lonS: number, lonRef: string,
): number[] {
  const b: number[] = [];
  const u16 = (v: number) => b.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v: number) => b.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
  b.push(0x49, 0x49); u16(42); u32(8);          // II, magic, IFD0 @8
  u16(1);                                        // IFD0: 1 entry
  u16(0x8825); u16(4); u32(1); u32(26);          // GPS IFD pointer → offset 26
  u32(0);                                        // next IFD
  // GPS IFD @26: 4 entries + next, then rational data.
  const dataStart = 26 + 2 + 4 * 12 + 4;         // 80
  u16(4);
  u16(1); u16(2); u32(2); b.push(latRef.charCodeAt(0), 0, 0, 0); // GPSLatitudeRef
  u16(2); u16(5); u32(3); u32(dataStart);                         // GPSLatitude → 3 rationals @80
  u16(3); u16(2); u32(2); b.push(lonRef.charCodeAt(0), 0, 0, 0); // GPSLongitudeRef
  u16(4); u16(5); u32(3); u32(dataStart + 24);                    // GPSLongitude @104
  u32(0);                                        // next IFD
  for (const [n, d] of [[latD, 1], [latM, 1], [latS, 1], [lonD, 1], [lonM, 1], [lonS, 1]] as const) {
    u32(n); u32(d);
  }
  return b;
}
