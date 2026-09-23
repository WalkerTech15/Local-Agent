/**
 * The auto-update state machine, as pure logic (Phase 3, Milestone 4).
 *
 * This module decides **what state an update check is in and which
 * transitions are legal**. It performs none of it: there is no network call,
 * no file write, and no installation here — see `docs/phase-3-auto-update.md`
 * for why no main-process module drives this yet. It exists now so that the
 * six states this milestone was asked for, and the rule that installing
 * requires explicit approval of a signed update from the trusted source, are
 * expressed as reviewed, tested code rather than only as documentation.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

/**
 * `idle` is not one of the six states the milestone brief names
 * (`checking`, `available`, `downloading`, `downloaded`, `error`,
 * `disabled`) — it is the necessary seventh: "updates are enabled by
 * configuration, but nothing has happened yet." Without it, the only legal
 * initial state for an *enabled* configuration would have to be `checking`,
 * which would mean a check starts itself the moment updates become enabled
 * — exactly the silent, automatic behavior this milestone's security rule
 * forbids. `idle` is what lets "enabled" and "currently doing something"
 * stay separate.
 */
export const UPDATE_STATES = [
  'disabled',
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'error',
] as const;

export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_EVENTS = [
  /** Configuration resolved updates as enabled; the only way out of `disabled`. */
  'enable',
  /** Configuration resolved updates as disabled; always legal, from any state. */
  'disable',
  /** The user or a scheduled check requested a check. Never fires itself. */
  'check',
  /** The check found no newer version. */
  'noUpdateFound',
  /** The check found a newer version, from the trusted, configured source. */
  'updateFound',
  /** The check failed (network, malformed feed, or anything else). */
  'checkFailed',
  /** The user explicitly approved downloading the update that was found. */
  'approveDownload',
  /** The download finished and its signature verified against the trusted source. */
  'downloadSucceeded',
  /** The download failed, or its signature did not verify. */
  'downloadFailed',
  /** The user or the interface dismissed an error, returning to `idle`. */
  'dismissError',
] as const;

export type UpdateEvent = (typeof UPDATE_EVENTS)[number];

/**
 * The one legal transition table. Any pair not listed here is illegal and
 * {@link transitionUpdateState} returns `null` for it rather than guessing.
 *
 * Notably absent: nothing transitions `downloaded` anywhere on its own.
 * Installing a downloaded update is not a state in this table at all — it is
 * a separate, explicitly guarded action (see `canInstallUpdate` in
 * `guard.ts`) precisely so that reaching `downloaded` can never, by itself,
 * be mistaken for permission to replace the running application.
 */
const TRANSITIONS: Readonly<Record<UpdateState, Partial<Record<UpdateEvent, UpdateState>>>> = {
  disabled: { enable: 'idle' },
  idle: { disable: 'disabled', check: 'checking' },
  checking: {
    disable: 'disabled',
    noUpdateFound: 'idle',
    updateFound: 'available',
    checkFailed: 'error',
  },
  available: { disable: 'disabled', approveDownload: 'downloading' },
  downloading: {
    disable: 'disabled',
    downloadSucceeded: 'downloaded',
    downloadFailed: 'error',
  },
  downloaded: { disable: 'disabled' },
  error: { disable: 'disabled', dismissError: 'idle' },
};

/**
 * Applies one event to one state, or returns `null` if that event is not
 * legal from that state — for example, `approveDownload` from `idle` (there
 * is nothing to approve yet), or `check` from `disabled` (updates are off).
 */
export function transitionUpdateState(state: UpdateState, event: UpdateEvent): UpdateState | null {
  return TRANSITIONS[state][event] ?? null;
}
