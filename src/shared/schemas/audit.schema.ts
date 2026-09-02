/**
 * Audit record schema for Local Agent.
 *
 * This describes one line of `%APPDATA%\Local-Agent\logs\audit\audit-<UTC date>.jsonl`.
 *
 * The audit trail is append-only. Every permission decision is recorded,
 * including denials and rejected confirmations, so that a blocked action
 * leaves as clear a trace as a successful one.
 *
 * No secret may ever reach this file. Parameter values that may carry a
 * credential are replaced before serialisation, and `errorCode` is
 * constrained to a stable symbolic code so that a raw error message, stack
 * trace or filesystem path cannot leak into the log.
 */

import { z } from 'zod';

import {
  ACTION_TYPES,
  AUDIT_ACTORS,
  AUDIT_OUTCOMES,
  AUDIT_SCHEMA_VERSION,
  CONFIRMATION_RESULTS,
  PERMISSION_DECISIONS,
} from '../constants';
import { auditParametersSchema } from './audit-parameters.schema';

export const auditRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(AUDIT_SCHEMA_VERSION),
    /** Unique per record. */
    eventId: z.uuid(),
    /** Shared by every record produced for one user request. */
    correlationId: z.uuid(),
    /** UTC ISO-8601. Offsets are rejected so that records sort correctly. */
    timestamp: z.iso.datetime(),
    actor: z.enum(AUDIT_ACTORS),
    actionType: z.enum(ACTION_TYPES),
    /**
     * Action parameters after redaction.
     *
     * Bounded and JSON-safe; a field whose name looks capable of carrying a
     * credential is accepted only when already redacted. See
     * `audit-parameters.schema.ts`.
     */
    parameters: auditParametersSchema,
    decision: z.enum(PERMISSION_DECISIONS),
    /** A policy rule id, or one of the documented reason constants. */
    decisionReason: z.string().trim().min(1).max(200),
    /** Present only when the decision was `confirm`. */
    confirmationResult: z.enum(CONFIRMATION_RESULTS).optional(),
    outcome: z.enum(AUDIT_OUTCOMES),
    /**
     * A stable symbolic code such as `SETTINGS_WRITE_FAILED`.
     *
     * Free text is rejected on purpose: error messages are a common way for
     * paths and secret material to end up in a log file.
     */
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/, {
        message: 'errorCode must be a stable UPPER_SNAKE_CASE code, not a free-text message',
      })
      .optional(),
    durationMs: z.int().min(0),
  })
  .superRefine((record, ctx) => {
    // Every rule below is a biconditional. A one-directional rule leaves the
    // opposite contradiction writable: forbidding "denied decision, success
    // outcome" while still permitting "allow decision, denied outcome" would
    // let a record claim an action was blocked when policy never blocked it.
    // Both directions of every pairing are therefore closed.

    // decision === 'confirm'  <->  confirmationResult is present
    if (record.decision === 'confirm' && record.confirmationResult === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmationResult'],
        message: 'a confirm decision must record whether the user approved or rejected it',
      });
    }
    if (record.decision !== 'confirm' && record.confirmationResult !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmationResult'],
        message: 'confirmationResult is only valid for a confirm decision',
      });
    }

    // decision === 'deny'  <->  outcome === 'denied'
    if (record.decision === 'deny' && record.outcome !== 'denied') {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'a denied decision must record the outcome as denied',
      });
    }
    if (record.outcome === 'denied' && record.decision !== 'deny') {
      ctx.addIssue({
        code: 'custom',
        path: ['decision'],
        message: 'a denied outcome can only follow a deny decision',
      });
    }

    // confirmationResult === 'rejected'  <->  outcome === 'aborted'
    if (record.confirmationResult === 'rejected' && record.outcome !== 'aborted') {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'a rejected confirmation must record the outcome as aborted',
      });
    }
    if (record.outcome === 'aborted' && record.confirmationResult !== 'rejected') {
      ctx.addIssue({
        code: 'custom',
        path: ['confirmationResult'],
        message: 'an aborted outcome can only follow a rejected confirmation',
      });
    }

    // An approved confirmation was carried out, so it must report how it went.
    // `denied` and `aborted` are already excluded by the two rules above; this
    // states the remaining requirement directly rather than leaving it to be
    // inferred.
    if (
      record.decision === 'confirm' &&
      record.confirmationResult === 'approved' &&
      record.outcome !== 'success' &&
      record.outcome !== 'failure'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'an approved confirmation must record the outcome as success or failure',
      });
    }

    // outcome === 'failure'  ->  a stable errorCode is required.
    //
    // A failure with no code is an audit entry that records that something
    // went wrong but not what, which is of little use during an incident. The
    // code stays symbolic; it must never become a raw exception message.
    if (record.outcome === 'failure' && record.errorCode === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'a failure outcome must record a stable errorCode',
      });
    }

    // Conversely, an outcome that did not fail must not carry an error code.
    if (record.outcome !== 'failure' && record.errorCode !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCode'],
        message: 'errorCode is only valid on a failure outcome',
      });
    }
  });

export type AuditRecord = z.infer<typeof auditRecordSchema>;
