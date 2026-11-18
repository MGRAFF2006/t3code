import { WS_METHODS, type ResourceTelemetrySnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { request, subscribe } from "../rpc/request.ts";
import type { FeatureProps } from "../ui/controller.ts";
import { destinationGuard } from "./common.tsx";

const mib = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MiB`;

export function resourceActions(props: FeatureProps) {
  const guard = destinationGuard(props);
  function history(legacy = false) {
    props.ui.form({
      title: legacy ? "Server process history" : "T3 resource history",
      fields: [
        {
          name: "window",
          label: "Period",
          type: "select",
          value: "3600000",
          options: [
            { label: "Last 15 minutes", value: "900000" },
            { label: "Last hour", value: "3600000" },
            { label: "Last day", value: "86400000" },
          ],
        },
      ],
      onSubmit: async ({ window = "3600000" }) => {
        guard();
        const windowMs = Number(window);
        const input = { windowMs, bucketMs: Math.max(60000, windowMs / 60) };
        if (legacy) {
          const result = await request(
            props.client,
            WS_METHODS.serverGetProcessResourceHistory,
            input,
          );
          guard();
          props.ui.text(
            "Server process history",
            [
              `${result.retainedSampleCount} samples · ${result.totalCpuSecondsApprox.toFixed(1)} CPU seconds`,
              Option.getOrNull(result.error)?.message ?? "",
              ...result.buckets.map(
                (bucket) =>
                  `${DateTime.formatIso(bucket.startedAt)}  ${bucket.avgCpuPercent.toFixed(1)}% CPU  ${mib(bucket.maxRssBytes)}  ${bucket.maxProcessCount} processes`,
              ),
              "\nTop processes",
              ...result.topProcesses.map(
                (process) =>
                  `${process.pid}  ${process.avgCpuPercent.toFixed(1)}% CPU  ${mib(process.maxRssBytes)}  ${process.command}`,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          );
        } else {
          const result = await request(
            props.client,
            WS_METHODS.serverGetResourceTelemetryHistory,
            input,
          );
          guard();
          props.ui.text(
            "T3 resource history",
            [
              `${result.retainedSampleCount} samples · Native collector ${result.health.native.status} · Desktop ${result.health.desktop.status}`,
              ...result.buckets.map(
                (bucket) =>
                  `${DateTime.formatIso(bucket.startedAt)}  ${bucket.avgCpuPercent.toFixed(1)}% CPU  ${mib(bucket.maxRssBytes)}  read ${mib(bucket.ioReadBytes)}  wrote ${mib(bucket.ioWriteBytes)}`,
              ),
              "\nTop processes",
              ...result.topProcesses.map(
                (process) =>
                  `${process.identity.pid}  ${process.category}  ${process.avgCpuPercent.toFixed(1)}% CPU  ${mib(process.peakRssBytes)}  ${process.command}`,
              ),
            ].join("\n"),
          );
        }
      },
    });
  }
  async function current() {
    guard();
    const host = await request(props.client, WS_METHODS.serverGetHostResources, {});
    guard();
    props.ui.text(
      "Host resources",
      [
        `CPU: ${host.cpuUtilization === null ? "Unavailable" : `${(host.cpuUtilization * 100).toFixed(1)}%`} across ${host.cpuCount} cores`,
        `Memory: ${mib(host.totalMemoryBytes - host.availableMemoryBytes)} used / ${mib(host.totalMemoryBytes)} total`,
        `Available memory: ${mib(host.availableMemoryBytes)}`,
      ].join("\n"),
    );
  }
  async function processes() {
    guard();
    let stop: (() => void) | undefined;
    let snapshot: ResourceTelemetrySnapshot;
    try {
      snapshot = await new Promise((resolve, reject) => {
        stop = subscribe(props.client, WS_METHODS.subscribeResourceTelemetry, {}, resolve, reject);
      });
    } finally {
      stop?.();
    }
    guard();
    props.ui.choose("T3 resource collection", [
      {
        title: "Collector health",
        description: `Native: ${snapshot.health.native.status} · Desktop: ${snapshot.health.desktop.status}`,
        run: () =>
          props.ui.text(
            "Resource collector health",
            [
              `Native collector: ${snapshot.health.native.status}`,
              Option.getOrNull(snapshot.health.native.lastError) ?? "",
              `Desktop collector: ${snapshot.health.desktop.status}`,
              Option.getOrNull(snapshot.health.desktop.lastError) ?? "",
              `${snapshot.health.restartCount} restarts · ${snapshot.health.scannedProcessCount} scanned · ${snapshot.health.inaccessibleProcessCount} inaccessible processes`,
            ]
              .filter(Boolean)
              .join("\n"),
          ),
      },
      ...Object.entries(snapshot.groups).map(([name, group]) => ({
        title: name,
        description: `${group.processCount} processes · ${group.currentCpuPercent.toFixed(1)}% CPU · ${mib(group.currentRssBytes)}`,
        run: () =>
          props.ui.text(
            name,
            `CPU ${group.currentCpuPercent.toFixed(1)}%\nRSS ${mib(group.currentRssBytes)}\nPeak RSS ${mib(group.peakRssBytes)}\nRead ${mib(group.ioReadBytes)}\nWrote ${mib(group.ioWriteBytes)}`,
          ),
      })),
      ...snapshot.processes
        .toSorted((a, b) => b.cpuPercent - a.cpuPercent)
        .map((process) => ({
          title: `${process.identity.pid} ${process.name}`,
          description: `${process.category} · ${process.cpuPercent.toFixed(1)}% CPU · ${mib(process.residentBytes)}`,
          run: () =>
            props.ui.text(
              process.name,
              `${process.command}\n\n${process.category}\nCPU ${process.cpuPercent.toFixed(1)}%\nRSS ${mib(process.residentBytes)}`,
            ),
        })),
    ]);
  }
  props.ui.choose("Resource diagnostics", [
    { title: "Host CPU and memory", run: () => void props.ui.run(current) },
    { title: "T3 process resources and collector health", run: () => void props.ui.run(processes) },
    { title: "T3 resource history", run: () => history() },
    { title: "Server process history", run: () => history(true) },
    {
      title: "Retry resource collection",
      run: () =>
        void props.ui.run(async () => {
          guard();
          const result = await request(props.client, WS_METHODS.serverRetryResourceTelemetry, {});
          guard();
          props.ui.notify(
            result.accepted
              ? "Resource collector restart accepted."
              : "Collector is already restarting. Refresh diagnostics shortly.",
          );
        }),
    },
    {
      title: "Check OTLP endpoint",
      run: () =>
        props.ui.form({
          title: "Check OTLP endpoint",
          description: "Send a diagnostic request from the selected environment.",
          fields: [
            { name: "url", label: "HTTP endpoint URL", required: true },
            {
              name: "signal",
              label: "Signal",
              type: "select",
              value: "traces",
              options: ["traces", "metrics", "logs"].map((value) => ({ label: value, value })),
            },
          ],
          onSubmit: async ({ url = "", signal = "traces" }) => {
            guard();
            const result = await request(props.client, WS_METHODS.serverCheckOtlpEndpoint, {
              url: url.trim(),
              signal: signal === "metrics" || signal === "logs" ? signal : "traces",
            });
            guard();
            props.ui.notify(
              result._tag === "Accepted"
                ? `Endpoint accepted the request (${result.latencyMs.toFixed(0)} ms).`
                : result._tag === "Rejected"
                  ? `Endpoint rejected the request (HTTP ${result.status}).`
                  : result.timedOut
                    ? "Endpoint check timed out."
                    : "Endpoint is unreachable.",
              result._tag !== "Accepted",
            );
          },
        }),
    },
  ]);
}
