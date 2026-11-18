// @effect-diagnostics nodeBuiltinImport:off -- Tests local attachment selection and bounded reads against isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import {
  inspectLocalAttachment,
  localAttachmentProblem,
  readLocalAttachment,
} from "./attachments.ts";

const withFiles = <A>(run: (directory: string) => Promise<A>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tui-attachment-"))),
    (directory) => Effect.promise(() => run(directory)),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
  );

describe("local terminal attachments", () => {
  it.effect(
    "reads the selected file exactly and refuses replacements or changes before sending",
    () =>
      withFiles(async (directory) => {
        const path = NodePath.join(directory, "Änderungen $(literal).txt");
        await NodeFSP.writeFile(path, "selected contents");
        await NodeFSP.utimes(path, 1, 1);
        const attachment = await inspectLocalAttachment(path);
        expect(attachment).toMatchObject({
          name: "Änderungen $(literal).txt",
          type: "file",
          sizeBytes: 17,
        });
        expect(new TextDecoder().decode(await readLocalAttachment(attachment))).toBe(
          "selected contents",
        );
        await NodeFSP.writeFile(path, "new file contents");
        await NodeFSP.utimes(path, 2, 2);
        await expect(readLocalAttachment(attachment)).rejects.toThrow(
          "changed after you attached it",
        );
        await NodeFSP.unlink(path);
        await NodeFSP.mkdir(path);
        await expect(readLocalAttachment(attachment)).rejects.toThrow(
          "changed after you attached it",
        );
      }),
  );

  it.effect("enforces server file limits and shared image/count limits before reading bytes", () =>
    withFiles(async (directory) => {
      const path = NodePath.join(directory, "large.png");
      await NodeFSP.writeFile(path, new Uint8Array([1]));
      const handle = await NodeFSP.open(path, "r+");
      try {
        await handle.truncate(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
      } finally {
        await handle.close();
      }
      await expect(inspectLocalAttachment(path)).rejects.toThrow("image exceeds the 10 MiB");
      const ordinary = NodePath.join(directory, "document.bin");
      await NodeFSP.writeFile(ordinary, new Uint8Array(5));
      await expect(inspectLocalAttachment(ordinary, 4)).rejects.toThrow("file exceeds");
      const file = await inspectLocalAttachment(ordinary, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
      expect(localAttachmentProblem(Array.from({ length: 101 }, () => file))).toContain(
        "100 files",
      );
      const image = {
        ...file,
        type: "image" as const,
        mimeType: "image/png",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      };
      expect(localAttachmentProblem(Array.from({ length: 9 }, () => image))).toContain("80 MiB");
      const empty = NodePath.join(directory, "empty.txt");
      await NodeFSP.writeFile(empty, "");
      await expect(inspectLocalAttachment(empty)).rejects.toThrow("Empty files");
    }),
  );
});
