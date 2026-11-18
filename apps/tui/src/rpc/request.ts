import type {
  EnvironmentRpcInput,
  EnvironmentRpcSuccess,
  EnvironmentRpcStreamValue,
  EnvironmentStreamRpcTag,
  EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import type { TuiClient } from "../runtime/client.ts";

export function request<Tag extends EnvironmentUnaryRpcTag>(
  client: Pick<TuiClient, "invoke">,
  tag: Tag,
  input: EnvironmentRpcInput<Tag>,
): Promise<EnvironmentRpcSuccess<Tag>> {
  return client.invoke(tag, input) as Promise<EnvironmentRpcSuccess<Tag>>;
}

export function subscribe<Tag extends EnvironmentStreamRpcTag>(
  client: Pick<TuiClient, "stream">,
  tag: Tag,
  input: EnvironmentRpcInput<Tag>,
  onValue: (value: EnvironmentRpcStreamValue<Tag>) => void,
  onError?: (error: Error) => void,
): () => void {
  return client.stream(
    tag,
    input,
    (value) => onValue(value as EnvironmentRpcStreamValue<Tag>),
    onError,
  );
}
