import { ToolInputError } from './types.ts';

/**
 * Just enough JSON Schema to describe tool inputs, plus matching runtime readers.
 * Deliberately not zod: `zod` is external to the bundle for the provider SDKs'
 * benefit, and tool schemas are simple enough that a dependency would cost more
 * than it saves. The readers below are the only validation a tool needs, and
 * they produce messages the model can act on rather than a schema dump.
 */
export type JsonSchema = Record<string, unknown>;

export function object(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const str = (description: string): JsonSchema => ({ type: 'string', description });
export const num = (description: string): JsonSchema => ({ type: 'number', description });
export const bool = (description: string): JsonSchema => ({ type: 'boolean', description });
export const arr = (items: JsonSchema, description: string): JsonSchema => ({
  type: 'array',
  items,
  description,
});
export const enumOf = (values: string[], description: string): JsonSchema => ({
  type: 'string',
  enum: values,
  description,
});

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ToolInputError('expected an object of arguments');
  }
  return input as Record<string, unknown>;
}

export function requireString(input: unknown, key: string): string {
  const value = record(input)[key];
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

export function optionalString(input: unknown, key: string): string | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

export function optionalNumber(input: unknown, key: string): number | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ToolInputError(`"${key}" must be a number`);
  }
  return value;
}

export function optionalBoolean(input: unknown, key: string): boolean | undefined {
  const value = record(input)[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean`);
  return value;
}

export function requireArray(input: unknown, key: string): unknown[] {
  const value = record(input)[key];
  if (!Array.isArray(value)) throw new ToolInputError(`"${key}" must be an array`);
  return value;
}

/**
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * property, so optional fields are spread in conditionally rather than assigned.
 */
export function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
