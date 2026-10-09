import * as v from 'valibot';

export type JsonPrimitive = boolean | null | number | string;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface JsonArray extends ReadonlyArray<JsonValue> {}

export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

/** Values accepted at untrusted Worker and provider boundaries before normalization. */
export interface BoundaryObject {
  readonly [key: string]: BoundaryValue;
}

export interface BoundaryArray extends ReadonlyArray<BoundaryValue> {}

export type BoundaryValue = BoundaryArray | BoundaryObject | JsonPrimitive | undefined;

// Valibot calls a lazy getter for every nested value it validates, so each
// recursive schema returns a union built once instead of constructing one.
export const jsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() => jsonValueUnion);

const jsonValueUnion: v.GenericSchema<JsonValue> = v.union([
  v.boolean(),
  v.null(),
  v.number(),
  v.string(),
  v.array(jsonValueSchema),
  v.record(v.string(), jsonValueSchema),
]);

export const boundaryValueSchema: v.GenericSchema<BoundaryValue> = v.lazy(() => boundaryValueUnion);

const boundaryValueUnion: v.GenericSchema<BoundaryValue> = v.union([
  v.boolean(),
  v.null(),
  v.number(),
  v.string(),
  v.undefined(),
  v.array(boundaryValueSchema),
  v.record(v.string(), boundaryValueSchema),
]);

export const boundaryObjectSchema: v.GenericSchema<BoundaryObject> = v.record(
  v.string(),
  boundaryValueSchema,
);
