import type { Accessor } from "solid-js";
import type { FeatureProps } from "../ui/controller.ts";
import type { WorkspaceStatus } from "./logic.ts";

export interface WorkspaceContext extends FeatureProps {
  cwd: Accessor<string | undefined>;
  status: Accessor<WorkspaceStatus>;
  mutation: Accessor<string | null | undefined>;
  refresh: () => Promise<void>;
}
