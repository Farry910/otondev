import type { ActionClass } from '@otondev/contracts';
import type { ServiceClient } from '../hooks.js';

/**
 * Presence-plane client interfaces, S15-S17.
 *
 * All three are gated (meeting platform, Windows spike), and all three have their interface
 * authored here anyway. Implementation-plan §7: "Their **interfaces** should still be
 * authored in Wave 0 so nothing downstream is blocked." The Agent Core needs to compile
 * against a presence client long before a meeting platform is chosen.
 */

// --------------------------------------------------------------------------- S15 Presence

export interface MeetingPreflight {
  meeting_ref: string;
  /** Authorization and consent are separate questions with separate answers. */
  authorized: boolean;
  consent_established: boolean;
  disclosure_required: boolean;
  blocking_reasons: string[];
}

export interface MeetingSession {
  meeting_id: string;
  state:
    | 'preflight'
    | 'joining'
    | 'disclosed'
    | 'listening'
    | 'speaking'
    | 'interrupted'
    | 'handed_over'
    | 'left';
  /** The warm-up bundle this session is grounded in, and when it goes stale. */
  warmup_ref: string | null;
  warmup_expires_at: string | null;
}

export type SpeakOutcome =
  | { spoken: true; utterance_ref: string }
  /**
   * The grounded-response gate. A response the agent cannot ground in authorized evidence is
   * withheld and said to be withheld — it never degrades into a plausible guess, because in
   * a meeting a plausible guess is indistinguishable from a fact.
   */
  | { spoken: false; reason: 'ungrounded' | 'stale_warmup' | 'consent_missing' | 'interrupted' };

export interface PresenceClient extends ServiceClient {
  preflight(meetingRef: string): Promise<MeetingPreflight>;
  join(meetingRef: string): Promise<MeetingSession>;
  state(meetingId: string): Promise<MeetingSession>;
  speak(meetingId: string, text: string): Promise<SpeakOutcome>;
  /**
   * A spoken request for a privileged tool becomes an ordinary Core decision request and
   * cannot execute in the voice session (S15 exit criterion). This returns the request id;
   * it does not, and cannot, execute anything.
   */
  referToCore(meetingId: string, action: ActionClass, utterance: string): Promise<{ decision_request_id: string }>;
  handOverToOperator(meetingId: string, operator: string): Promise<MeetingSession>;
  leave(meetingId: string, reason: string): Promise<void>;
}

// ------------------------------------------------------------- S16 Presentation controller

export interface SharePreflight {
  /** Catches a stale commit or the wrong environment before anything is shown. */
  commit_matches: boolean;
  environment_matches: boolean;
  /** Notifications, secret managers, unrelated windows. Any hit blocks the share. */
  unsafe_surfaces: string[];
  safe_to_share: boolean;
}

export interface LocatorResult {
  strategy: 'product_api' | 'playwright' | 'uia' | 'ocr' | 'coordinates' | 'static_artifact';
  found: boolean;
  /** True when the locator matched more than one candidate — falls back rather than guessing. */
  ambiguous: boolean;
}

export interface PresentationControllerClient extends ServiceClient {
  preflight(input: { expected_commit: string; expected_environment: string }): Promise<SharePreflight>;
  show(target: string): Promise<LocatorResult>;
  annotate(target: string, note: string): Promise<LocatorResult>;
  /** A notification or secret popup during a share stops the share first (S16 criterion). */
  stopShare(reason: string): Promise<void>;
  /** Works with no network. Containment that needs the control plane is not containment. */
  localEmergencyStop(): Promise<void>;
}

// ------------------------------------------------------------------------- S17 Supervisor

export interface WindowsSession {
  session_id: number;
  user: string;
  state: 'active' | 'disconnected' | 'locked';
  interactive: boolean;
}

export interface CompanionProcess {
  companion_id: string;
  session_id: number;
  /** Must be false. The companion runs non-administrator (S17 exit criterion). */
  elevated: boolean;
  started_at: string;
}

/**
 * Session 0, non-interactive. It "never exposes a privileged UI and never accepts
 * unauthenticated IPC" — so there is no method here that shows anything, and every call
 * arrives over the mutually authenticated, ACL-restricted endpoint.
 */
export interface WindowsSupervisorClient extends ServiceClient {
  discoverSessions(): Promise<WindowsSession[]>;
  startCompanion(sessionId: number): Promise<CompanionProcess>;
  stopCompanion(companionId: string, reason: string): Promise<void>;
  /** Survives reboot, logoff, lock and reconnect, and works control-plane-unreachable. */
  contain(reason: string): Promise<{ companions_stopped: string[] }>;
}
