# Memory and learning service requirements

**Code:** MEM  
**Owns:** working, warm, episodic, semantic, and archive memory and governed learning  
**Direct dependencies:** IDN, POL, AUD  
**Parent:** [Agent Dev requirements](../../requirements.md)

## Purpose

Preserve useful knowledge at different latency, durability, and governance levels.

## Memory tiers

| Tier | Name | Typical contents | Lifetime/access |
|---|---|---|---|
| M0 | Working | Current turn, tool result, active summary | Volatile operation |
| M1 | Warm | Active task/meeting, recent decisions, evidence pointers | Active session/work |
| M2 | Episodic | Tasks, meetings, incidents, reviews, outcomes | Project retention |
| M3 | Semantic | Approved facts, conventions, skills, architecture | Durable/versioned |
| M4 | Archive/source | Approved raw transcripts, documents, artifacts | Restricted/retained |

## Requirements

- **MEM-01:** Store source, actor, observed and ingested time, project, data class, ACL, retention,
  consent, confidence, and provenance.
- **MEM-02:** Derived memory links to sources and extraction or model version.
- **MEM-03:** Enforce agent, task, project, and participant access before retrieval ranking.
- **MEM-04:** Warm-up retrieves minimum relevant context with citations.
- **MEM-05:** Distinguish fact, instruction, preference, decision, hypothesis, skill, and outcome.
- **MEM-06:** Untrusted content cannot become policy, credential authority, or global knowledge.
- **MEM-07:** Episodic-to-semantic or shared promotion requires approval or a versioned rule.
- **MEM-08:** Preserve and surface conflicts until authorized supersession.
- **MEM-09:** Correction and deletion propagate to indexes, embeddings, summaries, caches, and
  projections.
- **MEM-10:** Expiry deletes or irreversibly anonymizes as policy requires.
- **MEM-11:** Retrieval includes source and confidence and is evidence, not authority.
- **MEM-12:** Reusable procedure learning requires verified outcomes and scope review.
- **MEM-13:** Abstract the backend so Ditto can be validated and replaced.
- **MEM-14:** Measure relevance, staleness, correction propagation, and access denials.

## Acceptance

Facts retrieve with citations, cannot cross project ACLs, and deletion removes every searchable
derivative within target.

## Related requirements

- [Model and memory dependencies](../dependencies/models-memory.md)
- [Identity, role, and persona](./identity-role-persona.md)
- [Policy, risk, and approval](./policy-risk-approval.md)
