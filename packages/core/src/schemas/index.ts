/**
 * Zod schemas — the wire contract's source of truth (architecture §3).
 * A build step exports these to JSON Schema for the PHP API to validate
 * against; clients validate directly. schemaVersion gates persistence.
 */

import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const Id = z.string().min(1).max(64);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const MinorAmount = z.number().int().safe();
export const PositiveMinorAmount = MinorAmount.positive();
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CategorySchema = z.enum(['drinks', 'dining', 'travel', 'adulting', 'other']);

export const PaymentHandles = z
  .object({
    interacEmail: z.string().email().optional(),
    paypalMe: z.string().regex(/^[A-Za-z0-9._-]{1,50}$/).optional(),
    venmo: z.string().regex(/^[A-Za-z0-9._-]{1,50}$/).optional(),
  })
  .strict();

export const SplitMethodSchema = z.enum(['equal', 'exact', 'shares', 'percent', 'adjustment']);

export const ExpensePayer = z.object({
  userId: Id,
  amountMinor: PositiveMinorAmount,
}).strict();

export const ExpenseShare = z.object({
  userId: Id,
  amountMinor: MinorAmount.nonnegative(),
}).strict();

export const ExpenseCreate = z
  .object({
    description: z.string().min(1).max(200),
    amountMinor: PositiveMinorAmount,
    currency: CurrencyCode,
    expenseDate: IsoDate,
    category: CategorySchema,
    notes: z.string().max(2000).optional(),
    receiptId: Id.optional(),
    fxRateOverride: z.number().positive().optional(),
    payers: z.array(ExpensePayer).min(1),
    splitMethod: SplitMethodSchema,
    shares: z.array(ExpenseShare).min(1),
  })
  .strict()
  .superRefine((e, ctx) => {
    const paid = e.payers.reduce((a, p) => a + p.amountMinor, 0);
    if (paid !== e.amountMinor) {
      ctx.addIssue({ code: 'custom', message: `payers sum to ${paid}, expected ${e.amountMinor}` });
    }
    const shared = e.shares.reduce((a, s) => a + s.amountMinor, 0);
    if (shared !== e.amountMinor) {
      ctx.addIssue({ code: 'custom', message: `shares sum to ${shared}, expected ${e.amountMinor}` });
    }
  });

export const SettlementCreate = z
  .object({
    toUserId: Id,
    amountMinor: PositiveMinorAmount,
    currency: CurrencyCode,
    method: z.enum(['interac', 'paypal', 'venmo', 'cash', 'other']),
    note: z.string().max(500).optional(),
  })
  .strict();

export const GroupCreate = z
  .object({
    name: z.string().min(1).max(80),
    emoji: z.string().max(8).optional(),
    homeCurrency: CurrencyCode,
  })
  .strict();

export type ExpenseCreateT = z.infer<typeof ExpenseCreate>;
export type SettlementCreateT = z.infer<typeof SettlementCreate>;
export type GroupCreateT = z.infer<typeof GroupCreate>;
