import { basename } from "path";
import { ValidationError } from "@/utils/errors";

const MAX_OUTPUT_FILE_NAME_BYTES = 220;

export function canonicalizeOutputFileName(fileName: string): string {
  const hasControlCharacter = Array.from(fileName).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (fileName !== fileName.trim() || fileName.length === 0) {
    throw new ValidationError("Output file name must not be empty or padded");
  }
  if (
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    hasControlCharacter ||
    basename(fileName) !== fileName
  ) {
    throw new ValidationError("Output file name must be a safe basename");
  }

  const canonical = fileName.toLowerCase().endsWith(".mkv")
    ? `${fileName.slice(0, -4)}.mkv`
    : `${fileName}.mkv`;
  if (canonical === ".mkv") {
    throw new ValidationError("Output file name must include a name");
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_OUTPUT_FILE_NAME_BYTES) {
    throw new ValidationError("Output file name is too long");
  }
  return canonical;
}
