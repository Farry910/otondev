import type { Approval } from '@otondev/contracts';

/**
 * Approval persistence.
 *
 * An interface rather than a concrete store for one reason that matters and one that is
 * convenient. The one that matters: **consumption has to be atomic**. Two callers presenting
 * the same single-use approval must produce exactly one success, and that guarantee lives in
 * the storage layer — an in-memory map gets it from JavaScript's single-threaded turn, and
 * PostgreSQL gets it from a conditional UPDATE. Expressing it as a compare-and-set in the
 * interface means neither implementation can quietly not provide it.
 *
 * The convenient one: the offline test suite needs a store with no database.
 */
export interface PolicyStore {
  putApproval(approval: Approval): Promise<void>;
  getApproval(tenantId: string, approvalId: string): Promise<Approval | null>;

  /**
   * Replace `expectedUses` with `next` only if the stored record still shows `expectedUses`.
   *
   * Returns the stored record on success and `null` when the precondition failed, which the
   * caller must treat as "somebody else consumed it", not as an error to retry. This is the
   * same compare-and-set shape contracts §3 requires of workflow transitions; approval replay
   * is the same hazard wearing different clothes.
   */
  compareAndSetApproval(next: Approval, expectedUses: number): Promise<Approval | null>;

  /** For the operator surface and for tests. Never used in an authorisation path. */
  listApprovals(tenantId: string): Promise<Approval[]>;
}

export class InMemoryPolicyStore implements PolicyStore {
  readonly #approvals = new Map<string, Approval>();

  static #key(tenantId: string, approvalId: string): string {
    // Tenant-prefixed because `tenant_id` "is always part of storage keys and authorization
    // checks" (contracts §1). A bare id would let one tenant read another's approval by
    // guessing, and the guess is not hard once ids appear in a ticket comment.
    return `${tenantId}::${approvalId}`;
  }

  async putApproval(approval: Approval): Promise<void> {
    this.#approvals.set(InMemoryPolicyStore.#key(approval.tenant_id, approval.id), { ...approval });
  }

  async getApproval(tenantId: string, approvalId: string): Promise<Approval | null> {
    const found = this.#approvals.get(InMemoryPolicyStore.#key(tenantId, approvalId));
    return found === undefined ? null : { ...found };
  }

  async compareAndSetApproval(next: Approval, expectedUses: number): Promise<Approval | null> {
    const key = InMemoryPolicyStore.#key(next.tenant_id, next.id);
    const current = this.#approvals.get(key);
    if (current === undefined || current.uses !== expectedUses) return null;
    this.#approvals.set(key, { ...next });
    return { ...next };
  }

  async listApprovals(tenantId: string): Promise<Approval[]> {
    return [...this.#approvals.values()]
      .filter((approval) => approval.tenant_id === tenantId)
      .map((approval) => ({ ...approval }));
  }
}
