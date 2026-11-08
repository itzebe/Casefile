import { z } from "zod";

/**
 * Agent-facing input helpers for optional fields.
 *
 * A model frequently sends an optional field it has no value for as an empty
 * placeholder — `null` or `""` — because the provider's tool-calling fills
 * every declared property. The framework's tool-input repair strips such a
 * placeholder only when the field's JSON schema accepts it. When one optional
 * field accepts its placeholder and another rejects it, the repair cannot tell
 * a deliberate clear from transport noise and refuses the whole call with
 * `ambiguous_tool_placeholders`; the action never runs and the user sees an
 * error for a call that was correct.
 *
 * A bare `z.enum([...]).optional()` rejects `null`, and `z.string().min(1)`
 * rejects `""`, so any action that mixes such a field with a boolean or
 * nullable field is exposed. `agentOptional` and `agentDefault` make the field
 * accept an empty placeholder and normalise it away, so no call is lost to
 * transport noise. The parsed value is unchanged: `agentOptional` yields
 * `undefined` (field omitted) and `agentDefault` yields the declared default.
 * `agentClearable` is for the few fields where an explicit `null` is a real
 * instruction — it clears a stored value — and only an empty string is noise.
 */

const EMPTY_PLACEHOLDER = z.union([z.string().max(0), z.null()]);

function isPlaceholder(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * The JSON Schema `type`(s) zod emits for `schema`, or `undefined` when zod
 * expresses it only as a union. Wrapping a field in a union erases its
 * top-level `type`, and the framework reads that `type` to coerce an HTTP query
 * string back to a boolean, number, or array (see `coerceGatewayStringifiedArgs`
 * in `@agent-native/core`). Restoring it as metadata keeps the wrapped schema
 * coercible, so a read-only action called as `?limit=200` still works.
 */
function declaredTypes(schema: z.ZodType): string[] | undefined {
  try {
    const { type } = z.toJSONSchema(schema, { io: "input" }) as {
      type?: string | string[];
    };
    if (!type) return undefined;
    return Array.isArray(type) ? type : [type];
  } catch {
    return undefined;
  }
}

/** Adds `extra` types to a schema's declared `type` metadata, if it has one. */
function withDeclaredTypes<S extends z.ZodType>(
  schema: S,
  types: string[] | undefined,
  extra: string[],
): S {
  if (!types) return schema;
  const merged = [...new Set([...types, ...extra])];
  return schema.meta({ type: merged }) as unknown as S;
}

/** An optional field that tolerates an empty placeholder as "not provided". */
export function agentOptional<T extends z.ZodType>(schema: T) {
  const types = declaredTypes(schema);
  const wrapped = z
    .union([schema, EMPTY_PLACEHOLDER])
    .optional()
    .transform((value): z.output<T> | undefined =>
      isPlaceholder(value) ? undefined : (value as z.output<T>),
    );
  return withDeclaredTypes(wrapped, types, ["null"]);
}

/** A defaulted field that tolerates an empty placeholder as "use the default". */
export function agentDefault<T extends z.ZodType>(
  schema: T,
  fallback: z.output<T>,
) {
  const types = declaredTypes(schema);
  const wrapped = z
    .union([schema, EMPTY_PLACEHOLDER])
    .optional()
    .transform((value): z.output<T> =>
      isPlaceholder(value) ? fallback : (value as z.output<T>),
    );
  return withDeclaredTypes(wrapped, types, ["null"]);
}

/**
 * An optional field for which an explicit `null` is meaningful — it clears a
 * stored value — but an empty string is transport noise. `schema` must accept
 * `null`; the empty string is normalised to "not provided".
 */
export function agentClearable<T extends z.ZodType>(schema: T) {
  const types = declaredTypes(schema);
  const wrapped = z
    .union([schema, z.string().max(0)])
    .optional()
    .transform((value): z.output<T> | undefined =>
      value === "" ? undefined : (value as z.output<T>),
    );
  return withDeclaredTypes(wrapped, types, ["null", "string"]);
}
