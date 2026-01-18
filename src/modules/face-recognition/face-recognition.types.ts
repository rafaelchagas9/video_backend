/**
 * Face Recognition Types
 * Interfaces for face detection, embeddings, and Python service communication
 */

/**
 * Face detection result from Python service (InsightFace)
 */
export interface FaceDetectionResult {
  bbox: number[]; // [x1, y1, x2, y2] bounding box coordinates
  det_score: number; // Detection confidence (0-1)
  embedding: number[]; // 512-dimensional face embedding
  landmark_2d_106?: number[][]; // 106 facial landmarks (optional)
  age?: number; // Estimated age
  gender?: "M" | "F"; // Estimated gender
}

/**
 * Request to Python face service for detection
 */
export interface DetectFacesRequest {
  image_base64: string; // Base64-encoded image
}

/**
 * Response from Python face service for detection
 */
export interface DetectFacesResponse {
  faces: FaceDetectionResult[];
  image_width: number;
  image_height: number;
  processing_time_ms: number;
}

/**
 * Health check response from Python service
 */
export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  version?: string;
  model?: string;
  onnx_providers?: string[];
  embedding_dimension?: number;
  uptime_seconds?: number;
}

/**
 * Similarity search request
 */
export interface SimilaritySearchRequest {
  embedding: number[]; // 512-dimensional query embedding
  limit?: number; // Maximum number of results (default: 10)
  threshold?: number; // Minimum similarity threshold (default: 0.65)
}

/**
 * Similarity search result (creator match)
 */
export interface SimilarityMatch {
  creator_id: number;
  creator_name: string;
  similarity: number; // Cosine similarity (0-1)
  reference_embedding_id: number;
  reference_source_type: string;
}

/**
 * Face extraction job status
 */
export type FaceExtractionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "skipped";

/**
 * Face match status (for user confirmation)
 */
export type FaceMatchStatus = "pending" | "confirmed" | "rejected" | "no_match";

/**
 * Extracted frame metadata (from frame extraction service)
 */
export interface ExtractedFrame {
  filePath: string; // Path to extracted frame
  timestampSeconds: number; // Position in video
  frameIndex: number; // Frame number in storyboard
  width: number; // Frame width
  height: number; // Frame height
}

/**
 * Face processing options
 */
export interface FaceProcessingOptions {
  detectionThreshold?: number; // Minimum detection confidence (default: 0.5)
  similarityThreshold?: number; // Minimum similarity for auto-matching (default: 0.65)
  autoTagThreshold?: number; // Minimum similarity for auto-tagging (default: 0.75)
  maxRetries?: number; // Maximum retry attempts (default: 3)
  retryIntervalMs?: number; // Retry interval in milliseconds (default: 300000 = 5 min)
}


