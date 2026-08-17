# Team platform dependency requirements

**Parent:** [Agent Dev requirements](../../requirements.md)

## Ticket platform

- **TPD-01:** The demo MUST qualify one ticket platform; Jira is the proposed default.
- **TPD-02:** The adapter MUST support authenticated events, read, claim or assignment, status,
  comment, link, and idempotent update operations required by the demo journey.
- **TPD-03:** Source event verification, pagination, rate limits, edit/delete semantics, and uncertain
  write reconciliation MUST be tested.
- **TPD-04:** The demo MUST use a sandbox project and least-privilege service identity.

## Source control and pull requests

- **TPD-05:** The demo MUST qualify one source-control and PR platform; GitHub is the proposed default.
- **TPD-06:** The adapter MUST support repository read, isolated branch push, draft PR creation,
  status/check reads, review comments, and immutable revision references.
- **TPD-07:** Protected branches, app or token scopes, webhook verification, idempotency, and
  self-approval prevention MUST be tested.
- **TPD-08:** No demo credential may bypass protected-branch policy.

## Team chat

- **TPD-09:** The demo MUST qualify one team chat platform.
- **TPD-10:** The agent MUST have a visible bot identity and enforce workspace, channel, thread, and
  audience access.
- **TPD-11:** The adapter MUST define send, edit, delete, retry, deduplication, mention, attachment,
  and rate-limit behavior.
- **TPD-12:** A chat outage MUST retain one pending delivery record rather than duplicate messages.

## Calendar and conferencing

- **TPD-13:** The meeting demo MUST qualify one calendar and conferencing platform.
- **TPD-14:** Qualification MUST confirm bot participation, invitation verification, identity
  disclosure, participant access, mute, removal, screen-share control, and consent behavior.
- **TPD-15:** Meeting and calendar credentials MUST be separate from general task credentials.
- **TPD-16:** A platform that cannot meet required disclosure, interruption, consent, or takeover
  controls MUST NOT be used for the meeting demo.

## Consumers

- [Ingress and normalization](../services/ingress-normalization.md)
- [Connector and tool gateway](../services/connector-tool-gateway.md)
- [Presence and real-time communication](../services/presence-realtime.md)
- [Collaboration and delivery](../services/collaboration-delivery.md)
