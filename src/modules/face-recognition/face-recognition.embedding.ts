export const FACE_EMBEDDING_DIMENSION = 512;

export function assertValidFaceEmbedding(
  embedding: unknown,
  context = "Face embedding"
): asserts embedding is number[] {
  if (!Array.isArray(embedding)) {
    throw new Error(`${context} must be an array`);
  }

  if (embedding.length !== FACE_EMBEDDING_DIMENSION) {
    throw new Error(
      `${context} has ${embedding.length} dimensions; expected ${FACE_EMBEDDING_DIMENSION}`
    );
  }

  if (
    !embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value)
    )
  ) {
    throw new Error(`${context} contains a non-finite numeric value`);
  }
}
