/**
 * Frame Extraction Types
 * Interfaces for unified video frame extraction
 */

/**
 * Extracted frame metadata
 */
export interface ExtractedFrame {
  filePath: string; // Path to extracted frame image
  timestampSeconds: number; // Position in video
  frameIndex: number; // Sequential frame number (0-based)
  width: number; // Frame width in pixels
  height: number; // Frame height in pixels
}

/**
 * Frame extraction options
 */
export interface FrameExtractionOptions {
  videoId: number; // Video ID
  videoPath: string; // Path to video file
  videoDuration: number; // Duration in seconds
  intervalSeconds: number; // Interval between frames
  targetWidth?: number; // Target frame width (maintains aspect ratio if only width specified)
  targetHeight?: number; // Target frame height
  outputFormat?: 'jpg' | 'webp' | 'png'; // Output format (default: jpg)
  quality?: number; // Quality 1-100 (default: 90)
  tempDir?: string; // Temp directory for frames (default: /dev/shm)
  prefix?: string; // Filename prefix (default: 'frame')
}

/**
 * Frame extraction result
 */
export interface FrameExtractionResult {
  videoId: number;
  frames: ExtractedFrame[];
  totalFrames: number;
  extractionTimeMs: number;
  tempDirectory: string;
}

/**
 * Frame cleanup options
 */
export interface FrameCleanupOptions {
  removeDirectory?: boolean; // Remove the entire temp directory (default: false)
  keepFiles?: string[]; // Paths to files that should not be deleted
}
