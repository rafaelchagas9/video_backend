-- Enable pgvector extension
-- This extension provides vector similarity search capabilities
-- Install pgvector on your PostgreSQL server before running this migration:
-- Ubuntu/Debian: apt install postgresql-16-pgvector
-- macOS: brew install pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- This migration should be run AFTER the Drizzle-generated migration creates the base tables
-- It converts the text embedding columns to vector(512) type and adds HNSW indexes

-- Alter creator_face_embeddings.embedding from text to vector(512)
-- Note: If the column doesn't exist yet, run `bun db:push` first
-- Using separate statements to avoid procedural block issues with migration runner
ALTER TABLE creator_face_embeddings ALTER COLUMN embedding TYPE vector(512);

-- Alter video_face_detections.embedding from text to vector(512)
ALTER TABLE video_face_detections ALTER COLUMN embedding TYPE vector(512);

-- Create HNSW index on creator_face_embeddings for fast cosine similarity search
-- Parameters:
-- - m: Maximum number of connections per layer (16 is a good default)
-- - ef_construction: Size of dynamic candidate list for graph construction (64 is a good default)
-- Higher values = better recall but slower indexing and more memory
CREATE INDEX IF NOT EXISTS idx_creator_face_embeddings_embedding_hnsw
    ON creator_face_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Create HNSW index on video_face_detections for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_video_face_detections_embedding_hnsw
    ON video_face_detections
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
