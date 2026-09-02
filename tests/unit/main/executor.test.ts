import { describe, expect, it, vi } from 'vitest';

import { ActionExecutionError, ExecutorInvariantError, execute } from '../../../src/main/executor';
import type { ActionProposal, PermissionVerdict } from '../../../src/shared/types';

const CORRELATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const proposal: ActionProposal = {
  actionType: 'settings.write',
  parameters: {},
  correlationId: CORRELATION_ID,
};

function verdict(overrides: Partial<PermissionVerdict>): PermissionVerdict {
  return {
    decision: 'allow',
    reason: 'test',
    emergencyStopEngaged: false,
    confirmationRequired: false,
    ...overrides,
  };
}

describe('execute — deny', () => {
  it('never calls perform', async () => {
    const perform = vi.fn();
    await execute({ proposal, verdict: verdict({ decision: 'deny' }), perform });
    expect(perform).not.toHaveBeenCalled();
  });

  it('returns a denied outcome carrying the correlationId', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'deny' }),
      perform: vi.fn(),
    });
    expect(result).toEqual({ outcome: 'denied', correlationId: CORRELATION_ID });
  });
});

describe('execute — confirm without a resolved confirmationResult', () => {
  it('throws ExecutorInvariantError and never calls perform', async () => {
    const perform = vi.fn();
    await expect(
      execute({ proposal, verdict: verdict({ decision: 'confirm' }), perform }),
    ).rejects.toThrow(ExecutorInvariantError);
    expect(perform).not.toHaveBeenCalled();
  });
});

describe('execute — confirm, rejected', () => {
  it('never calls perform', async () => {
    const perform = vi.fn();
    await execute({
      proposal,
      verdict: verdict({ decision: 'confirm' }),
      confirmationResult: 'rejected',
      perform,
    });
    expect(perform).not.toHaveBeenCalled();
  });

  it('returns an aborted outcome recording the rejection', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'confirm' }),
      confirmationResult: 'rejected',
      perform: vi.fn(),
    });
    expect(result).toEqual({
      outcome: 'aborted',
      correlationId: CORRELATION_ID,
      confirmationResult: 'rejected',
    });
  });
});

describe('execute — confirm, approved', () => {
  it('calls perform exactly once', async () => {
    const perform = vi.fn().mockResolvedValue('done');
    await execute({
      proposal,
      verdict: verdict({ decision: 'confirm' }),
      confirmationResult: 'approved',
      perform,
    });
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it('returns a success outcome carrying the approved confirmation and the value', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'confirm' }),
      confirmationResult: 'approved',
      perform: () => 'result-value',
    });
    expect(result).toEqual({
      outcome: 'success',
      correlationId: CORRELATION_ID,
      value: 'result-value',
      confirmationResult: 'approved',
    });
  });
});

describe('execute — allow', () => {
  it('calls perform exactly once with no confirmation required', async () => {
    const perform = vi.fn().mockReturnValue(42);
    const result = await execute({ proposal, verdict: verdict({ decision: 'allow' }), perform });
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'success',
      correlationId: CORRELATION_ID,
      value: 42,
      confirmationResult: undefined,
    });
  });

  it('supports an async perform', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'allow' }),
      perform: async () => {
        await Promise.resolve();
        return 'async-value';
      },
    });
    expect(result.outcome).toBe('success');
    expect(result.value).toBe('async-value');
  });
});

describe('execute — perform failure', () => {
  it('reports a generic stable error code for an ordinary thrown Error', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'allow' }),
      perform: () => {
        throw new Error(
          'a raw message that must never reach the caller as-is: C:\\Users\\real\\path',
        );
      },
    });
    expect(result.outcome).toBe('failure');
    expect(result.errorCode).toBe('EXECUTION_FAILED');
  });

  it('reports the specific code from a thrown ActionExecutionError', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'allow' }),
      perform: () => {
        throw new ActionExecutionError('SETTINGS_WRITE_FAILED');
      },
    });
    expect(result.outcome).toBe('failure');
    expect(result.errorCode).toBe('SETTINGS_WRITE_FAILED');
  });

  it('reports failure with the resolved confirmationResult when perform fails after approval', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'confirm' }),
      confirmationResult: 'approved',
      perform: () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({
      outcome: 'failure',
      correlationId: CORRELATION_ID,
      errorCode: 'EXECUTION_FAILED',
      confirmationResult: 'approved',
    });
  });

  it('never lets a rejected promise from perform escape uncaught', async () => {
    const result = await execute({
      proposal,
      verdict: verdict({ decision: 'allow' }),
      perform: () => Promise.reject(new Error('async failure')),
    });
    expect(result.outcome).toBe('failure');
    expect(result.errorCode).toBe('EXECUTION_FAILED');
  });
});

describe('execute — correlationId propagation', () => {
  it('carries the correlationId through every branch', async () => {
    const anotherProposal: ActionProposal = {
      ...proposal,
      correlationId: '9c858901-8a57-4791-81fe-4c455b099bc9',
    };
    const denyResult = await execute({
      proposal: anotherProposal,
      verdict: verdict({ decision: 'deny' }),
      perform: vi.fn(),
    });
    expect(denyResult.correlationId).toBe('9c858901-8a57-4791-81fe-4c455b099bc9');
  });
});
