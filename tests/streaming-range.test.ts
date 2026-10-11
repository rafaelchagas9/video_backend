import { describe, expect, it } from "bun:test";
import { parseRangeHeader } from "@/modules/videos/streaming-range";

describe("single byte ranges", () => {
  it("clamps a satisfiable explicit end to EOF", () => {
    expect(parseRangeHeader("bytes=900-1500", 1000, 500)).toEqual({ start: 900, end: 999 });
    expect(parseRangeHeader("bytes=0-99999", 1000, 500)).toEqual({ start: 0, end: 499 });
  });
  it("caps explicit and open-ended chunks without passing EOF", () => {
    expect(parseRangeHeader("bytes=100-", 1000, 200)).toEqual({ start: 100, end: 299 });
    expect(parseRangeHeader("bytes=950-", 1000, 200)).toEqual({ start: 950, end: 999 });
    expect(parseRangeHeader("bytes=100-149", 1000, 200)).toEqual({ start: 100, end: 149 });
  });
  it("preserves full suffix ranges, including suffixes larger than the file", () => {
    expect(parseRangeHeader("bytes=-700", 1000, 200)).toEqual({ start: 300, end: 999 });
    expect(parseRangeHeader("bytes=-1500", 1000, 200)).toEqual({ start: 0, end: 999 });
  });
  it("rejects malformed, multipart, unsatisfiable and unsafe numeric ranges", () => {
    for (const header of ["bytes=-", "bytes=-0", "bytes=1000-", "bytes=999-900",
      "bytes=0-1,4-5", "junk bytes=0-10", "bytes=0-10 junk", "items=0-10",
      "bytes=9007199254740992-", "bytes=0-9007199254740992"])
      expect(parseRangeHeader(header, 1000, 500)).toBeNull();
    expect(parseRangeHeader("bytes=0-", 0, 500)).toBeNull();
    expect(parseRangeHeader("bytes=0-", 1000, 0)).toBeNull();
  });
});
