import * as Schema from "effect/Schema";

const decodeHeaders = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String));

export function parseRegistryHeaders(value: string) {
  if (!value.trim()) return undefined;
  try {
    return decodeHeaders(JSON.parse(value));
  } catch {
    throw new Error("Headers must be a JSON object with string values.");
  }
}
