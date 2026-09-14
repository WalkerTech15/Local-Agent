/**
 * The approved-project session (Phase 2, Milestone 5).
 *
 * Holds exactly one thing: which directory the user approved in the native
 * picker during *this* run of the application.
 *
 * Three properties, each deliberate:
 *
 *  - **In memory only.** Nothing here is persisted. The approved path is not
 *    written to `settings.json`, not stored in the secret store, and not
 *    remembered across restarts. Read access to someone's source tree is not
 *    a preference to be restored silently on the next launch; it is a grant
 *    the user makes, per session, by clicking through a dialog. The milestone
 *    brief says "store only the approved project path in the current
 *    session", and this is that, literally.
 *  - **One per `registerIpcHandlers` call**, exactly like `main/ipc.ts`'s
 *    in-flight chat request map — never a module-level singleton, so one
 *    test's approved project can never leak into another's.
 *  - **Nothing outside this module can set it.** The only way in is
 *    {@link adoptProjectDirectory}, which canonicalises the path, confirms it
 *    is a directory, and refuses the application's own data directory.
 */

import { basename, dirname, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';

import { isContainedPath, toWorkspaceError } from './workspace-paths';
import { workspaceProjectSummarySchema } from '../shared/schemas/workspace.schema';
import type { WorkspaceProjectSummary } from '../shared/schemas/workspace.schema';
import { WorkspaceError } from '../shared/workspace/errors';
import {
  WORKSPACE_PROJECT_MARKER_FILES,
  WORKSPACE_TEST_MARKER_FILES,
} from '../shared/workspace/exclusions';
import { joinAbsolute } from './workspace-paths';

/** One approved project, as the main process holds it. */
export interface ApprovedProject {
  /** The canonical root. Every path resolution is relative to this. */
  readonly rootPath: string;
  readonly name: string;
  readonly selectedAt: string;
  /** Which of {@link WORKSPACE_PROJECT_MARKER_FILES} exist at the root. */
  readonly markers: readonly string[];
  readonly hasGitMetadata: boolean;
  /** True when a marker implying an automated test setup was found. */
  readonly hasTestTooling: boolean;
}

export interface WorkspaceSession {
  /** The approved project, or `null` when the user has not chosen one. */
  get(): ApprovedProject | null;
  set(project: ApprovedProject): void;
  clear(): void;
}

export function createWorkspaceSession(): WorkspaceSession {
  let approved: ApprovedProject | null = null;
  return {
    get: () => approved,
    set: (project) => {
      approved = project;
    },
    clear: () => {
      approved = null;
    },
  };
}

/**
 * Returns the approved project, or throws the normalized "no project" error.
 *
 * Every workspace operation except selection itself starts here, so there is
 * one place — not five — where "the renderer asked to read something before
 * approving anything" is decided.
 */
export function requireApprovedProject(session: WorkspaceSession): ApprovedProject {
  const project = session.get();
  if (project === null) throw new WorkspaceError('WORKSPACE_NO_PROJECT');
  return project;
}

/** True when the entry exists, whatever it is. Never reads it. */
async function entryExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detects which project markers exist at the root.
 *
 * Presence only — not one of these files is opened. `.git` is detected the
 * same way, which is the whole of this milestone's "Git metadata" support:
 * the interface learns that a project is version-controlled without anything
 * listing or reading a single byte inside `.git`, which stays on the excluded
 * list for every other purpose.
 */
async function detectMarkers(rootPath: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const marker of WORKSPACE_PROJECT_MARKER_FILES) {
    if (await entryExists(joinAbsolute(rootPath, marker))) found.push(marker);
  }
  return found;
}

/**
 * Canonicalises a path that may not exist yet.
 *
 * `%APPDATA%\Local-Agent` is created on first write, so on a clean install it
 * genuinely may not be there — but the comparison it is used for still has to
 * work. When the directory itself cannot be resolved, its parent is
 * canonicalised and the final segment re-appended, which is enough because
 * `%APPDATA%` always exists. If even that fails, the raw path is returned:
 * a comparison against an uncanonical path is weaker than one against a
 * canonical path, but it is never *wrong* in the permissive direction for the
 * ordinary case where no short name is involved.
 */
async function canonicalizeExistingOrParent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    try {
      return join(await realpath(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

export interface AdoptProjectOptions {
  /** The raw path the native picker returned. Still treated as input. */
  readonly chosenPath: string;
  /** UTC ISO-8601, supplied by the caller. This module reads no clock. */
  readonly now: string;
  /**
   * The application's own user-data directory, refused as a project root.
   *
   * Opening `%APPDATA%\Local-Agent` as a "project" would point the inspector
   * at the settings file, the permission policy and the audit log. The
   * encrypted secret store would still be refused by name
   * (`isCredentialFileName` matches the `secrets` stem), and everything would
   * still be read-only — but the application's own state is categorically not
   * a coding project, and refusing it outright is both cheaper and clearer
   * than reasoning about which parts of it happen to be safe.
   */
  readonly userDataDir: string;
}

/**
 * Turns a picker result into an approved project, or throws a
 * {@link WorkspaceError}.
 *
 * The dialog result is *not* trusted merely because a native dialog produced
 * it. It is canonicalised, confirmed to be a directory, checked against the
 * application's own data directory in both directions, and finally validated
 * as a {@link WorkspaceProjectSummary} — so a directory whose own name
 * carries a control character or a bidirectional override is refused here,
 * before it can be displayed or become a root that later paths are joined to.
 */
export async function adoptProjectDirectory(
  options: AdoptProjectOptions,
): Promise<ApprovedProject> {
  const { chosenPath, now, userDataDir } = options;

  let rootPath: string;
  try {
    rootPath = await realpath(chosenPath);
  } catch (error) {
    // A picker result that no longer resolves is an unusable project, not a
    // missing file the caller asked for by name.
    void toWorkspaceError(error);
    throw new WorkspaceError('WORKSPACE_INVALID_PROJECT');
  }

  let isDirectory: boolean;
  try {
    isDirectory = (await stat(rootPath)).isDirectory();
  } catch {
    throw new WorkspaceError('WORKSPACE_INVALID_PROJECT');
  }
  if (!isDirectory) throw new WorkspaceError('WORKSPACE_INVALID_PROJECT');

  // Both directions: the chosen root must not be inside the application's
  // data directory, and must not contain it either (choosing `%APPDATA%`
  // itself, or a drive root, would otherwise pull it in).
  //
  // Both sides must be canonical for the comparison to mean anything.
  // `rootPath` already is; `userDataDir` arrives as `main/paths.ts` built it,
  // from whatever `app.getPath('appData')` returned, which on Windows can
  // carry a short (8.3) ancestor such as `C:\Users\VUNHAT~1\…`. Comparing a
  // short form against a long one finds no common root at all, and the guard
  // would silently pass — so it is canonicalised here first.
  const canonicalUserDataDir = await canonicalizeExistingOrParent(userDataDir);
  if (
    isContainedPath(canonicalUserDataDir, rootPath) ||
    isContainedPath(rootPath, canonicalUserDataDir)
  ) {
    throw new WorkspaceError('WORKSPACE_INVALID_PROJECT');
  }

  const name = basename(rootPath);
  const markers = await detectMarkers(rootPath);

  const project: ApprovedProject = {
    rootPath,
    name,
    selectedAt: now,
    markers,
    hasGitMetadata: markers.includes('.git'),
    hasTestTooling: markers.some((marker) => WORKSPACE_TEST_MARKER_FILES.includes(marker)),
  };

  // Refuses a root that could not be described safely — an empty name (a
  // drive root such as `C:\`), or a name or path carrying a control character
  // or a bidirectional override.
  if (!workspaceProjectSummarySchema.safeParse(toProjectSummary(project)).success) {
    throw new WorkspaceError('WORKSPACE_INVALID_PROJECT');
  }

  return project;
}

/** The renderer-facing view of an approved project. */
export function toProjectSummary(project: ApprovedProject): WorkspaceProjectSummary {
  return {
    name: project.name,
    path: project.rootPath,
    selectedAt: project.selectedAt,
    markers: [...project.markers],
    hasGitMetadata: project.hasGitMetadata,
  };
}
