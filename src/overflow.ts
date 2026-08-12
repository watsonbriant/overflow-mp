import { config } from './env.ts';

export interface OverflowDonor {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    country?: string | null;
  } | null;
}

export interface OverflowContribution {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Asset class: CASH | CRYPTO | DAF | MANUAL_CASH | STOCK */
  type: string;
  /** Gross gift amount, in DOLLARS. (Deposits use cents — do not mix these up.) */
  amount: number;
  contributionDate: string;
  status: string;
  paymentMethod: { type?: string | null; last4?: string | null } | null;
  campaign: { id: string; name: string } | null;
  subcampaign: { id: string; name: string } | null;
  donor: OverflowDonor | null;
  depositId: string | null;
  frequency: string | null;
  anonymous: boolean;
  donorNotes: string | null;
  dedication?: string | null;
  subscriptionId?: string | null;
}

export interface OverflowDeposit {
  id: string;
  status: string;
  /** Net payout, in CENTS. */
  amountInCents: number;
  arrivalAt: string;
  bankLast4: string | null;
  statementDescriptor: string | null;
  paymentMethodType: string[] | null;
  reconciledAt: string | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${config.overflow.base}${path}`, {
    headers: {
      'x-client-id': config.overflow.clientId,
      'x-api-key': config.overflow.apiKey,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Overflow GET ${path} failed (${res.status}): ${text}`);
  return JSON.parse(text) as T;
}

const PAGE_SIZE = 100; // API maximum

/** Walks every page of a list endpoint. `path` must already carry its query string. */
async function paginate<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await get<{ data: T[]; totalCount: number }>(
      `${path}${sep}limit=${PAGE_SIZE}&page=${page}`,
    );
    const batch = res.data ?? [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE || all.length >= (res.totalCount ?? 0)) break;
  }
  return all;
}

export const overflow = {
  health(): Promise<unknown> {
    return get('/api/v3/health');
  },

  /**
   * Confirmed contributions updated at or after `sinceIso`.
   * Watermarking on updatedAt (not contributionDate) means a gift that changes
   * state after we first saw it comes back around for reconciliation.
   */
  contributions(sinceIso: string): Promise<OverflowContribution[]> {
    // statusBucket is an array param — it must be sent as statusBucket[]=…,
    // and the brackets must stay literal (URLSearchParams would escape them).
    const q =
      `minimumUpdatedDate=${encodeURIComponent(sinceIso)}` +
      `&statusBucket[]=CONFIRMED`;
    return paginate<OverflowContribution>(`/api/v3/contributions?${q}`);
  },

  deposits(): Promise<OverflowDeposit[]> {
    return paginate<OverflowDeposit>('/api/v3/deposits');
  },
};
