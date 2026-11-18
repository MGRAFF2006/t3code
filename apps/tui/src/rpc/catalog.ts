import { WsRpcGroup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/rpc/RpcSchema";

export interface TuiService {
  readonly method: string;
  readonly streaming: boolean;
  readonly payloadSchema: string;
  readonly defaultDraft: string;
  readonly variants: ReadonlyArray<{ readonly name: string; readonly draft: string }>;
}

type JsonObject = { readonly [key: string]: unknown };
const referenceName = (reference: string) =>
  decodeURIComponent(reference.split("/").at(-1)!).replaceAll("~1", "/").replaceAll("~0", "~");
const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

function dereference(schema: unknown, definitions: JsonObject): JsonObject {
  let node = object(schema);
  for (let depth = 0; depth < 12 && typeof node.$ref === "string"; depth++) {
    const name = referenceName(node.$ref);
    node = object(definitions[name]);
  }
  return node;
}

function seed(schema: unknown, definitions: JsonObject, depth = 0): unknown {
  if (depth > 12) return null;
  const node = object(schema);
  if (typeof node.$ref === "string") {
    const name = referenceName(node.$ref);
    return seed(definitions[name], definitions, depth + 1);
  }
  if ("const" in node) return node.const;
  if ("default" in node) return node.default;
  if (Array.isArray(node.enum)) return node.enum[0];
  if (Array.isArray(node.oneOf)) return seed(node.oneOf[0], definitions, depth + 1);
  if (Array.isArray(node.anyOf)) return seed(node.anyOf[0], definitions, depth + 1);
  if (node.type === "array") return [];
  if (node.type === "boolean") return false;
  if (node.type === "number" || node.type === "integer")
    return typeof node.minimum === "number" ? node.minimum : 0;
  if (node.type === "null") return null;
  if (node.type === "object" || node.properties) {
    const properties = object(node.properties);
    const required = Array.isArray(node.required) ? node.required : [];
    return Object.fromEntries(
      required
        .filter((key): key is string => typeof key === "string")
        .map((key) => [key, seed(properties[key], definitions, depth + 1)]),
    );
  }
  return "";
}

function describeService(method: string): TuiService {
  const rpc = WsRpcGroup.requests.get(method)!;
  const document = Schema.toJsonSchemaDocument(rpc.payloadSchema);
  const root = object(document.schema);
  const resolved = dereference(document.schema, document.definitions);
  const choices = resolved.oneOf ?? resolved.anyOf;
  const variants = Array.isArray(choices)
    ? choices.map((choice, index) => {
        const value = seed(choice, document.definitions);
        return {
          name: String(object(value).type ?? object(value)._tag ?? index + 1),
          draft: JSON.stringify(value, null, 2),
        };
      })
    : [];
  return {
    method,
    streaming: RpcSchema.isStreamSchema(rpc.successSchema),
    payloadSchema: JSON.stringify({ ...root, $defs: document.definitions }, null, 2),
    defaultDraft: JSON.stringify(seed(document.schema, document.definitions), null, 2),
    variants,
  };
}

export const services: ReadonlyArray<TuiService> = [...WsRpcGroup.requests.keys()]
  .sort((left, right) => left.localeCompare(right))
  .map((method) => {
    let description: TuiService | undefined;
    return {
      method,
      streaming: RpcSchema.isStreamSchema(WsRpcGroup.requests.get(method)!.successSchema),
      get payloadSchema() {
        return (description ??= describeService(method)).payloadSchema;
      },
      get defaultDraft() {
        return (description ??= describeService(method)).defaultDraft;
      },
      get variants() {
        return (description ??= describeService(method)).variants;
      },
    };
  });

const decoders = new Map<string, (input: unknown) => unknown>();
for (const [method, rpc] of WsRpcGroup.requests) {
  decoders.set(method, Schema.decodeUnknownSync(rpc.payloadSchema as Schema.Codec<unknown>));
}

export function decodeServiceInput(method: string, input: unknown) {
  const rpc = WsRpcGroup.requests.get(method);
  if (!rpc) throw new Error(`Unknown T3 service: ${method}`);
  return {
    stream: RpcSchema.isStreamSchema(rpc.successSchema),
    input: decoders.get(method)!(input),
  };
}
