/**
 * Bounded, JSON-safe schema for audit record parameters.
 *
 * Audit parameters describe the action that was proposed, so they originate
 * outside the privileged process. `Record<string, unknown>` is far too
 * permissive for a security log format: it admits functions, class instances,
 * cyclic graphs and unbounded payloads, any of which either breaks
 * serialisation or produces a log line an operator cannot read.
 *
 * Two properties are enforced here:
 *
 *  - **JSON-safe by construction.** Only strings, finite numbers, booleans,
 *    `null`, plain objects and arrays. No functions, symbols, `undefined`,
 *    `BigInt`, `Date`, `Map`, `Set` or class instances. Cycles are detected
 *    rather than left to overflow the stack during serialisation.
 *  - **Bounded.** Depth, key count, array length, string length, key length
 *    and total node count are all capped, so a hostile or runaway payload
 *    cannot produce an unbounded audit line.
 *
 * It also enforces the redaction contract: a field whose *name* looks capable
 * of carrying a credential is accepted only when its value is exactly
 * {@link REDACTED_PLACEHOLDER}. The Milestone 4 writer performs redaction; this
 * schema is the backstop that fails loudly if the writer is ever bypassed or
 * regresses.
 *
 * Note the consequence for callers: boolean key-presence metadata must not be
 * logged under a secret-looking name such as `hasApiKey`, because that name
 * matches the denylist and a boolean is not the redaction placeholder. Log it
 * under a neutral name such as `keyPresent`.
 *
 * Pure. No I/O, no runtime privileges.
 */

import { z } from 'zod';

import {
  AUDIT_PARAM_MAX_ARRAY_LENGTH,
  AUDIT_PARAM_MAX_DEPTH,
  AUDIT_PARAM_MAX_KEY_LENGTH,
  AUDIT_PARAM_MAX_KEYS,
  AUDIT_PARAM_MAX_STRING_LENGTH,
  AUDIT_PARAM_MAX_TOTAL_NODES,
  FORBIDDEN_OBJECT_KEYS,
  isSecretFieldName,
  REDACTED_PLACEHOLDER,
} from '../constants';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The validated shape of an audit record's `parameters` field. */
export type AuditParameters = Readonly<Record<string, JsonValue>>;

/**
 * True for objects that are safe to treat as JSON maps.
 *
 * Deliberately excludes anything with a custom prototype, which is what keeps
 * `Date`, `Map`, `Set`, `Error` and class instances out. Those either
 * serialise to something misleading or lose information entirely.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A short, safe description of a rejected value's type for the error message. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'Date';
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (value instanceof Error) return 'Error';
  if (typeof value === 'object') return 'class instance or exotic object';
  return typeof value;
}

interface WalkContext {
  /** Total values visited so far, against {@link AUDIT_PARAM_MAX_TOTAL_NODES}. */
  nodes: number;
  /** Set once a budget is exhausted, to stop reporting the same problem repeatedly. */
  exhausted: boolean;
  readonly issues: { path: (string | number)[]; message: string }[];
}

function report(context: WalkContext, path: (string | number)[], message: string): void {
  context.issues.push({ path: [...path], message });
}

/**
 * Recursively validates one value.
 *
 * @param depth depth of the value's container; the root object is depth 1
 * @param ancestors containers on the current path, used for cycle detection
 */
function walk(
  value: unknown,
  path: (string | number)[],
  depth: number,
  ancestors: Set<object>,
  context: WalkContext,
): void {
  if (context.exhausted) return;

  context.nodes += 1;
  if (context.nodes > AUDIT_PARAM_MAX_TOTAL_NODES) {
    context.exhausted = true;
    report(context, path, `exceeds the maximum of ${String(AUDIT_PARAM_MAX_TOTAL_NODES)} values`);
    return;
  }

  if (value === null) return;

  switch (typeof value) {
    case 'boolean':
      return;

    case 'number':
      // NaN and Infinity are not representable in JSON; `JSON.stringify`
      // silently turns them into `null`, which would quietly falsify a record.
      if (!Number.isFinite(value)) {
        report(context, path, 'must be a finite number');
      }
      return;

    case 'string':
      if (value.length > AUDIT_PARAM_MAX_STRING_LENGTH) {
        report(
          context,
          path,
          `string exceeds the maximum length of ${String(AUDIT_PARAM_MAX_STRING_LENGTH)}`,
        );
      }
      return;

    case 'object':
      break;

    default:
      // undefined, function, symbol, bigint
      report(context, path, `${describeType(value)} is not JSON-safe and cannot be audited`);
      return;
  }

  // Narrowed to a non-null object by the switch above.
  const container = value;

  if (ancestors.has(container)) {
    report(context, path, 'contains a cycle and cannot be serialised');
    return;
  }

  if (depth > AUDIT_PARAM_MAX_DEPTH) {
    report(context, path, `exceeds the maximum nesting depth of ${String(AUDIT_PARAM_MAX_DEPTH)}`);
    return;
  }

  const nextAncestors = new Set(ancestors).add(container);

  if (Array.isArray(container)) {
    if (container.length > AUDIT_PARAM_MAX_ARRAY_LENGTH) {
      report(
        context,
        path,
        `array exceeds the maximum length of ${String(AUDIT_PARAM_MAX_ARRAY_LENGTH)}`,
      );
      return;
    }
    container.forEach((element, index) => {
      walk(element, [...path, index], depth + 1, nextAncestors, context);
    });
    return;
  }

  if (!isPlainObject(container)) {
    report(context, path, `${describeType(container)} is not JSON-safe and cannot be audited`);
    return;
  }

  const keys = Object.keys(container);
  if (keys.length > AUDIT_PARAM_MAX_KEYS) {
    report(context, path, `object exceeds the maximum of ${String(AUDIT_PARAM_MAX_KEYS)} keys`);
    return;
  }

  for (const key of keys) {
    const childPath = [...path, key];

    if (key.length > AUDIT_PARAM_MAX_KEY_LENGTH) {
      report(
        context,
        childPath,
        `key exceeds the maximum length of ${String(AUDIT_PARAM_MAX_KEY_LENGTH)}`,
      );
      continue;
    }

    if (FORBIDDEN_OBJECT_KEYS.includes(key)) {
      report(context, childPath, `the key "${key}" is not permitted in audit parameters`);
      continue;
    }

    const child: unknown = container[key];

    // The redaction contract. A secret-looking name is allowed through only
    // when its value is already the placeholder.
    if (isSecretFieldName(key) && child !== REDACTED_PLACEHOLDER) {
      report(
        context,
        childPath,
        `"${key}" may carry a credential and must be recorded as ${REDACTED_PLACEHOLDER}`,
      );
      continue;
    }

    walk(child, childPath, depth + 1, nextAncestors, context);
  }
}

/**
 * Validates a candidate audit `parameters` value.
 *
 * Exported so that the Milestone 4 audit writer can check a record before
 * serialising it, without depending on Zod internals.
 */
export function findAuditParameterIssues(
  value: unknown,
): { path: (string | number)[]; message: string }[] {
  if (!isPlainObject(value)) {
    return [{ path: [], message: 'audit parameters must be a plain object' }];
  }
  const context: WalkContext = { nodes: 0, exhausted: false, issues: [] };
  walk(value, [], 1, new Set(), context);
  return context.issues;
}

export const auditParametersSchema = z.custom<AuditParameters>().superRefine((value, ctx) => {
  for (const issue of findAuditParameterIssues(value)) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
});
