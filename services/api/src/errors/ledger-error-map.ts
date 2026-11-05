import { LedgerErrorCode } from "@orderflow/db";

import type { ApiErrorCode } from "./error-response.js";

const MAPPED: Partial<Record<LedgerErrorCode, ApiErrorCode>> = {
  [LedgerErrorCode.ACCOUNT_NOT_FOUND]: "ACCOUNT_NOT_FOUND",
  [LedgerErrorCode.INVALID_CURRENCY]: "INVALID_CURRENCY",
  [LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER]: "TREASURY_HAS_NO_BUYING_POWER",
};

/** The API's answer to a ledger refusal. Any code not mapped here is a 500 with no detail. */
export const apiCodeForLedgerError = (code: LedgerErrorCode): ApiErrorCode =>
  MAPPED[code] ?? "INTERNAL_ERROR";
