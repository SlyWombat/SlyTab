/**
 * Card slips print their totals as line items, and we were treating them as
 * things people ate.
 *
 * A Chilean Transbank slip scanned on 2026-08-02 came back as:
 *
 *   items:    MONTO VENTA 6723, IVA 1277
 *   subtotal: 8000   tax: 800   tip: null   total: 8800
 *
 * Against the printed slip — MONTO VENTA 6.723, IVA 1.277, SUBTOTAL 8.000,
 * PROPINA 800, TOTAL 8.800 — the total was right and everything else was not:
 *
 *   - MONTO VENTA (the net sale) and IVA (the tax) are summary lines, not
 *     items. Offering to split "IVA" between four people is nonsense, and the
 *     assign-items screen did exactly that.
 *   - PROPINA is a TIP. It was recorded as tax.
 *   - The real tax, IVA, was sitting in the item list.
 *
 * None of this changes what anyone is charged — the total governs — but it
 * makes the item view wrong, and the tax/tip split wrong on every card slip
 * from a country that prints them this way.
 *
 * Deliberately narrow: this only reclassifies lines whose NAME says what they
 * are. It never invents, drops or alters an amount, and if a line is not
 * recognisably a summary line it is left exactly where the parser put it.
 */

/**
 * Keywords, per role, in the languages the app is actually used in.
 *
 * Anchored at BOTH ends on purpose. A summary row is printed as exactly
 * "TOTAL:" or "IVA:", never as part of a phrase, whereas a real purchase very
 * much can contain those words — a "Total Recall Cocktail", a "Taxi to the
 * hotel", "Pasta with servicio sauce". Matching a prefix would quietly delete
 * someone's drink from the bill, which is a worse failure than leaving a
 * summary row in the list where it is at least visible.
 */
const NET_SALE = /^(monto\s*venta|importe|net(o|to)?(\s*sale)?|sub\s*total|base\s*imponible)$/i;
const TAX = /^(iva|i\.v\.a\.?|vat|tax|gst|hst|pst|qst|impuesto|mwst|tva|btw)$/i;
const TIP = /^(propina|tip|gratuity|service\s*charge|servicio)$/i;
const TOTAL = /^(total|amount\s*due|importe\s*total|a\s*pagar)$/i;

export type SummaryRole = 'net' | 'tax' | 'tip' | 'total' | null;

/** What a line's name says it is, or null if it names a real thing. */
export function summaryRole(name: string): SummaryRole {
  const n = name.replace(/[:\s]+$/, '').trim();
  if (n === '') return null;
  if (TIP.test(n)) return 'tip';
  if (TAX.test(n)) return 'tax';
  if (TOTAL.test(n)) return 'total';
  if (NET_SALE.test(n)) return 'net';
  return null;
}

export interface SummaryFold<T> {
  /** Only the lines that name a real purchase. */
  items: T[];
  /** Lines removed because they were summary rows, for explaining the change. */
  removed: { name: string; role: Exclude<SummaryRole, null>; totalMinor: number }[];
  taxMinor: number | null;
  tipMinor: number | null;
  /** True when every line was a summary row — a card slip with no detail. */
  allSummary: boolean;
}

/**
 * Move summary rows out of the item list and into the fields they belong in.
 *
 * Tax and tip are only taken from a line when the parser did not already give
 * that field a different value; a figure the parser read from its own place on
 * the slip is better evidence than one inferred from a row's name.
 */
export function foldSummaryLines<T extends { name: string; totalMinor: number }>(
  items: readonly T[],
  taxMinor: number | null,
  tipMinor: number | null,
): SummaryFold<T> {
  const kept: T[] = [];
  const removed: SummaryFold<T>['removed'] = [];
  let tax = taxMinor;
  let tip = tipMinor;

  for (const item of items) {
    const role = summaryRole(item.name);
    if (role === null) {
      kept.push(item);
      continue;
    }
    removed.push({ name: item.name, role, totalMinor: item.totalMinor });
    if (role === 'tax' && tax === null) tax = item.totalMinor;
    if (role === 'tip' && tip === null) tip = item.totalMinor;
  }

  return {
    items: kept,
    removed,
    taxMinor: tax,
    tipMinor: tip,
    allSummary: kept.length === 0 && removed.length > 0,
  };
}
