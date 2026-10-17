import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const RequestId = Type.String({ pattern: "^[A-Za-z0-9_-]{8,128}$" });

/** A body that fails its schema, or a malformed request ID. */
export class InvalidRequest extends Error {}
/** A request ID already used with a different body. */
export class RequestConflict extends Error {}

/** Check a body against its schema; the error lists every violation. */
export function validate<S extends TSchema>(schema: S, body: unknown): Static<S> {
  if (!Value.Check(schema, body)) {
    throw new InvalidRequest(
      Value.Errors(schema, body)
        .map((error) => `${error.instancePath} ${error.message}`)
        .join("; "),
    );
  }
  return body;
}

/** Validate, then serialize the fields in a fixed order with defaults applied, so equal requests digest equally. */
export function normalize<S extends TSchema, N>(
  requestId: unknown,
  schema: S,
  body: unknown,
  fields: (value: Static<S>) => N,
): { key: string; intent: string; digest: string } {
  if (!Value.Check(RequestId, requestId)) throw new InvalidRequest("request ID must be 8-128 letters, digits, _ or -");
  const intent = JSON.stringify(fields(validate(schema, body)));
  return { key: requestId, intent, digest: createHash("sha256").update(intent).digest("hex") };
}
