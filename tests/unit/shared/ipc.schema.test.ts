import { describe, expect, it } from 'vitest';

import { CHAT_PROVIDER_ERROR_CODES } from '../../../src/shared/chat/provider';
import {
  API_KEY_MAX_LENGTH,
  CHAT_CONVERSATION_MAX_MESSAGES,
  CHAT_STREAM_MAX_DELTA_LENGTH,
  MODEL_PROVIDERS,
  UI_LANGUAGES,
} from '../../../src/shared/constants';
import { createDefaultSettings } from '../../../src/shared/schemas/settings.schema';
import {
  chatCancelRequestSchema,
  chatCancelResponseSchema,
  chatChunkEventSchema,
  chatSendRequestSchema,
  chatSendResponseSchema,
  secretsActionResponseSchema,
  secretsClearRequestSchema,
  secretsStatusRequestSchema,
  secretsWriteRequestSchema,
  secretStatusResultSchema,
  settingsActionResponseSchema,
  settingsGetRequestSchema,
  settingsUpdateRequestSchema,
  IPC_WORKSPACE_FILE_CHANNEL,
  IPC_WORKSPACE_PLAN_CHANNEL,
  IPC_WORKSPACE_SEARCH_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  IPC_WORKSPACE_STATUS_CHANNEL,
  IPC_WORKSPACE_TREE_CHANNEL,
  workspaceFileRequestSchema,
  workspacePlanRequestSchema,
  workspacePlanResponseSchema,
  workspaceProjectResponseSchema,
  workspaceSearchRequestSchema,
  workspaceSelectRequestSchema,
  workspaceStatusRequestSchema,
  workspaceTreeRequestSchema,
  workspaceTreeResponseSchema,
} from '../../../src/shared/schemas/ipc.schema';
import { WORKSPACE_ERROR_CODES } from '../../../src/shared/workspace/errors';

const NOW = '2026-08-07T00:00:00.000Z';

function validUpdateInput() {
  return {
    onboardingCompleted: true,
    assistant: { name: 'JARVIS' },
    user: { displayName: 'Alex' },
    language: { ui: 'en' as const },
    modelProvider: { provider: 'none' as const, model: '', baseUrl: '' },
  };
}

describe('settingsGetRequestSchema', () => {
  it('accepts no arguments', () => {
    expect(settingsGetRequestSchema.safeParse([]).success).toBe(true);
  });

  it('rejects an unexpected argument', () => {
    expect(settingsGetRequestSchema.safeParse(['unexpected']).success).toBe(false);
  });
});

describe('settingsUpdateRequestSchema', () => {
  it('accepts a well-formed onboarding payload for every approved provider', () => {
    for (const provider of MODEL_PROVIDERS) {
      const input = validUpdateInput();
      const result = settingsUpdateRequestSchema.safeParse([
        { ...input, modelProvider: { ...input.modelProvider, provider } },
      ]);
      expect(result.success).toBe(true);
    }
  });

  it('accepts every approved interface language', () => {
    for (const ui of UI_LANGUAGES) {
      const input = validUpdateInput();
      const result = settingsUpdateRequestSchema.safeParse([{ ...input, language: { ui } }]);
      expect(result.success).toBe(true);
    }
  });

  it('rejects an unapproved provider identifier', () => {
    for (const hostile of ['anthropic', 'openai', 'claude', 'gemini']) {
      const input = validUpdateInput();
      const result = settingsUpdateRequestSchema.safeParse([
        { ...input, modelProvider: { ...input.modelProvider, provider: hostile } },
      ]);
      expect(result.success).toBe(false);
    }
  });

  it('rejects a payload that carries hasApiKey — the renderer can never set it directly', () => {
    const input = validUpdateInput();
    const result = settingsUpdateRequestSchema.safeParse([
      { ...input, modelProvider: { ...input.modelProvider, hasApiKey: true } },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects a payload that carries schemaVersion, updatedAt or telemetry', () => {
    const input = validUpdateInput();
    for (const extra of [
      { schemaVersion: 1 },
      { updatedAt: NOW },
      { telemetry: { enabled: false } },
    ]) {
      const result = settingsUpdateRequestSchema.safeParse([{ ...input, ...extra }]);
      expect(result.success).toBe(false);
    }
  });

  it('rejects an oversized assistant name', () => {
    const input = validUpdateInput();
    const result = settingsUpdateRequestSchema.safeParse([
      { ...input, assistant: { name: 'x'.repeat(33) } },
    ]);
    expect(result.success).toBe(false);
  });

  it('rejects a baseUrl carrying embedded credentials', () => {
    const input = validUpdateInput();
    const result = settingsUpdateRequestSchema.safeParse([
      {
        ...input,
        modelProvider: {
          provider: 'openai-compatible',
          model: 'gpt',
          baseUrl: 'https://user:pass@example.com',
        },
      },
    ]);
    expect(result.success).toBe(false);
  });
});

describe('secretsStatusRequestSchema / secretsClearRequestSchema', () => {
  it('accept no arguments', () => {
    expect(secretsStatusRequestSchema.safeParse([]).success).toBe(true);
    expect(secretsClearRequestSchema.safeParse([]).success).toBe(true);
  });

  it('reject an unexpected argument', () => {
    expect(secretsStatusRequestSchema.safeParse(['x']).success).toBe(false);
    expect(secretsClearRequestSchema.safeParse(['x']).success).toBe(false);
  });
});

describe('secretsWriteRequestSchema', () => {
  it('accepts a well-formed key', () => {
    expect(secretsWriteRequestSchema.safeParse([{ apiKey: 'sk-test-key-value' }]).success).toBe(
      true,
    );
  });

  it('rejects an empty key', () => {
    expect(secretsWriteRequestSchema.safeParse([{ apiKey: '' }]).success).toBe(false);
  });

  it('rejects a key over the maximum length', () => {
    const result = secretsWriteRequestSchema.safeParse([
      { apiKey: 'a'.repeat(API_KEY_MAX_LENGTH + 1) },
    ]);
    expect(result.success).toBe(false);
  });

  it('accepts a key exactly at the maximum length', () => {
    const result = secretsWriteRequestSchema.safeParse([
      { apiKey: 'a'.repeat(API_KEY_MAX_LENGTH) },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects a key containing a control character', () => {
    expect(secretsWriteRequestSchema.safeParse([{ apiKey: 'sk-test\nkey' }]).success).toBe(false);
  });

  it('does NOT trim the key — a leading/trailing space is preserved as typed', () => {
    const result = secretsWriteRequestSchema.safeParse([{ apiKey: ' sk-test-key ' }]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].apiKey).toBe(' sk-test-key ');
    }
  });

  it('rejects an unknown field alongside apiKey', () => {
    const result = secretsWriteRequestSchema.safeParse([{ apiKey: 'sk-test', provider: 'glm' }]);
    expect(result.success).toBe(false);
  });
});

describe('secretStatusResultSchema', () => {
  it('accepts {present: true} and {present: false}', () => {
    expect(secretStatusResultSchema.safeParse({ present: true }).success).toBe(true);
    expect(secretStatusResultSchema.safeParse({ present: false }).success).toBe(true);
  });

  it('rejects an extra field — this is the only secret-adjacent shape ever sent to the renderer', () => {
    const result = secretStatusResultSchema.safeParse({ present: true, apiKey: 'sk-leak' });
    expect(result.success).toBe(false);
  });
});

describe('settingsActionResponseSchema', () => {
  it('accepts a success response carrying full settings', () => {
    const result = settingsActionResponseSchema.safeParse({
      outcome: 'success',
      settings: createDefaultSettings(NOW),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a denied response with neither settings nor errorCode', () => {
    expect(settingsActionResponseSchema.safeParse({ outcome: 'denied' }).success).toBe(true);
  });

  it('accepts a failure response carrying only an errorCode', () => {
    const result = settingsActionResponseSchema.safeParse({
      outcome: 'failure',
      errorCode: 'EXECUTION_FAILED',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid outcome', () => {
    expect(settingsActionResponseSchema.safeParse({ outcome: 'ok' }).success).toBe(false);
  });
});

describe('secretsActionResponseSchema', () => {
  it('accepts a success response carrying status', () => {
    const result = secretsActionResponseSchema.safeParse({
      outcome: 'success',
      status: { present: true },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an aborted response with neither status nor errorCode', () => {
    expect(secretsActionResponseSchema.safeParse({ outcome: 'aborted' }).success).toBe(true);
  });
});

describe('chatSendRequestSchema (Phase 2, Milestone 3)', () => {
  function validSend() {
    return {
      requestId: '11111111-1111-4111-8111-111111111111',
      messages: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          role: 'user' as const,
          content: 'hello',
          createdAt: NOW,
        },
      ],
    };
  }

  it('accepts a well-formed request', () => {
    expect(chatSendRequestSchema.safeParse([validSend()]).success).toBe(true);
  });

  it('accepts an empty message list', () => {
    expect(chatSendRequestSchema.safeParse([{ ...validSend(), messages: [] }]).success).toBe(true);
  });

  it('rejects a non-uuid requestId', () => {
    expect(
      chatSendRequestSchema.safeParse([{ ...validSend(), requestId: 'not-a-uuid' }]).success,
    ).toBe(false);
  });

  it('rejects a conversation over the maximum length', () => {
    const oversized = {
      ...validSend(),
      messages: Array.from({ length: CHAT_CONVERSATION_MAX_MESSAGES + 1 }, (_, index) => ({
        id: '22222222-2222-4222-8222-222222222222',
        role: 'user' as const,
        content: `message ${String(index)}`,
        createdAt: NOW,
      })),
    };
    expect(chatSendRequestSchema.safeParse([oversized]).success).toBe(false);
  });

  it('rejects an unknown top-level field — never an apiKey, header, or URL', () => {
    for (const extra of [
      { apiKey: 'sk-test' },
      { baseUrl: 'https://evil.example' },
      { header: 'x' },
    ]) {
      expect(chatSendRequestSchema.safeParse([{ ...validSend(), ...extra }]).success).toBe(false);
    }
  });

  it('rejects a malformed message inside the conversation', () => {
    const invalid = { ...validSend(), messages: [{ role: 'user', content: 'hi' }] };
    expect(chatSendRequestSchema.safeParse([invalid]).success).toBe(false);
  });
});

describe('chatSendResponseSchema', () => {
  it('accepts a success response carrying content', () => {
    expect(chatSendResponseSchema.safeParse({ outcome: 'success', content: 'hi' }).success).toBe(
      true,
    );
  });

  it('accepts a denied response with neither content nor errorCode', () => {
    expect(chatSendResponseSchema.safeParse({ outcome: 'denied' }).success).toBe(true);
  });

  it('accepts a failure response carrying a normalized provider error code', () => {
    for (const errorCode of CHAT_PROVIDER_ERROR_CODES) {
      const result = chatSendResponseSchema.safeParse({ outcome: 'failure', errorCode });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an errorCode outside the normalized vocabulary — never a raw provider error string', () => {
    const result = chatSendResponseSchema.safeParse({
      outcome: 'failure',
      errorCode: 'ECONNREFUSED: connection refused at 10.0.0.5:443',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field — never a header, a URL, or a raw upstream body', () => {
    const result = chatSendResponseSchema.safeParse({
      outcome: 'success',
      content: 'hi',
      rawUpstreamResponse: { status: 200 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects content that fails the shared content-safety schema', () => {
    const result = chatSendResponseSchema.safeParse({ outcome: 'success', content: '' });
    expect(result.success).toBe(false);
  });
});

describe('chatChunkEventSchema (Phase 2, Milestone 4)', () => {
  const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

  it('accepts a well-formed streaming event', () => {
    const result = chatChunkEventSchema.safeParse({ requestId: REQUEST_ID, delta: 'hello' });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid requestId, so an uncorrelated event cannot be delivered', () => {
    const result = chatChunkEventSchema.safeParse({ requestId: 'nope', delta: 'hello' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty delta', () => {
    expect(chatChunkEventSchema.safeParse({ requestId: REQUEST_ID, delta: '' }).success).toBe(
      false,
    );
  });

  it('rejects a delta longer than the per-chunk bound', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'a'.repeat(CHAT_STREAM_MAX_DELTA_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  it('accepts a delta exactly at the per-chunk bound', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'a'.repeat(CHAT_STREAM_MAX_DELTA_LENGTH),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a delta carrying an unsafe control character', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'bad' + String.fromCharCode(0) + 'delta',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a delta carrying a bidirectional override', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'spoofed‮text',
    });
    expect(result.success).toBe(false);
  });

  it('allows the newlines and tabs a real reply legitimately contains', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'line one\nline two\tindented',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown field — a chunk carries nothing but its correlation and its text', () => {
    const result = chatChunkEventSchema.safeParse({
      requestId: REQUEST_ID,
      delta: 'hello',
      apiKey: 'sk-not-real',
    });
    expect(result.success).toBe(false);
  });
});

describe('chatCancelRequestSchema / chatCancelResponseSchema', () => {
  it('accepts a well-formed cancel request', () => {
    const result = chatCancelRequestSchema.safeParse([
      { requestId: '11111111-1111-4111-8111-111111111111' },
    ]);
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid requestId', () => {
    expect(chatCancelRequestSchema.safeParse([{ requestId: 'nope' }]).success).toBe(false);
  });

  it('rejects an unexpected field', () => {
    const result = chatCancelRequestSchema.safeParse([
      { requestId: '11111111-1111-4111-8111-111111111111', reason: 'because' },
    ]);
    expect(result.success).toBe(false);
  });

  it('the response is always exactly {acknowledged: true}', () => {
    expect(chatCancelResponseSchema.safeParse({ acknowledged: true }).success).toBe(true);
    expect(chatCancelResponseSchema.safeParse({ acknowledged: false }).success).toBe(false);
    expect(chatCancelResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('workspace channel request schemas (Phase 2, Milestone 5)', () => {
  it('takes no argument for status or select, so no directory can be named', () => {
    expect(workspaceStatusRequestSchema.safeParse([]).success).toBe(true);
    expect(workspaceSelectRequestSchema.safeParse([]).success).toBe(true);

    // The property that matters: there is no shape in which a caller can
    // point the picker at a directory of its choosing.
    expect(workspaceSelectRequestSchema.safeParse([{ path: 'C:\\Windows' }]).success).toBe(false);
    expect(workspaceSelectRequestSchema.safeParse(['C:\\Windows']).success).toBe(false);
    expect(workspaceStatusRequestSchema.safeParse([{}]).success).toBe(false);
  });

  it('accepts a project-relative path for tree, and the root as the empty string', () => {
    expect(workspaceTreeRequestSchema.safeParse([{ path: '' }]).success).toBe(true);
    expect(workspaceTreeRequestSchema.safeParse([{ path: 'src/main' }]).success).toBe(true);
  });

  it('rejects a traversal, an absolute path or a backslash on every path-taking channel', () => {
    for (const path of ['../secrets', '/etc/passwd', 'src\\main', 'C:/Windows', 'src/../..']) {
      expect(workspaceTreeRequestSchema.safeParse([{ path }]).success, path).toBe(false);
      expect(workspaceFileRequestSchema.safeParse([{ path }]).success, path).toBe(false);
      expect(
        workspaceSearchRequestSchema.safeParse([{ query: 'answer', path }]).success,
        path,
      ).toBe(false);
    }
  });

  it('requires a file request to name an entry rather than the project root', () => {
    expect(workspaceFileRequestSchema.safeParse([{ path: '' }]).success).toBe(false);
    expect(workspaceFileRequestSchema.safeParse([{ path: 'README.md' }]).success).toBe(true);
  });

  it('bounds the search query and rejects unsafe characters in it', () => {
    expect(workspaceSearchRequestSchema.safeParse([{ query: 'a', path: '' }]).success).toBe(false);
    expect(workspaceSearchRequestSchema.safeParse([{ query: 'ab', path: '' }]).success).toBe(true);
    expect(
      workspaceSearchRequestSchema.safeParse([{ query: 'a'.repeat(500), path: '' }]).success,
    ).toBe(false);
    expect(
      workspaceSearchRequestSchema.safeParse([
        { query: `bad${String.fromCharCode(0)}query`, path: '' },
      ]).success,
    ).toBe(false);
  });

  it('bounds the plan objective', () => {
    expect(workspacePlanRequestSchema.safeParse([{ objective: 'Add retry' }]).success).toBe(true);
    expect(workspacePlanRequestSchema.safeParse([{ objective: 'ab' }]).success).toBe(false);
    expect(workspacePlanRequestSchema.safeParse([{ objective: 'a'.repeat(5000) }]).success).toBe(
      false,
    );
  });

  it('rejects an extra field on every request, so nothing can ride along', () => {
    expect(workspaceTreeRequestSchema.safeParse([{ path: 'src', root: 'C:\\' }]).success).toBe(
      false,
    );
    expect(
      workspaceFileRequestSchema.safeParse([{ path: 'README.md', encoding: 'binary' }]).success,
    ).toBe(false);
    expect(
      workspaceSearchRequestSchema.safeParse([{ query: 'answer', path: '', regex: true }]).success,
    ).toBe(false);
    expect(
      workspacePlanRequestSchema.safeParse([{ objective: 'Add retry', apply: true }]).success,
    ).toBe(false);
  });

  it('declares no request field that could carry content to write', () => {
    // The absence is the control: there is no `content`, no `data`, no
    // `patch` and no `destination` anywhere in the workspace request surface.
    for (const forbidden of ['content', 'data', 'patch', 'diff', 'destination', 'write']) {
      expect(
        workspaceFileRequestSchema.safeParse([{ path: 'a.ts', [forbidden]: 'x' }]).success,
        forbidden,
      ).toBe(false);
      expect(
        workspacePlanRequestSchema.safeParse([{ objective: 'Add retry', [forbidden]: 'x' }])
          .success,
        forbidden,
      ).toBe(false);
    }
  });
});

describe('workspace channel response schemas (Phase 2, Milestone 5)', () => {
  const project = {
    name: 'demo',
    path: 'C:\\Users\\me\\demo',
    selectedAt: NOW,
    markers: ['package.json'],
    hasGitMetadata: true,
  };

  it('carries a project, or an explicit null meaning none is approved', () => {
    expect(workspaceProjectResponseSchema.safeParse({ outcome: 'success', project }).success).toBe(
      true,
    );
    expect(
      workspaceProjectResponseSchema.safeParse({ outcome: 'success', project: null }).success,
    ).toBe(true);
  });

  it('carries only a normalized error code, never a message or a path', () => {
    expect(
      workspaceProjectResponseSchema.safeParse({
        outcome: 'failure',
        errorCode: 'WORKSPACE_INVALID_PROJECT',
      }).success,
    ).toBe(true);

    for (const code of ['ENOENT', 'EACCES: permission denied', 'C:\\Users\\me\\secret', 'oops']) {
      expect(
        workspaceProjectResponseSchema.safeParse({ outcome: 'failure', errorCode: code }).success,
        code,
      ).toBe(false);
    }
  });

  it('accepts every member of the normalized vocabulary and nothing else', () => {
    for (const code of WORKSPACE_ERROR_CODES) {
      expect(
        workspaceTreeResponseSchema.safeParse({ outcome: 'failure', errorCode: code }).success,
        code,
      ).toBe(true);
    }
  });

  it('rejects an unknown field on every response', () => {
    expect(
      workspaceTreeResponseSchema.safeParse({ outcome: 'success', tree: null, extra: 1 }).success,
    ).toBe(false);
    expect(
      workspacePlanResponseSchema.safeParse({ outcome: 'success', applied: true }).success,
    ).toBe(false);
  });

  it('declares every outcome, so a denial is distinguishable from a failure', () => {
    for (const outcome of ['success', 'failure', 'denied', 'aborted']) {
      expect(workspaceProjectResponseSchema.safeParse({ outcome }).success, outcome).toBe(true);
    }
  });
});

describe('the workspace channel names', () => {
  it('are distinct from each other and from every other channel', () => {
    const channels = [
      IPC_WORKSPACE_STATUS_CHANNEL,
      IPC_WORKSPACE_SELECT_CHANNEL,
      IPC_WORKSPACE_TREE_CHANNEL,
      IPC_WORKSPACE_FILE_CHANNEL,
      IPC_WORKSPACE_SEARCH_CHANNEL,
      IPC_WORKSPACE_PLAN_CHANNEL,
    ];
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) {
      expect(channel.startsWith('workspace:')).toBe(true);
    }
  });

  it('include no channel that would write, apply or execute', () => {
    const channels = [
      IPC_WORKSPACE_STATUS_CHANNEL,
      IPC_WORKSPACE_SELECT_CHANNEL,
      IPC_WORKSPACE_TREE_CHANNEL,
      IPC_WORKSPACE_FILE_CHANNEL,
      IPC_WORKSPACE_SEARCH_CHANNEL,
      IPC_WORKSPACE_PLAN_CHANNEL,
    ].join(' ');
    for (const forbidden of ['write', 'apply', 'delete', 'exec', 'run', 'patch', 'commit']) {
      expect(channels, forbidden).not.toContain(forbidden);
    }
  });
});
