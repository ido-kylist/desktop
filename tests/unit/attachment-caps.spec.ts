import type { IpcError } from "@shared/ipc-contract";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_EXTENSIONS,
  isTooLarge,
  isTooMany,
  kindForFilename,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILES,
  MAX_PREVIEW_BYTES,
} from "../../src/main/attachments/store.js";
import {
  ACCEPT_ATTRIBUTE,
  attachmentPathsFromFiles,
  describeAttachmentFailure,
  formatBytes,
  rejectReasonOf,
  tooManyProblem,
  unresolvedPathsProblem,
} from "../../src/renderer/src/lib/attachments.js";

/**
 * The caps as arithmetic, the kinds as a table, and the reasons as three different things
 * on screen.
 *
 * No file system here: the brief's integration test proves the copies, the modes, and the
 * round trip against a real SQLite file. What is asserted here is everything decidable from
 * a number or a name — because those are the decisions both sides of the boundary have to
 * agree on, and a cap that is off by one is invisible until a user hits it.
 *
 * The last block is the point of the reason codes: `too_large`, `too_many`, and
 * `unsupported_type` must render as three distinct states, not one generic failure. AGENTS.md
 * requires a test that proves the UI tells them apart.
 */

function error(details: Record<string, unknown>, code: IpcError["code"] = "BAD_REQUEST"): IpcError {
  return { code, message: "refused", details };
}

describe("the caps", () => {
  it("takes ten files at a time, which is what chat.send accepts", () => {
    expect(MAX_ATTACHMENT_FILES).toBe(10);
    expect(isTooMany(0)).toBe(false);
    expect(isTooMany(9)).toBe(false);
    // Exactly at the cap is allowed: the eleventh file is the one over the line.
    expect(isTooMany(10)).toBe(false);
    expect(isTooMany(11)).toBe(true);
  });

  it("caps one file at 25 MiB, inclusive", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_ATTACHMENT_BYTES).toBe(26_214_400);
    expect(isTooLarge(0)).toBe(false);
    expect(isTooLarge(MAX_ATTACHMENT_BYTES)).toBe(false);
    expect(isTooLarge(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
  });

  it("inlines a thumbnail only up to 1 MiB, which is far under the per-file cap", () => {
    expect(MAX_PREVIEW_BYTES).toBe(1024 * 1024);
    expect(MAX_PREVIEW_BYTES).toBeLessThan(MAX_ATTACHMENT_BYTES);
  });
});

describe("kind detection by extension", () => {
  it("calls the five image formats images, with the mime the platform expects", () => {
    expect(kindForFilename("shot.png")).toEqual({ kind: "image", mime: "image/png" });
    expect(kindForFilename("shot.jpg")).toEqual({ kind: "image", mime: "image/jpeg" });
    // Both spellings map to one mime: a jpeg is a jpeg however it was named.
    expect(kindForFilename("shot.jpeg")).toEqual({ kind: "image", mime: "image/jpeg" });
    expect(kindForFilename("shot.webp")).toEqual({ kind: "image", mime: "image/webp" });
    expect(kindForFilename("shot.gif")).toEqual({ kind: "image", mime: "image/gif" });
  });

  it("calls the three document formats documents", () => {
    expect(kindForFilename("paper.pdf")).toEqual({ kind: "document", mime: "application/pdf" });
    expect(kindForFilename("notes.txt")).toEqual({ kind: "document", mime: "text/plain" });
    expect(kindForFilename("readme.md")).toEqual({ kind: "document", mime: "text/markdown" });
  });

  it("ignores case, because a camera roll and a Save As dialog both shout", () => {
    expect(kindForFilename("SHOT.PNG")).toEqual({ kind: "image", mime: "image/png" });
    expect(kindForFilename("Paper.PdF")).toEqual({ kind: "document", mime: "application/pdf" });
  });

  it("is null for everything else, rather than guessing a mime", () => {
    for (const filename of [
      "archive.zip",
      "script.sh",
      "song.mp3",
      "photo.heic",
      "noextension",
      // A leading dot is a hidden file with no extension, not a png.
      ".png",
      // A double extension is judged by the last one.
      "actually-a-zip.png.exe",
    ]) {
      expect(kindForFilename(filename)).toBeNull();
    }
  });

  it("offers the picker exactly the extensions it accepts", () => {
    expect(ATTACHMENT_EXTENSIONS).toHaveLength(8);
    for (const extension of ATTACHMENT_EXTENSIONS) {
      expect(kindForFilename(`file${extension}`)).not.toBeNull();
    }
    expect(ACCEPT_ATTRIBUTE).toBe(ATTACHMENT_EXTENSIONS.join(","));
  });
});

describe("formatBytes", () => {
  it("uses binary units, because the caps are binary", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe("25 MB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it("renders nothing for a number that is not a size", () => {
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Number.NaN)).toBe("");
  });
});

describe("one refusal per reason", () => {
  const cases: { reason: string; details: Record<string, unknown> }[] = [
    {
      reason: "too_large",
      details: { reason: "too_large", filename: "clip.mov.pdf", limitBytes: MAX_ATTACHMENT_BYTES },
    },
    { reason: "too_many", details: { reason: "too_many", limit: MAX_ATTACHMENT_FILES } },
    { reason: "unsupported_type", details: { reason: "unsupported_type", filename: "app.exe" } },
    { reason: "unknown_attachment", details: { reason: "unknown_attachment", ids: ["x"] } },
    { reason: "attachment_taken", details: { reason: "attachment_taken" } },
  ];

  it("gives every reason its own state, title, and test id", () => {
    const problems = cases.map((entry) => describeAttachmentFailure(error(entry.details)));
    const reasons = problems.map((problem) => problem.reason);

    expect(reasons).toEqual(cases.map((entry) => entry.reason));
    expect(new Set(problems.map((problem) => problem.testId)).size).toBe(cases.length);
    expect(new Set(problems.map((problem) => problem.title)).size).toBe(cases.length);
    // Every detail line is written for its own case, not one shared string.
    expect(new Set(problems.map((problem) => problem.detail)).size).toBe(cases.length);
  });

  it("puts the filename and the limit in the too_large message", () => {
    const problem = describeAttachmentFailure(
      error({ reason: "too_large", filename: "scan.pdf", limitBytes: MAX_ATTACHMENT_BYTES }),
    );

    expect(problem.testId).toBe("attachment-error-too_large");
    expect(problem.detail).toContain("scan.pdf");
    // The limit is the number main enforced, rendered in the units main enforces it in.
    expect(problem.detail).toContain("25 MB");
  });

  it("puts the count in the too_many message", () => {
    const problem = describeAttachmentFailure(
      error({ reason: "too_many", limit: MAX_ATTACHMENT_FILES }),
    );

    expect(problem.detail).toContain("10 files");
  });

  it("names the file and lists what is accepted for an unsupported type", () => {
    const problem = describeAttachmentFailure(
      error({ reason: "unsupported_type", filename: "deck.key" }),
    );

    expect(problem.detail).toContain("deck.key");
    expect(problem.detail).toContain("PDF");
  });

  it("falls back to the message main sent when there is no reason at all", () => {
    const problem = describeAttachmentFailure({ code: "INTERNAL", message: "disk on fire" });

    expect(problem.title).toBe("Could not attach");
    expect(problem.detail).toBe("disk on fire");
    expect(problem.testId).toBe("attachment-error");
  });

  it("does not treat a reason from a newer main as a state it knows", () => {
    // A build older than main must show the generic failure, not a raw code where a
    // sentence should be.
    expect(rejectReasonOf({ reason: "virus_detected" })).toBeNull();
    expect(rejectReasonOf(undefined)).toBeNull();

    const problem = describeAttachmentFailure(
      error({ reason: "virus_detected" }, "UPSTREAM_ERROR"),
    );
    expect(problem.testId).toBe("attachment-error");
    expect(problem.reason).toBe("unknown");
  });

  it("keeps the renderer's own two states apart from main's five", () => {
    const unresolved = unresolvedPathsProblem(2);
    const tooMany = tooManyProblem(MAX_ATTACHMENT_FILES);

    expect(unresolved.testId).toBe("attachment-error-unresolved_paths");
    expect(tooMany.testId).toBe("attachment-error-too_many");
    expect(unresolved.detail).toContain("2 of those files");
    expect(tooMany.detail).toBe(tooManyProblem(10).detail);
  });

  it("writes the singular form for one file", () => {
    expect(unresolvedPathsProblem(1).detail).toContain("location of that file");
  });
});

describe("paths from a drop, a paste, or the picker", () => {
  it("keeps the paths it was given", () => {
    const { paths, unresolved } = attachmentPathsFromFiles([
      { path: "/tmp/a.png", name: "a.png" },
      { path: "/tmp/b.pdf", name: "b.pdf" },
    ]);

    expect(paths).toEqual(["/tmp/a.png", "/tmp/b.pdf"]);
    expect(unresolved).toEqual([]);
  });

  it("reports a file with no path instead of dropping it silently", () => {
    const { paths, unresolved } = attachmentPathsFromFiles([
      { path: "/tmp/a.png", name: "a.png" },
      { name: "b.png" },
      { path: "   ", name: "c.png" },
      {},
    ]);

    expect(paths).toEqual(["/tmp/a.png"]);
    // A partial batch has to be visible: three dropped files that became one chip is a
    // failure the user would only notice after sending.
    expect(unresolved).toEqual(["b.png", "c.png", "an unnamed file"]);
  });

  it("does nothing for an empty batch", () => {
    expect(attachmentPathsFromFiles([])).toEqual({ paths: [], unresolved: [] });
  });
});
