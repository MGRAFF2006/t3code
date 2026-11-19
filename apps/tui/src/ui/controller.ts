import type { AssetResource, ProviderInstanceId } from "@t3tools/contracts";
import type { Accessor } from "solid-js";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";

export type Area =
  | "chat"
  | "workspace"
  | "schedules"
  | "settings"
  | "pull-requests"
  | "issues"
  | "advanced"
  | "browser";
export interface Choice {
  title: string;
  color?: string;
  description?: string | undefined;
  category?: string | undefined;
  run: () => void;
}
export interface Field {
  name: string;
  label: string;
  type?: "text" | "multiline" | "select" | "toggle" | "number" | "secret";
  value?: string;
  options?: { label: string; value: string }[];
  required?: boolean;
  description?: string | undefined;
}
export interface FieldFormOptions {
  title: string;
  description?: string | undefined;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}
export interface UiController {
  modal: Accessor<boolean>;
  modalIdentity?: Accessor<object | null>;
  beforeNavigate(): Promise<boolean>;
  registerNavigationGuard(guard: () => string | null, discard?: () => void): () => void;
  notify(message: string, error?: boolean): void;
  run(action: () => Promise<unknown>, success?: string): Promise<void>;
  choose(title: string, options: Choice[]): void;
  form(options: FieldFormOptions): void;
  confirm(title: string, message: string, action: () => Promise<void>, label?: string): void;
  text(title: string, content: string, language?: string): void;
  openTerminal?(terminalId?: string): void;
  openHtml?(html: string, title?: string): void;
  openArtifact?(resource: AssetResource, label: string): void;
  previewImage?(resource: AssetResource, label: string): void;
  openBrowser?(url: string): void;
  openThread(id: string): void;
  openArea(area: Area): void;
  openProviderSettings?(instanceId: ProviderInstanceId): void;
  openFile(path: string, line?: number): void;
  showChanges(): void;
  chooseModel(): void;
  threadActions(): void;
}
export interface FeatureProps {
  client: TuiClient;
  state: Accessor<TuiSnapshot | null>;
  ui: UiController;
  focused: boolean;
  onFocus: () => void;
}
