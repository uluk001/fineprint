import type { Category } from './types.ts';

// Default risk taxonomy. Remote Config key `risk_categories` can override it
// without shipping a new extension build.
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'auto_renewal', label: 'Auto-renewal', hint: 'contract or subscription renews automatically unless cancelled' },
  { id: 'cancellation_fee', label: 'Cancellation fee', hint: 'fees, penalties or lost refunds when cancelling early' },
  { id: 'price_change', label: 'Price change', hint: 'provider may raise the price or premium' },
  { id: 'unilateral_change', label: 'One-sided changes', hint: 'provider may change terms without consent' },
  { id: 'exclusion', label: 'Exclusion', hint: 'situations the insurance or warranty does not cover' },
  { id: 'deductible', label: 'Deductible / excess', hint: 'amount the customer pays before coverage starts' },
  { id: 'waiting_period', label: 'Waiting period', hint: 'coverage only starts after a delay' },
  { id: 'claim_deadline', label: 'Claim deadline', hint: 'short or strict deadlines to report or claim' },
  { id: 'liability_limit', label: 'Liability cap', hint: 'provider limits how much it will ever pay' },
  { id: 'arbitration', label: 'Arbitration / class waiver', hint: 'disputes forced into arbitration, no class action or court' },
  { id: 'data_sharing', label: 'Data sharing', hint: 'personal data sold, shared or used for marketing' },
  { id: 'late_fee', label: 'Late fee / interest', hint: 'penalty interest, late or overdraft fees' },
  { id: 'early_repayment', label: 'Early repayment penalty', hint: 'fee for paying a loan off early' },
  { id: 'auto_debit', label: 'Automatic debit', hint: 'provider may charge the card or account automatically' },
];

export function parseCategories(raw: string | undefined | null): Category[] {
  if (!raw) return DEFAULT_CATEGORIES;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_CATEGORIES;
    const valid = parsed.filter(
      (c) => c && typeof c.id === 'string' && typeof c.label === 'string' && typeof c.hint === 'string',
    );
    return valid.length >= 3 ? valid : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

export function labelFor(categories: Category[], id: string): string {
  return categories.find((c) => c.id === id)?.label ?? id.replace(/_/g, ' ');
}
