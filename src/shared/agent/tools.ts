/**
 * The agent tool registry (Phase 2, Milestone 7).
 *
 * This is the complete vocabulary of things an agent run can reach for. It is
 * a fixed list in reviewed source — not configuration, not a setting, and not
 * anything a profile, a renderer, a project or a model can extend at runtime.
 * A profile chooses a **subset** of these ids; it cannot add one.
 *
 * ## Every tool is an action type that already existed
 *
 * The single most important property here is what the `actionType` column
 * does *not* contain. Not one entry introduces a new privileged operation:
 * each maps onto an action type Milestones 5 and 6 already defined, already
 * gated by the permission engine, and already audited. So the question "what
 * can an agent do?" has the same answer as "what could the interface already
 * do, with the user's approval?" — never a larger one.
 *
 * In particular there is no tool for `workspace.write`, `workspace.rollback`
 * or `git.checkpoint`. An agent run in this milestone can look at the
 * approved project, produce an inert plan, read Git state, and run the
 * project's own verification scripts. **It cannot change a file, apply a
 * proposed change, or create a commit** — those stay exactly where Milestone
 * 6 put them: user-driven, one at a time, behind a native confirmation. The
 * absence is the control; a profile cannot name a write tool because no such
 * id exists to name.
 *
 * ## The three tools that run a process
 *
 * `command.test`, `command.lint` and `command.typecheck` each map to
 * `command.run`, which is on the confirmation floor. That is deliberate and
 * is not weakened here: a verification step inside an agent run raises the
 * same native dialog, stating the same command line and the same project
 * script text, as a user-initiated run does. An agent run does not get a
 * quieter path to starting a process than a person does.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import type { ActionType } from '../constants';
import type { CodingCommandId } from '../workspace/command-registry';

export const AGENT_TOOL_IDS = [
  'workspace.inspect',
  'workspace.search',
  'workspace.plan',
  'git.status',
  'command.test',
  'command.lint',
  'command.typecheck',
] as const;

export type AgentToolId = (typeof AGENT_TOOL_IDS)[number];

/**
 * What a tool is for, used by the interface to group them and by the
 * orchestrator to decide which ones satisfy a verification requirement.
 */
export const AGENT_TOOL_KINDS = ['inspect', 'plan', 'verify'] as const;
export type AgentToolKind = (typeof AGENT_TOOL_KINDS)[number];

export interface AgentToolDefinition {
  readonly id: AgentToolId;
  /** Shown in the interface. Fixed text, never from a profile or a project. */
  readonly label: string;
  readonly description: string;
  /**
   * The **existing** action type this tool routes through.
   *
   * Not a new one. The permission engine decides this action exactly as it
   * would for the same operation initiated from the interface directly.
   */
  readonly actionType: ActionType;
  readonly kind: AgentToolKind;
  /** True when the tool cannot run without an approved project. All of them. */
  readonly requiresProject: true;
  /**
   * For a `verify` tool, which registry command it runs. `null` otherwise.
   *
   * A constant, never a value from a profile or a request — the same rule
   * `src/shared/workspace/command-registry.ts` already applies to its own
   * argument vectors.
   */
  readonly commandId: CodingCommandId | null;
}

export const AGENT_TOOLS: readonly AgentToolDefinition[] = [
  {
    id: 'workspace.inspect',
    label: 'Inspect project tree',
    description: 'Lists files and folders inside the approved project.',
    actionType: 'workspace.read',
    kind: 'inspect',
    requiresProject: true,
    commandId: null,
  },
  {
    id: 'workspace.search',
    label: 'Search project text',
    description: 'Searches the approved project for a bounded number of matches.',
    actionType: 'workspace.read',
    kind: 'inspect',
    requiresProject: true,
    commandId: null,
  },
  {
    id: 'workspace.plan',
    label: 'Produce a plan',
    description: 'Produces an inert coding plan. The plan cannot be applied.',
    actionType: 'workspace.plan',
    kind: 'plan',
    requiresProject: true,
    commandId: null,
  },
  {
    id: 'git.status',
    label: 'Read Git status',
    description: 'Reads the working tree status. Changes nothing.',
    actionType: 'git.read',
    kind: 'inspect',
    requiresProject: true,
    commandId: null,
  },
  {
    id: 'command.test',
    label: 'Run tests',
    description: 'Runs the project’s own test script, after native confirmation.',
    actionType: 'command.run',
    kind: 'verify',
    requiresProject: true,
    commandId: 'test',
  },
  {
    id: 'command.lint',
    label: 'Run lint',
    description: 'Runs the project’s own lint script, after native confirmation.',
    actionType: 'command.run',
    kind: 'verify',
    requiresProject: true,
    commandId: 'lint',
  },
  {
    id: 'command.typecheck',
    label: 'Run type-check',
    description: 'Runs the project’s own type-check script, after native confirmation.',
    actionType: 'command.run',
    kind: 'verify',
    requiresProject: true,
    commandId: 'typecheck',
  },
] as const;

/**
 * The only action types any agent tool is permitted to map to.
 *
 * Stated as data so that "an agent cannot write, roll back or commit" is
 * checkable by reading one array and asserted by a test, rather than being a
 * property someone has to re-derive by reading every entry above.
 */
export const AGENT_ALLOWED_ACTION_TYPES: readonly ActionType[] = [
  'workspace.read',
  'workspace.plan',
  'git.read',
  'command.run',
] as const;

/** True for a value that is one of {@link AGENT_TOOL_IDS}. */
export function isAgentToolId(value: unknown): value is AgentToolId {
  return typeof value === 'string' && (AGENT_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * The definition for one id, or `null`.
 *
 * Returns `null` rather than throwing, exactly as `findCodingCommand` does:
 * an unrecognised tool is a refusal the caller turns into a normalized code,
 * not an exception.
 */
export function findAgentTool(id: unknown): AgentToolDefinition | null {
  if (!isAgentToolId(id)) return null;
  return AGENT_TOOLS.find((tool) => tool.id === id) ?? null;
}

/**
 * What a profile may require a run to have demonstrated before its result
 * counts as verified.
 *
 * Each requirement is satisfied by exactly one tool completing successfully,
 * and by nothing else — in particular, not by a model asserting that it did.
 * Verification in this milestone means "the project's own script ran and
 * exited zero", or "the inert planner produced a plan", which are facts the
 * main process observed rather than claims it was told.
 */
export const AGENT_VERIFICATION_REQUIREMENTS = [
  'tests-pass',
  'lint-clean',
  'typecheck-clean',
  'plan-produced',
] as const;

export type AgentVerificationRequirement = (typeof AGENT_VERIFICATION_REQUIREMENTS)[number];

const REQUIREMENT_TOOL: Readonly<Record<AgentVerificationRequirement, AgentToolId>> = {
  'tests-pass': 'command.test',
  'lint-clean': 'command.lint',
  'typecheck-clean': 'command.typecheck',
  'plan-produced': 'workspace.plan',
};

/** The one tool whose success satisfies a requirement. */
export function requirementToolId(requirement: AgentVerificationRequirement): AgentToolId {
  return REQUIREMENT_TOOL[requirement];
}

/** True for a value that is one of {@link AGENT_VERIFICATION_REQUIREMENTS}. */
export function isAgentVerificationRequirement(
  value: unknown,
): value is AgentVerificationRequirement {
  return (
    typeof value === 'string' &&
    (AGENT_VERIFICATION_REQUIREMENTS as readonly string[]).includes(value)
  );
}
