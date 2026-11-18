import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  clampFileAttachmentUploadBytes,
  formatAttachmentSize,
} from "@t3tools/client-runtime/state/attachments";
import {
  inspectLocalAttachment,
  localAttachmentProblem,
  type LocalAttachment,
} from "../runtime/attachments.ts";
import type { FeatureProps } from "../ui/controller.ts";

export function attachmentActions(
  props: FeatureProps,
  attachments: ReadonlyArray<LocalAttachment>,
  onChange: (attachments: ReadonlyArray<LocalAttachment>) => void,
  canUpdate: () => boolean,
) {
  const config: ServerConfig | null = props.state()?.config ?? null;
  const maxFileBytes = config?.environment.capabilities.fileAttachments?.maxUploadBytes;
  const add = () =>
    props.ui.form({
      title: "Attach local file",
      description: `The file is read from this computer and uploaded to the thread's environment when you send. Images: ${formatAttachmentSize(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)}; files: ${maxFileBytes ? formatAttachmentSize(clampFileAttachmentUploadBytes(maxFileBytes)) : "unavailable on this server"}.`,
      fields: [{ name: "path", label: "Local file path", required: true }],
      submitLabel: "Attach file",
      onSubmit: async (values) => {
        const attachment = await inspectLocalAttachment(
          values.path ?? "",
          maxFileBytes === undefined
            ? PROVIDER_SEND_TURN_MAX_FILE_BYTES
            : clampFileAttachmentUploadBytes(maxFileBytes),
        );
        if (attachment.type === "file" && maxFileBytes === undefined)
          throw new Error("This server does not support file uploads.");
        if (
          attachment.type === "image" &&
          config?.environment.capabilities.attachmentUploads !== true
        )
          throw new Error("This server does not support image uploads.");
        if (!canUpdate()) throw new Error("Return to this conversation to attach the file.");
        const next = [...attachments, attachment];
        const problem = localAttachmentProblem(next);
        if (problem) throw new Error(problem);
        onChange(next);
      },
    });
  props.ui.choose("Attachments", [
    { title: "Attach local file…", description: "Images or files from this computer", run: add },
    ...attachments.map((attachment) => ({
      title: `Remove ${attachment.name}`,
      description: `${attachment.path} · ${formatAttachmentSize(attachment.sizeBytes)}`,
      run: () => {
        if (canUpdate()) onChange(attachments.filter((value) => value.id !== attachment.id));
      },
    })),
    ...(attachments.length
      ? [
          {
            title: "Remove all attachments",
            run: () => {
              if (canUpdate()) onChange([]);
            },
          },
        ]
      : []),
  ]);
}
