/**
 * Automation schema for Local Agent (Phase 2, Milestone 10).
 *
 * Nothing here is persisted: the tool registry is a fixed list in reviewed
 * source (`shared/automation/registry.ts`), never a file on disk, so there is
 * no store schema in this module — only the shapes that cross the IPC
 * boundary describing that registry and the result of running one entry.
 */

import { z } from 'zod';

import {
  AUTOMATION_DESCRIPTION_MAX_LENGTH,
  AUTOMATION_LABEL_MAX_LENGTH,
  AUTOMATION_MAX_ATTEMPTS,
} from '../constants';
import { AUTOMATION_ERROR_CODES } from '../automation/errors';
import { AUTOMATION_TOOL_IDS, AUTOMATION_TOOL_KINDS } from '../automation/registry';

export const automationToolIdSchema = z.enum(AUTOMATION_TOOL_IDS);
export type AutomationToolIdValue = z.infer<typeof automationToolIdSchema>;

export const automationToolKindSchema = z.enum(AUTOMATION_TOOL_KINDS);

export const automationErrorCodeSchema = z.enum(AUTOMATION_ERROR_CODES);

/**
 * The safe, display-only projection of one registry entry.
 *
 * Deliberately narrower than `AutomationToolDefinition`: it carries nothing
 * an executor would need (no executable name, no argument vector, no URL, no
 * folder key) because the renderer never resolves or names a target itself —
 * it only ever sends an id and the main process does the rest.
 */
export const automationToolSchema = z.strictObject({
  id: automationToolIdSchema,
  kind: automationToolKindSchema,
  label: z.string().trim().min(1).max(AUTOMATION_LABEL_MAX_LENGTH),
  description: z.string().trim().min(1).max(AUTOMATION_DESCRIPTION_MAX_LENGTH),
  requiresProject: z.boolean(),
});

export type AutomationTool = z.infer<typeof automationToolSchema>;

export const automationCatalogSchema = z.strictObject({
  tools: z.array(automationToolSchema).max(AUTOMATION_TOOL_IDS.length),
  /** True when an automation action is running right now, so a second may not start. */
  busy: z.boolean(),
});

export type AutomationCatalog = z.infer<typeof automationCatalogSchema>;

/**
 * How one automation run finished.
 *
 * `'stopped'` covers a stop this application performed for its own reasons —
 * a timeout, a cancellation, or the emergency stop being engaged — kept
 * distinct from `'failed'` so the interface never reports an ordinary refusal
 * as if the action itself had gone wrong. Mirrors `COMMAND_OUTCOMES`.
 */
export const AUTOMATION_RUN_OUTCOMES = ['succeeded', 'failed', 'stopped'] as const;

export const automationRunResultSchema = z.strictObject({
  runId: z.uuid(),
  toolId: automationToolIdSchema,
  kind: automationToolKindSchema,
  outcome: z.enum(AUTOMATION_RUN_OUTCOMES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: z.int().min(0),
  /** Always between 1 and {@link AUTOMATION_MAX_ATTEMPTS}. */
  attempts: z.int().min(1).max(AUTOMATION_MAX_ATTEMPTS),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  /** True when the emergency stop kept this action from running or finishing. */
  stoppedByEmergency: z.boolean(),
  /**
   * True when Local Agent observed the action reach a verifiable success
   * state — the process did not fail immediately, the shell reported no
   * error, or the window was actually focused. `outcome: 'succeeded'`
   * without this being true cannot happen; see `main/windows-automation.ts`.
   */
  verified: z.boolean(),
});

export type AutomationRunResult = z.infer<typeof automationRunResultSchema>;
