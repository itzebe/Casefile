import { existsSync } from "node:fs";

/**
 * OCR for images.
 *
 * The mission allows OCR "when a supported local implementation is available".
 * No OCR engine ships with the framework, and no paid service is permitted, so
 * this module probes for a local engine and otherwise reports a clear
 * limitation. It never fabricates text for an image it could not read.
 *
 * Set `CASEFILE_TESSERACT_PATH` to a local tesseract binary to enable OCR.
 */

export type OcrResult =
  | { kind: "ok"; text: string }
  | { kind: "empty" }
  | { kind: "failed"; error: string }
  | { kind: "unavailable" };

let cachedAvailability: { path: string; available: boolean } | null = null;

export function ocrBinaryPath(): string | null {
  const configured = process.env.CASEFILE_TESSERACT_PATH?.trim();
  if (!configured) return null;
  if (cachedAvailability?.path === configured) {
    return cachedAvailability.available ? configured : null;
  }
  const available = existsSync(configured);
  cachedAvailability = { path: configured, available };
  return available ? configured : null;
}

export function ocrUnavailableReason(): string {
  const configured = process.env.CASEFILE_TESSERACT_PATH?.trim();
  if (configured && !ocrBinaryPath()) {
    return `CASEFILE_TESSERACT_PATH is set to "${configured}", which does not exist.`;
  }
  return "No local OCR engine is configured. Set CASEFILE_TESSERACT_PATH to a tesseract binary to extract text from images.";
}

export async function runOcr(
  data: Uint8Array,
  _mimeType: string,
): Promise<OcrResult> {
  const binary = ocrBinaryPath();
  if (!binary) return { kind: "unavailable" };

  const { spawn } = await import("node:child_process");
  return await new Promise<OcrResult>((resolve) => {
    // Arguments are fixed and the file arrives on stdin, so a crafted filename
    // cannot become a shell argument.
    const child = spawn(binary, ["stdin", "stdout", "--psm", "6"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (result: OcrResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ kind: "failed", error: "OCR timed out after 60s." });
    }, 60_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      settle({ kind: "failed", error: `OCR could not start: ${error.message}` });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf-8").trim();
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf-8").trim().slice(0, 200);
        settle({
          kind: "failed",
          error: `OCR exited with code ${code}${detail ? `: ${detail}` : ""}`,
        });
        return;
      }
      settle(text ? { kind: "ok", text } : { kind: "empty" });
    });
    child.stdin.end(Buffer.from(data));
  });
}
