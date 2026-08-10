/**
 * Reason codes.
 *
 * Contracts §5 types `reason_codes` as a non-empty array matching `^[A-Z][A-Z0-9_]*$`, and
 * the S4 exit criterion requires every decision to be reproducible from its logged inputs.
 * Prose reasons defeat that twice: they are not comparable across two runs, and they tempt
 * whoever writes them into interpolating the input, which is how a parameter value ends up in
 * an audit record.
 *
 * So the vocabulary is closed and enumerated here. A decision carries codes; anything that
 * needs a value carries it in a separate, typed field.
 */
export const REASON_CODES = {
  // ---- allow -------------------------------------------------------------------
  AUTONOMY_SUFFICIENT: 'effective autonomy meets the action rule minimum',
  APPROVAL_PRESENT: 'a valid, correctly bound approval was supplied',
  WITHIN_COST_BUDGET: 'estimated cost is below the approval threshold',

  // ---- require approval --------------------------------------------------------
  APPROVAL_REQUIRED_BY_RULE: 'the action rule always requires a human approval',
  APPROVAL_REQUIRED_AUTONOMY: 'effective autonomy is below the action rule minimum',
  APPROVAL_REQUIRED_COST: 'estimated cost is above the approval threshold',

  // ---- deny --------------------------------------------------------------------
  DENIED_UNKNOWN_INPUT: 'an input is not described by the policy bundle',
  DENIED_UNKNOWN_ACTION: 'the bundle has no rule for this action class',
  DENIED_UNKNOWN_RESOURCE: 'the bundle does not list this resource',
  DENIED_ENVIRONMENT_NOT_PERMITTED: 'the action rule does not permit this environment',
  DENIED_DATA_CLASS_TOO_HIGH: 'the data class exceeds what the action rule permits',
  DENIED_COST_ABOVE_CEILING: 'estimated cost is above the deny threshold',
  DENIED_INCIDENT_MODE: 'an incident is declared and caps autonomy below the requirement',
  DENIED_TENANT_MISMATCH: 'the query targets a tenant the bundle does not govern',
  DENIED_SECRET_DATA_CLASS: 'secret-class data is illegal in a contract payload',

  // ---- approval lifecycle ------------------------------------------------------
  APPROVAL_NOT_FOUND: 'no approval record with that identifier',
  APPROVAL_EXPIRED: 'the approval passed its expiry',
  APPROVAL_CONSUMED: 'the approval has been used max_uses times',
  APPROVAL_REVOKED: 'the approval was revoked',
  APPROVAL_BINDING_MISMATCH: 'a bound field differs from what was approved',
  APPROVAL_AUTHN_TOO_WEAK: 'the approver did not meet the required authentication strength',
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export const ALL_REASON_CODES = Object.keys(REASON_CODES) as ReasonCode[];

/** Every code has to satisfy the contract's own pattern, checked in a test. */
export const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
