import { describe, expect, it } from "bun:test";
import {
  assertValidFaceEmbedding,
  FACE_EMBEDDING_DIMENSION,
} from "@/modules/face-recognition/face-recognition.embedding";

describe("face embedding validation", () => {
  it("accepts a finite 512-dimensional embedding", () => {
    expect(() =>
      assertValidFaceEmbedding(
        Array.from({ length: FACE_EMBEDDING_DIMENSION }, () => 0.1)
      )
    ).not.toThrow();
  });

  it("rejects embeddings with the wrong dimensions", () => {
    expect(() => assertValidFaceEmbedding([0.1, 0.2, 0.3])).toThrow(
      "has 3 dimensions; expected 512"
    );
  });

  it("rejects non-finite values", () => {
    const embedding = Array.from(
      { length: FACE_EMBEDDING_DIMENSION },
      () => 0.1
    );
    embedding[10] = Number.NaN;

    expect(() => assertValidFaceEmbedding(embedding)).toThrow(
      "contains a non-finite numeric value"
    );
  });
});
