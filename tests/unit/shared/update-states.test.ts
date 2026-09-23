import { describe, expect, it } from 'vitest';

import { UPDATE_STATES, transitionUpdateState } from '../../../src/shared/update/states';
import type { UpdateEvent, UpdateState } from '../../../src/shared/update/states';

describe('transitionUpdateState', () => {
  it('starts disabled and only leaves disabled via an explicit enable event', () => {
    expect(transitionUpdateState('disabled', 'enable')).toBe('idle');
    expect(transitionUpdateState('disabled', 'check')).toBeNull();
    expect(transitionUpdateState('disabled', 'approveDownload')).toBeNull();
  });

  it('never starts a check on its own: idle only moves on an explicit check event', () => {
    expect(transitionUpdateState('idle', 'check')).toBe('checking');
    expect(transitionUpdateState('idle', 'approveDownload')).toBeNull();
    expect(transitionUpdateState('idle', 'downloadSucceeded')).toBeNull();
  });

  it('resolves a check to idle, available, or error, and nowhere else', () => {
    expect(transitionUpdateState('checking', 'noUpdateFound')).toBe('idle');
    expect(transitionUpdateState('checking', 'updateFound')).toBe('available');
    expect(transitionUpdateState('checking', 'checkFailed')).toBe('error');
    expect(transitionUpdateState('checking', 'approveDownload')).toBeNull();
  });

  it('never starts a download without an explicit approval event', () => {
    expect(transitionUpdateState('available', 'downloadSucceeded')).toBeNull();
    expect(transitionUpdateState('available', 'approveDownload')).toBe('downloading');
  });

  it('resolves a download to downloaded or error, and nowhere else', () => {
    expect(transitionUpdateState('downloading', 'downloadSucceeded')).toBe('downloaded');
    expect(transitionUpdateState('downloading', 'downloadFailed')).toBe('error');
    expect(transitionUpdateState('downloading', 'approveDownload')).toBeNull();
  });

  it('has no transition out of downloaded except disable — installing is not a state', () => {
    const events: UpdateEvent[] = [
      'enable',
      'check',
      'noUpdateFound',
      'updateFound',
      'checkFailed',
      'approveDownload',
      'downloadSucceeded',
      'downloadFailed',
      'dismissError',
    ];
    for (const event of events) {
      expect(transitionUpdateState('downloaded', event), event).toBeNull();
    }
    expect(transitionUpdateState('downloaded', 'disable')).toBe('disabled');
  });

  it('only leaves error via dismissError (back to idle) or disable', () => {
    expect(transitionUpdateState('error', 'dismissError')).toBe('idle');
    expect(transitionUpdateState('error', 'disable')).toBe('disabled');
    expect(transitionUpdateState('error', 'check')).toBeNull();
  });

  it('disable is legal from every state except disabled itself', () => {
    for (const state of UPDATE_STATES) {
      if (state === 'disabled') continue;
      expect(transitionUpdateState(state, 'disable'), state).toBe('disabled');
    }
    expect(transitionUpdateState('disabled', 'disable')).toBeNull();
  });

  it('covers every declared state in the transition table', () => {
    const reachable = new Set<UpdateState>();
    for (const state of UPDATE_STATES) {
      for (const event of [
        'enable',
        'disable',
        'check',
        'noUpdateFound',
        'updateFound',
        'checkFailed',
        'approveDownload',
        'downloadSucceeded',
        'downloadFailed',
        'dismissError',
      ] as const) {
        const next = transitionUpdateState(state, event);
        if (next !== null) reachable.add(next);
      }
    }
    for (const state of UPDATE_STATES) {
      expect(reachable.has(state), state).toBe(true);
    }
  });
});
