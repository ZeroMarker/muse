export const EXPORT_FORMATS = {
  wav: { label: "WAV", extension: "wav", mime: "audio/wav", args: [] },
  mp3: { label: "MP3", extension: "mp3", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"] },
  flac: { label: "FLAC", extension: "flac", mime: "audio/flac", args: ["-c:a", "flac", "-f", "flac"] },
  ogg: { label: "OGG", extension: "ogg", mime: "audio/ogg", args: ["-c:a", "libvorbis", "-q:a", "5", "-f", "ogg"] },
  aac: { label: "AAC", extension: "aac", mime: "audio/aac", args: ["-c:a", "aac", "-b:a", "192k", "-f", "adts"] },
  m4a: { label: "M4A (AAC)", extension: "m4a", mime: "audio/mp4", args: ["-c:a", "aac", "-b:a", "192k", "-f", "mp4"] },
  mid: { label: "MIDI", extension: "mid", mime: "audio/midi", args: [] },
} as const;

export type ExportFormat = keyof typeof EXPORT_FORMATS;

export function parseExportFormat(value: string): ExportFormat {
  const normalized = value.toLowerCase() === "midi" ? "mid" : value.toLowerCase();
  if (!Object.hasOwn(EXPORT_FORMATS, normalized)) throw new Error("unsupported export format: " + value + " (wav, mp3, flac, ogg, aac, m4a, mid)");
  return normalized as ExportFormat;
}
