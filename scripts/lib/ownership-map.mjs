/**
 * Path ownership — the machine-readable form of implementation-plan §4 and §6 rule 2.
 *
 * Property 1 of an independently buildable package is "owns exactly one top-level
 * directory", enforced here. Two invariants:
 *
 *   - every tracked file is owned by exactly one card (no unowned, no overlap);
 *   - a branch may only change files its card owns.
 *
 * Directories that do not exist yet are listed anyway. They are reservations: a Wave-1
 * session creates its directory and needs no edit to this file, which is W0/S20-owned.
 */

/** @typedef {{ id: string, title: string, owns: string[], sharedWith?: string[] }} OwnershipEntry */

/** @type {OwnershipEntry[]} */
export const OWNERSHIP = [
  {
    id: 'W0',
    title: 'Foundation — scaffold, contracts, testkit, sdk',
    owns: [
      'package.json',
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'tsconfig.json',
      'tsconfig.base.json',
      'eslint.config.js',
      'vitest.config.ts',
      '.dependency-cruiser.cjs',
      '.npmrc',
      'docker-compose.dev.yml',
      '.github/**',
      'scripts/**',
      'infra/dev/**',
      'packages/contracts/**',
      'packages/testkit/**',
      'packages/sdk/**',
      'packages/example-consumer/**',
    ],
    // S20 inherits the shared files once the vertical slice starts moving (§6 rule 4).
    sharedWith: ['S20'],
  },
  {
    id: 'META',
    title: 'Design package and delivery board',
    owns: [
      'doc/**',
      'board/**',
      'README.md',
      'CLAUDE.md',
      'CONTRACT-REQUESTS.md',
      '.gitignore',
      '.gitattributes',
    ],
    // Every session appends to its own card and may file a contract request.
    sharedWith: ['*'],
  },

  // ---- Stage-0 spikes ------------------------------------------------------
  // Added by SP2. The map has to be *total* — the audit fails on any tracked file no card
  // claims — and it was written during W0, before the spike cards existed. The first spike
  // to land a directory would otherwise have turned `main` red for every other session.
  // Recorded as a contract request against the W0/S20-owned file rather than done silently.
  { id: 'SP1', title: 'Windows session spike', owns: ['spikes/windows-session/**'] },
  { id: 'SP2', title: 'Sandbox isolation spike', owns: ['spikes/sandbox-isolation/**'] },
  { id: 'SP3', title: 'Ditto behaviour spike', owns: ['spikes/ditto-behaviour/**'] },
  { id: 'SP4', title: 'Connector semantics spike', owns: ['spikes/connector-semantics/**'] },
  { id: 'SP5', title: 'Presence platform and voice path spike', owns: ['spikes/presence-platform/**'] },

  // ---- control plane -------------------------------------------------------
  { id: 'S1', title: 'Event Ingress and Dedupe', owns: ['services/ingress/**'] },
  { id: 'S2', title: 'Workflow Engine', owns: ['services/workflow/**'] },
  { id: 'S3', title: 'Agent Core Runtime', owns: ['services/core/**'] },
  { id: 'S4', title: 'Policy and Approval', owns: ['services/policy/**'] },
  { id: 'S5', title: 'Capability and Credential Broker', owns: ['services/broker/**'] },
  { id: 'S6', title: 'Cognition Gateway', owns: ['services/cognition/**'] },
  { id: 'S7', title: 'Connector Broker', owns: ['services/connectors/**'] },
  {
    id: 'S8',
    title: 'Audit and Telemetry',
    owns: ['services/audit/**', 'packages/telemetry/**'],
  },

  // ---- execution plane -----------------------------------------------------
  { id: 'S9', title: 'Evidence and Artifact Store', owns: ['services/evidence/**'] },
  { id: 'S10', title: 'Workspace and Sandbox Manager', owns: ['services/workspace/**'] },
  { id: 'S11', title: 'Task Executor and Tool Runner', owns: ['services/executor/**'] },
  { id: 'S12', title: 'Verifier and Definition of Done', owns: ['services/verifier/**'] },

  // ---- data plane ----------------------------------------------------------
  { id: 'S13', title: 'Memory Service core', owns: ['services/memory/**'] },
  { id: 'S14', title: 'Ditto storage adapter', owns: ['services/memory-ditto/**'] },

  // ---- presence plane ------------------------------------------------------
  { id: 'S15', title: 'Presence Service', owns: ['services/presence/**'] },
  { id: 'S16', title: 'Presentation Controller', owns: ['windows/companion/**'] },
  { id: 'S17', title: 'Windows Supervisor', owns: ['windows/supervisor/**'] },

  // ---- cross-cutting -------------------------------------------------------
  { id: 'S18', title: 'Operator Control and Emergency Stop', owns: ['services/operator/**'] },
  { id: 'S19', title: 'Evaluation and Conformance Harness', owns: ['eval/**'] },
  { id: 'S20', title: 'Integration and Vertical Slice', owns: ['integration/**'] },
];

/**
 * Branch naming from board/README.md §3 and implementation-plan §6 rule 1:
 * `wf/W0-foundation`, `svc/S7-connectors`.
 */
export const BRANCH_CARD_PATTERN = /^(?:wf|svc)\/([A-Z]?\d+|W\d+|S\d+)-/;
