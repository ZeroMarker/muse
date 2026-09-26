import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { EXPORT_FORMATS, parseExportFormat, type ExportFormat } from "../web/src/export-formats";

export function outputFormat(explicit: string | null, output: string | null): ExportFormat {
  const extension = output ? extname(output).slice(1) : "";
  const format = explicit ? parseExportFormat(explicit) : extension ? parseExportFormat(extension) : "wav";
  if (extension && parseExportFormat(extension) !== format) throw new Error("output extension does not match --format");
  return format;
}

export function encodeAudio(wav: Buffer, format: ExportFormat): Buffer {
  if (format === "wav") return wav;
  if (format === "mid") throw new Error("MIDI uses note export, not audio encoding");
  const directory = mkdtempSync(join(tmpdir(), "muse-export-"));
  try {
    const input = join(directory, "input.wav");
    const output = join(directory, "output." + EXPORT_FORMATS[format].extension);
    writeFileSync(input, wav);
    const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-map_metadata", "-1", ...EXPORT_FORMATS[format].args, output],
      { encoding: "utf8", timeout: 300000 });
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("FFmpeg is required for MP3, FLAC, OGG and AAC/M4A exports; install ffmpeg or choose WAV/MIDI");
      throw new Error("FFmpeg failed: " + result.error.message);
    }
    if (result.status !== 0) throw new Error("FFmpeg encoding failed: " + result.stderr.trim());
    return readFileSync(output);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
