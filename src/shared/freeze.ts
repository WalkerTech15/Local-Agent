/**
 * Deep-immutability helpers for shared security defaults.
 *
 * Exported security defaults — the initial emergency state, the default
 * permission policy — are module singletons. A module singleton that can be
 * mutated is a shared mutable security control: any caller that edits it,
 * deliberately or by accident, changes what every later caller sees. Freezing
 * them turns that from a silent corruption into an immediate error.
 *
 * Pure. No I/O, no runtime privileges.
 */

/** Recursively marks a type readonly. Adequate for plain JSON-shaped data. */
export type DeepReadonly<T> = T extends readonly (infer Element)[]
  ? readonly DeepReadonly<Element>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

/**
 * Recursively freezes a value and returns it typed as deeply readonly.
 *
 * Mutating the result throws a `TypeError`, because every module in this
 * project is an ES module and therefore runs in strict mode. Cycles are not
 * expected in the data this is applied to; `Object.isFrozen` short-circuits
 * anything already processed, so a cycle would terminate rather than recurse
 * forever.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value as DeepReadonly<T>;
}
