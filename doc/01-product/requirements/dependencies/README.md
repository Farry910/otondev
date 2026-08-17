# Dependency requirements

This directory defines every internal and external dependency class used by Agent Dev. Provider names
are initial candidates unless a product decision explicitly fixes them.

| Area | Document | Covers |
|---|---|---|
| Internal services | [Internal service dependencies](./internal-service-dependencies.md) | Allowed dependency directions and failure rules |
| Runtime and desktop | [Runtime and desktop](./runtime-desktop.md) | Windows VM, UI Automation, browser, IDE and developer tools |
| Models and memory | [Models and memory](./models-memory.md) | Ollama, cloud coding models, OpenAI Realtime, Ditto |
| Team platforms | [Team platforms](./team-platforms.md) | Ticketing, source control, chat, calendar, meetings |
| Platform infrastructure | [Platform infrastructure](./platform-infrastructure.md) | Secrets, database, events, evidence store, telemetry |

## Qualification standard

Before any external dependency is approved, its owner MUST document:

- **DQL-01:** exact product, edition, version, license, and cost model;
- **DQL-02:** supported authentication and least-privilege scopes;
- **DQL-03:** data sent, storage region, retention, training use, and deletion behavior;
- **DQL-04:** rate, context, concurrency, payload, and other operational limits;
- **DQL-05:** availability expectations and observable health;
- **DQL-06:** timeout, retry, idempotency, and uncertain-result reconciliation;
- **DQL-07:** sandbox, fake, or offline test strategy;
- **DQL-08:** upgrade, rollback, migration, and vendor-exit strategy; and
- **DQL-09:** owner and support escalation path.

All dependencies are governed by the [master product requirements](../../requirements.md).
