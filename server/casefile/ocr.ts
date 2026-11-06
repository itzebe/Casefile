import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * OCR for images.
 *
 * The mission allows OCR "when a supported local implementation is available".
 * Tesseract is free and open source, so this module discovers it on `PATH` (and
 * in the usual install locations) and runs it locally. No paid service is
 * involved and no text is ever invented for an image that could not be read.
 *
 * `CASEFILE_TESSERACT_PATH` overrides the discovery when an operator wants a
 * specific binary. On a hosted runtime with no binary installed, discovery
 * finds nothing and the file is reported as needing OCR.
 */

export type OcrResult =
  | { kind: "ok"; text: string }
  | { kind: "empty" }
  | { kind: "failed"; error: string }
  | { kind: "unavailable" };

let cachedAvailability: { path: string; available: boolean } | null = null;

/**
 * The tesseract binary to use, or null.
 *
 * `CASEFILE_TESSERACT_PATH` wins when set, so an operator can point at a
 * specific build. Otherwise the engine is discovered on `PATH` and in the usual
 * install locations: OCR should work when tesseract is present, not only when
 * someone remembers to set an environment variable. A hosted serverless runtime
 * ships no binary, so discovery finds nothing there and the file is reported as
 * needing OCR rather than silently producing no text.
 */
const TESSERACT_CANDIDATES = [
  "/usr/bin/tesseract",
  "/usr/local/bin/tesseract",
  "/opt/homebrew/bin/tesseract",
  "/opt/local/bin/tesseract",
];

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function discoverTesseractOnPath(): string | null {
  // A PATH entry is a directory name, never a credential.
  const pathValue = process.env.PATH?.trim(); // guard:allow-env-credential — search path, not a credential
  const dirs = pathValue ? pathValue.split(delimiter) : [];
  for (const dir of [...dirs, ...TESSERACT_CANDIDATES.map((p) => p.replace(/\/tesseract$/, ""))]) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "tesseract.exe" : "tesseract");
    if (executable(candidate)) return candidate;
  }
  return null;
}

export function ocrBinaryPath(): string | null {
  // A local filesystem path to a binary, never a credential.
  const configured = process.env.CASEFILE_TESSERACT_PATH?.trim(); // guard:allow-env-credential — local binary path, not a credential
  const resolved = configured || discoverTesseractOnPath();
  if (!resolved) return null;
  if (cachedAvailability?.path === resolved) {
    return cachedAvailability.available ? resolved : null;
  }
  const available = executable(resolved);
  cachedAvailability = { path: resolved, available };
  return available ? resolved : null;
}

export function ocrUnavailableReason(): string {
  const configured = process.env.CASEFILE_TESSERACT_PATH?.trim(); // guard:allow-env-credential — local binary path, not a credential
  if (configured && !ocrBinaryPath()) {
    return `CASEFILE_TESSERACT_PATH is set to "${configured}", which does not exist.`;
  }
  return "No local OCR engine was found on PATH. Install tesseract, or set CASEFILE_TESSERACT_PATH to its binary, to extract text from images.";
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
