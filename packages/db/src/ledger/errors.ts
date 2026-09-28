/**
 * Why the ledger API refused a call. Each code names one rule in docs/domain/ledger.md or
 * docs/domain/accounts.md, so a caller can branch on the rule rather than on message text.
 */
export const LedgerErrorCode = {
  /** ledger.md section 3: a transaction has at least two entries. */
  TOO_FEW_ENTRIES: "TOO_FEW_ENTRIES",
  /** ledger.md section 2: an amount is never zero. */
  ZERO_AMOUNT: "ZERO_AMOUNT",
  /** ledger.md section 3: a transaction's entries sum to zero for each currency. */
  UNBALANCED: "UNBALANCED",
  /** ledger.md section 7: a currency is three or four uppercase letters. */
  INVALID_CURRENCY: "INVALID_CURRENCY",
  /** ledger.md section 7: NUMERIC(38, 18) cannot hold the amount without rounding it. */
  AMOUNT_NOT_REPRESENTABLE: "AMOUNT_NOT_REPRESENTABLE",
  /** ledger.md section 4: in M0 only a human with database access writes a CORRECTION. */
  CORRECTION_NOT_ALLOWED: "CORRECTION_NOT_ALLOWED",
  /** accounts.md section 2: entries and holds reference an account that exists. */
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  /** ledger.md section 6, accounts.md section 6: treasury minus X, one account plus X. */
  INVALID_DEPOSIT_SHAPE: "INVALID_DEPOSIT_SHAPE",
  /** accounts.md section 6: the treasury is only ever the source of a DEPOSIT. */
  TREASURY_NOT_ALLOWED: "TREASURY_NOT_ALLOWED",
  /** ledger.md section 3: a cause key already names a different transaction. */
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  /** ledger.md section 3: a cause key was written concurrently inside the caller's transaction. */
  DUPLICATE_CAUSE_KEY: "DUPLICATE_CAUSE_KEY",
  /** accounts.md sections 4.3 and 5: the debit or hold exceeds buying power. */
  INSUFFICIENT_BUYING_POWER: "INSUFFICIENT_BUYING_POWER",
  /** accounts.md section 4.1: a hold holds a positive amount. */
  NON_POSITIVE_HOLD: "NON_POSITIVE_HOLD",
  /** accounts.md section 5: the treasury places no orders and has no buying power. */
  TREASURY_HAS_NO_BUYING_POWER: "TREASURY_HAS_NO_BUYING_POWER",
} as const;

export type LedgerErrorCode = (typeof LedgerErrorCode)[keyof typeof LedgerErrorCode];

/** The only error the ledger API throws for a rule it enforces. */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "LedgerError";
    this.code = code;
  }
}
