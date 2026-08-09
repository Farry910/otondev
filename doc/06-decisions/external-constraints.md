# External platform constraints and references

**Checked:** 2026-07-30  
**Purpose:** record vendor facts that materially changed architecture v2. These are supporting facts,
not substitutes for tests in the target environment.

## Windows service and desktop sessions

Microsoft documents that services cannot directly interact with a user on modern Windows and
recommends a separate GUI process in the interactive user context communicating with the service over
IPC. Services normally use a noninteractive window station/session 0. Therefore the presence design
uses a non-interactive Windows service plus a least-privilege interactive companion, not one service
driving UI directly.

Source: [Microsoft Learn — Interactive Services](https://learn.microsoft.com/en-us/windows/win32/services/interactive-services)

## Windows secret protection

Microsoft documents that DPAPI-protected data is tied to a security descriptor such as a user SID and
may become unrecoverable if that protection context disappears; critical data needs a separate recovery
strategy. Windows Credential Manager/DPAPI is therefore an at-rest option for the controlled demo, not
the full production capability boundary.

Sources: [Microsoft Learn — Data protection](https://learn.microsoft.com/en-us/windows/apps/develop/security/data-protection) ·
[Microsoft Learn — Handling Passwords](https://learn.microsoft.com/en-us/windows/win32/secbp/handling-passwords)

## Windows isolation

Microsoft describes AppContainer/Win32 isolation as a least-privilege boundary and Windows Sandbox as
a disposable Hyper-V-based desktop for untrusted applications. Windows Sandbox discards state when
closed and has configurable/default device/network/clipboard behavior; it is not the persistent agent
desktop. The design treats task isolation and presence as separate zones.

Sources: [Microsoft Learn — Application isolation](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-isolation) ·
[Windows Sandbox FAQ](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-faq) ·
[Windows Sandbox configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

## Ditto consistency and transactions

Ditto documents local-first peer synchronization, CRDT conflict handling, and causal consistency.
Ditto also documents atomic/serializable local read-write transactions, while noting that peers with
partial subscriptions may receive only a subset of transaction changes and temporary replicated
atomicity can be affected. That makes Ditto plausible for memory projections and selective sharing, but
not automatically suitable as the global authority for leases, approvals, fencing, or exactly-once
external side effects.

Sources: [Ditto — Syncing Data](https://docs.ditto.live/key-concepts/syncing-data) ·
[Ditto — Transactions](https://docs.ditto.live/sdk/latest/crud/transactions)

## OpenAI Realtime

OpenAI's current model documentation describes `gpt-realtime` as supporting realtime audio/text over
WebRTC, WebSocket, or SIP and function calling. It is a viable provider candidate for the voice adapter,
not a reason to expose mutating functions directly or couple the whole architecture to one provider.

Source: [OpenAI API — GPT-Realtime model](https://developers.openai.com/api/docs/models/gpt-realtime)

## Prompt injection and agent tools

OWASP describes direct and indirect prompt injection through code, issues, web/document content, tool
output, memory/RAG, and multimodal inputs, including unauthorized tool use and exfiltration. Its defense
guidance combines instruction/data separation, validation, least privilege, output/action monitoring,
human oversight, and testing; it does not present a single classifier as sufficient. The architecture
therefore treats all retrieved content as untrusted and keeps policy/capability authorization outside
model output.

Sources: [OWASP — LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) ·
[OWASP — AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)

## Verification rule

Recheck these sources and the target vendor versions during Stage 0. Architecture claims must be
validated with real tenant, OS image, SDK, provider, and meeting-client tests before implementation is
declared ready.
