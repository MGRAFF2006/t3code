import { createMemo, createSignal } from "solid-js";
import type { TuiClient, TuiSnapshot } from "../runtime/client.ts";
import { createThreadSearch, type ThreadSearchRow } from "../presentation/thread-search.ts";
import { threadStatus, threadStatusPresentation } from "../presentation/thread-status.ts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import * as DateTime from "effect/DateTime";
import { toServerClock } from "@t3tools/client-runtime/clock";
import { DialogSelect } from "./dialog-select.tsx";

export function ThreadPicker(props: {
  client: TuiClient | null;
  state: () => TuiSnapshot | null;
  onSelect: (row: ThreadSearchRow, query: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const environmentId = createMemo(() => props.state()?.environmentId);
  const selectedThreadId = createMemo(() => props.state()?.selectedThreadId);
  const projects = createMemo(() => props.state()?.shell?.projects);
  const projectTitles = createMemo(
    () => new Map(projects()?.map((project) => [project.id, project.title])),
  );
  const result = createThreadSearch({
    client: () => props.client,
    state: props.state,
    query,
    picks: true,
  });
  const options = createMemo(() =>
    result().rows.map((row) => {
      const id = environmentId();
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      const status = threadStatusPresentation(
        threadStatus(
          id ? presentThreadShell(id, row.thread) : null,
          DateTime.formatIso(DateTime.makeUnsafe(id ? toServerClock(id, now) : now)),
        ),
        selectedThreadId() === row.thread.id,
      );
      return {
        title: `${status.symbol} ${row.thread.title}`,
        color: status.color,
        value: row.thread.id,
        category: row.source === "message" ? "In messages" : "Threads",
        description: [projectTitles().get(row.thread.projectId), row.thread.branch, row.hint]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  );
  return (
    <DialogSelect
      title="Switch thread"
      placeholder="Title, project, branch, PR or messages…"
      options={options()}
      onFilterChange={setQuery}
      filterOptions={(options) => options}
      emptyMessage={result().loading ? "Searching messages…" : "No matching threads"}
      status={
        result().error ??
        (result().loading
          ? "Searching messages…"
          : (props.state()?.label ?? "Selected environment"))
      }
      onSelect={(option) => {
        const row = result().rows.find((row) => row.thread.id === option.value);
        if (row) props.onSelect(row, query());
      }}
      onCancel={props.onCancel}
    />
  );
}
