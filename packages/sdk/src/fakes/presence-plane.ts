import type { ActionClass } from '@otondev/contracts';
import { FakeServiceBase } from './base.js';
import type { FakeDefaults } from './base.js';
import type { RuntimeContext } from '../runtime.js';
import type { AgentCoreClient } from '../services/control-plane.js';
import type {
  CompanionProcess,
  LocatorResult,
  MeetingPreflight,
  MeetingSession,
  PresenceClient,
  PresentationControllerClient,
  SharePreflight,
  SpeakOutcome,
  WindowsSession,
  WindowsSupervisorClient,
} from '../services/presence-plane.js';
import { plusSeconds } from './support.js';

/**
 * Minimal in-memory fakes, S15-S17.
 *
 * All three are gated on a decision or a spike, so these fakes are the only presence
 * implementation that exists in Wave 0. That makes them load-bearing in an unusual way: the
 * Agent Core will be built against them for weeks. The behaviours that must be right are the
 * refusals — consent, grounding, staleness, and the fact that a spoken request cannot
 * execute anything.
 */

// ------------------------------------------------------------------------------- S15

export class FakePresence extends FakeServiceBase implements PresenceClient {
  readonly serviceId = 'presence' as const;
  readonly #sessions = new Map<string, MeetingSession>();
  readonly #core: AgentCoreClient;
  /** Meetings the tenant has established consent for. Everything else is refused. */
  consentedMeetings = new Set<string>();
  authorizedMeetings = new Set<string>();
  /** Claims the agent can ground. Anything else is withheld, never improvised. */
  groundedClaims = new Set<string>();
  warmupTtlSeconds = 600;

  constructor(runtime: RuntimeContext, defaults: FakeDefaults, deps: { core: AgentCoreClient }) {
    super(runtime, defaults);
    this.#core = deps.core;
  }

  async preflight(meetingRef: string): Promise<MeetingPreflight> {
    const authorized = this.authorizedMeetings.has(meetingRef);
    const consent = this.consentedMeetings.has(meetingRef);
    const blocking: string[] = [];
    if (!authorized) blocking.push('not authorized to join this meeting');
    if (!consent) blocking.push('recording and participation consent not established');
    return {
      meeting_ref: meetingRef,
      authorized,
      consent_established: consent,
      disclosure_required: true,
      blocking_reasons: blocking,
    };
  }

  async join(meetingRef: string): Promise<MeetingSession> {
    this.assertNotDenied();
    const preflight = await this.preflight(meetingRef);
    // Consent is a precondition of joining, not something to obtain afterwards.
    if (preflight.blocking_reasons.length > 0) {
      this.fail('PRESENCE_CONSENT_REQUIRED', { blocking: preflight.blocking_reasons.join('; ') });
    }
    const meetingId = this.id('meeting');
    const session: MeetingSession = {
      meeting_id: meetingId,
      state: 'disclosed',
      warmup_ref: this.id('artifact'),
      warmup_expires_at: plusSeconds(this.runtime.clock, this.warmupTtlSeconds),
    };
    this.#sessions.set(meetingId, session);
    return session;
  }

  async state(meetingId: string): Promise<MeetingSession> {
    const session = this.#sessions.get(meetingId);
    if (session === undefined) this.fail('INTERNAL', { reason: 'unknown meeting' });
    return session;
  }

  async speak(meetingId: string, text: string): Promise<SpeakOutcome> {
    const session = await this.state(meetingId);
    if (session.warmup_expires_at !== null && Date.parse(session.warmup_expires_at) <= this.runtime.clock.nowMs()) {
      // Stale context is declared stale rather than spoken (S15 exit criterion). In a meeting
      // a confident stale answer is indistinguishable from a correct one.
      return { spoken: false, reason: 'stale_warmup' };
    }
    if (!this.groundedClaims.has(text)) return { spoken: false, reason: 'ungrounded' };
    this.#sessions.set(meetingId, { ...session, state: 'speaking' });
    return { spoken: true, utterance_ref: this.id('artifact') };
  }

  /**
   * A privileged request made out loud becomes an ordinary Core decision request. Note that
   * this returns an id and nothing else: there is no path from here to execution, which is
   * the S15 exit criterion stated as a return type.
   */
  async referToCore(meetingId: string, action: ActionClass, _utterance: string): Promise<{ decision_request_id: string }> {
    const session = await this.state(meetingId);
    const request = await this.#core.requestDecision(session.meeting_id, action);
    return { decision_request_id: request.id };
  }

  async handOverToOperator(meetingId: string, _operator: string): Promise<MeetingSession> {
    const session = await this.state(meetingId);
    const handed: MeetingSession = { ...session, state: 'handed_over' };
    this.#sessions.set(meetingId, handed);
    return handed;
  }

  async leave(meetingId: string, _reason: string): Promise<void> {
    const session = this.#sessions.get(meetingId);
    if (session === undefined) return;
    this.#sessions.set(meetingId, { ...session, state: 'left' });
  }

  override async quarantine(request: Parameters<FakeServiceBase['quarantine']>[0]) {
    const left: string[] = [];
    for (const session of this.#sessions.values()) {
      if (session.state === 'left') continue;
      this.#sessions.set(session.meeting_id, { ...session, state: 'left' });
      left.push(session.meeting_id);
    }
    void request;
    return this.control.ack('contained', left);
  }
}

// ------------------------------------------------------------------------------- S16

export class FakePresentationController extends FakeServiceBase implements PresentationControllerClient {
  readonly serviceId = 'companion' as const;
  currentCommit = '';
  currentEnvironment = '';
  /** Surfaces that must never be on screen during a share. */
  visibleUnsafeSurfaces = new Set<string>();
  /** Locators that resolve to more than one candidate. */
  ambiguousTargets = new Set<string>();
  knownTargets = new Set<string>();
  sharing = false;
  stopped = false;

  async preflight(input: { expected_commit: string; expected_environment: string }): Promise<SharePreflight> {
    const commitMatches = this.currentCommit === input.expected_commit;
    const environmentMatches = this.currentEnvironment === input.expected_environment;
    const unsafe = [...this.visibleUnsafeSurfaces];
    return {
      commit_matches: commitMatches,
      environment_matches: environmentMatches,
      unsafe_surfaces: unsafe,
      safe_to_share: commitMatches && environmentMatches && unsafe.length === 0,
    };
  }

  async show(target: string): Promise<LocatorResult> {
    return this.#locate(target);
  }

  async annotate(target: string, _note: string): Promise<LocatorResult> {
    return this.#locate(target);
  }

  async stopShare(_reason: string): Promise<void> {
    this.sharing = false;
  }

  /** Works with no network. Containment that needs the control plane is not containment. */
  async localEmergencyStop(): Promise<void> {
    this.sharing = false;
    this.stopped = true;
  }

  #locate(target: string): LocatorResult {
    // An ambiguous locator falls back to the approved static artifact rather than picking a
    // candidate (S16 exit criterion). Guessing on a shared screen is guessing in public.
    if (this.ambiguousTargets.has(target)) {
      return { strategy: 'static_artifact', found: true, ambiguous: true };
    }
    if (!this.knownTargets.has(target)) {
      return { strategy: 'static_artifact', found: false, ambiguous: false };
    }
    return { strategy: 'product_api', found: true, ambiguous: false };
  }
}

// ------------------------------------------------------------------------------- S17

export class FakeWindowsSupervisor extends FakeServiceBase implements WindowsSupervisorClient {
  readonly serviceId = 'supervisor' as const;
  readonly #companions = new Map<string, CompanionProcess>();
  sessions: WindowsSession[] = [{ session_id: 1, user: 'agent', state: 'active', interactive: true }];
  /** Callers the IPC ACL admits. Anything else is refused, as if it never connected. */
  authorizedCallers = new Set<string>(['supervisor-admin']);

  async discoverSessions(): Promise<WindowsSession[]> {
    return this.sessions;
  }

  async startCompanion(sessionId: number): Promise<CompanionProcess> {
    this.assertNotDenied();
    const session = this.sessions.find((candidate) => candidate.session_id === sessionId);
    if (session === undefined || !session.interactive) {
      this.fail('INTERNAL', { reason: 'no interactive session' });
    }
    const companionId = this.id('workload');
    const companion: CompanionProcess = {
      companion_id: companionId,
      session_id: sessionId,
      // Non-administrator, always. A companion that can elevate is a companion that will.
      elevated: false,
      started_at: this.runtime.clock.nowIso(),
    };
    this.#companions.set(companionId, companion);
    return companion;
  }

  async stopCompanion(companionId: string, _reason: string): Promise<void> {
    this.#companions.delete(companionId);
  }

  async contain(_reason: string): Promise<{ companions_stopped: string[] }> {
    const stopped = [...this.#companions.keys()];
    this.#companions.clear();
    return { companions_stopped: stopped };
  }

  /** Test seam for the IPC ACL: an unauthorized local caller gets nothing. */
  ipcCall(caller: string, method: string): { accepted: boolean; reason: string } {
    if (!this.authorizedCallers.has(caller)) {
      return { accepted: false, reason: 'caller is not in the endpoint ACL' };
    }
    return { accepted: true, reason: method };
  }

  override async quarantine(request: Parameters<FakeServiceBase['quarantine']>[0]) {
    const { companions_stopped } = await this.contain(request.reason);
    return this.control.ack('contained', companions_stopped);
  }
}
