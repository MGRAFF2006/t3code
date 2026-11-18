// @effect-diagnostics nodeBuiltinImport:off -- The terminal selects and reads local attachment files through bounded file handles.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AttachmentCreateUploadUrlInput,
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createAssetEnvironmentAtoms, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createAttachmentEnvironmentAtoms,
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  verifyPersistedAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { attachmentUploadError } from "@t3tools/client-runtime/state/attachment-uploads";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";
import type { Atom, AtomRegistry } from "effect/reactivity";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

export interface LocalAttachment {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly type: "image" | "file";
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
}

export async function inspectLocalAttachment(
  input: string,
  maxFileBytes = PROVIDER_SEND_TURN_MAX_FILE_BYTES,
): Promise<LocalAttachment> {
  const value = input.trim();
  if (!value) throw new Error("Enter a local file path.");
  const path = NodePath.resolve(
    value === "~"
      ? NodeOS.homedir()
      : value.startsWith("~/")
        ? NodePath.join(NodeOS.homedir(), value.slice(2))
        : value,
  );
  const file = await NodeFSP.stat(path);
  if (!file.isFile()) throw new Error("Choose a regular file on this computer.");
  const name = NodePath.basename(path);
  if (name.length > 255) throw new Error("Attachment names can contain at most 255 characters.");
  const mimeType = mediaMimeTypeFromExtension(NodePath.extname(path)) ?? "application/octet-stream";
  const type = isProviderSendTurnSupportedImageMimeType(mimeType) ? "image" : "file";
  const limit =
    type === "image"
      ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      : Math.min(maxFileBytes, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  if (!Number.isSafeInteger(file.size) || file.size < 1)
    throw new Error("Empty files cannot be attached.");
  if (file.size > limit)
    throw new Error(
      `This ${type} exceeds the ${Math.floor(limit / 1024 / 1024)} MiB attachment limit.`,
    );
  return {
    id: SecureRandom.uuidV4Unsafe(),
    path,
    name,
    type,
    mimeType,
    sizeBytes: file.size,
    modifiedAtMs: file.mtimeMs,
  };
}

export function localAttachmentProblem(
  attachments: ReadonlyArray<LocalAttachment>,
): string | undefined {
  return getProviderAttachmentLimitError(attachments);
}

export async function readLocalAttachment(attachment: LocalAttachment): Promise<Uint8Array> {
  const handle = await NodeFSP.open(attachment.path, "r");
  try {
    const file = await handle.stat();
    const maximum =
      attachment.type === "image"
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (
      !file.isFile() ||
      file.size !== attachment.sizeBytes ||
      file.mtimeMs !== attachment.modifiedAtMs ||
      file.size > maximum
    )
      throw new Error(
        `“${attachment.name}” changed after you attached it. Remove it and attach it again.`,
      );
    const buffer = new Uint8Array(attachment.sizeBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const final = await handle.stat();
    if (
      length !== attachment.sizeBytes ||
      final.size !== file.size ||
      final.mtimeMs !== file.mtimeMs
    )
      throw new Error(
        `“${attachment.name}” changed while reading it. Remove it and attach it again.`,
      );
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export function createLocalAttachmentUploads<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  registry: AtomRegistry.AtomRegistry,
) {
  const commands = createAttachmentEnvironmentAtoms(runtime);
  const assets = createAssetEnvironmentAtoms(runtime);
  const uploaded = new Map<string, ChatAttachment>();
  const key = (environmentId: EnvironmentId, local: LocalAttachment) =>
    `${environmentId}/${local.id}`;
  const upload = Effect.fn("TuiAttachments.upload")(function* (
    environmentId: EnvironmentId,
    local: LocalAttachment,
  ) {
    const cacheKey = key(environmentId, local);
    const previous = uploaded.get(cacheKey);
    if (previous) {
      const verified = yield* verifyPersistedAttachmentUpload({
        registry,
        createAssetUrl: assets.createUrl,
        environmentId,
        attachmentId: previous.id,
      });
      if (verified.status === "verified") return previous;
      if (verified.status === "failed")
        return yield* attachmentUploadError(
          new Error("The uploaded attachment could not be verified. Retry after reconnecting."),
        );
      uploaded.delete(cacheKey);
    }
    const bytes = yield* Effect.tryPromise({
      try: () => readLocalAttachment(local),
      catch: attachmentUploadError,
    });
    const input = {
      type: local.type,
      name: local.name,
      mimeType: local.mimeType,
      sizeBytes: local.sizeBytes,
    };
    if (!isUploadInput(input))
      return yield* attachmentUploadError(
        new Error(
          "This attachment has an unsupported type or size. Remove it and attach it again.",
        ),
      );
    const http = yield* HttpClient.HttpClient;
    const transfer = Effect.fn("TuiAttachments.transfer")(function* (url: string) {
      const response = yield* http
        .post(url, { body: HttpBody.uint8Array(bytes, local.mimeType) })
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.mapError(() =>
            attachmentUploadError(new Error("Attachment upload failed. Reconnect and retry.")),
          ),
        );
      if (response.status < 200 || response.status >= 300)
        return yield* attachmentUploadError(
          new Error(`Attachment upload was rejected (HTTP ${response.status}).`),
        );
    });
    const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
    const base = yield* environments.run(
      environmentId,
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* attachmentUploadError(new Error("The environment is not connected."));
        return prepared.value.httpBaseUrl;
      }),
    );
    const result = yield* runAttachmentUploadCycle({
      registry,
      createUploadUrl: commands.createUploadUrl,
      remove: commands.remove,
      environmentId,
      upload: input,
      resolveUploadUrl: (relativeUrl) => resolveAssetUrl(base, relativeUrl),
      transport: (url) =>
        transfer(url).pipe(
          Effect.timeoutOrElse({
            duration: "5 minutes",
            orElse: () =>
              Effect.fail(
                attachmentUploadError(
                  new Error("Attachment upload timed out. Retry after reconnecting."),
                ),
              ),
          }),
        ),
    });
    if (result.status === "failed") {
      if (result.attachmentId)
        deletePendingAttachmentUpload({
          registry,
          remove: commands.remove,
          environmentId,
          attachmentId: result.attachmentId,
        });
      return yield* attachmentUploadError(result.error);
    }
    const attachment: ChatAttachment = {
      type: local.type,
      id: ChatAttachmentId.make(result.attachmentId),
      name: local.name,
      mimeType: local.mimeType,
      sizeBytes: local.sizeBytes,
    };
    uploaded.set(cacheKey, attachment);
    return attachment;
  });
  return {
    prepare: Effect.fn("TuiAttachments.prepare")(function* (
      environmentId: EnvironmentId,
      locals: ReadonlyArray<LocalAttachment>,
    ) {
      const problem = localAttachmentProblem(locals);
      if (problem) return yield* attachmentUploadError(new Error(problem));
      const result: ChatAttachment[] = [];
      for (const local of locals) result.push(yield* upload(environmentId, local));
      return result;
    }),
    complete: (environmentId: EnvironmentId, locals: ReadonlyArray<LocalAttachment>) => {
      for (const local of locals) uploaded.delete(key(environmentId, local));
    },
    release: (environmentId: EnvironmentId, locals: ReadonlyArray<LocalAttachment>) => {
      for (const local of locals) {
        const id = key(environmentId, local);
        const attachment = uploaded.get(id);
        if (attachment)
          deletePendingAttachmentUpload({
            registry,
            remove: commands.remove,
            environmentId,
            attachmentId: attachment.id,
          });
        uploaded.delete(id);
      }
    },
  };
}
