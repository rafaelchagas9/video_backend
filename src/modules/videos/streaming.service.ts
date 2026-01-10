import { createReadStream, statSync } from 'fs';
import type { ReadStream } from 'fs';
import { extname } from 'path';
import { VIDEO_MIME_TYPES } from '@/config/constants';
import { videosService } from './videos.service';
import { AppError } from '@/utils/errors';
import { fileExists } from '@/utils/file-utils';

export interface StreamOptions {
  videoId: number;
  rangeHeader?: string;
}

export interface StreamResult {
  stream: ReadStream;
  statusCode: 200 | 206;
  headers: {
    'Content-Type': string;
    'Content-Length': number;
    'Accept-Ranges': 'bytes';
    'Content-Range'?: string;
  };
}

interface ParsedRange {
  start: number;
  end: number;
}

/**
 * Parse HTTP Range header
 * Format: "bytes=start-end" or "bytes=start-" (open-ended)
 */
function parseRangeHeader(
  rangeHeader: string,
  fileSize: number
): ParsedRange | null {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);

  if (!match) {
    return null;
  }

  const startStr = match[1];
  const endStr = match[2];

  let start: number;
  let end: number;

  if (startStr === '' && endStr !== '') {
    // Suffix range: "-500" means last 500 bytes
    const suffixLength = parseInt(endStr, 10);
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else if (startStr !== '' && endStr === '') {
    // Open-ended: "500-" means from byte 500 to end
    start = parseInt(startStr, 10);
    end = fileSize - 1;
  } else if (startStr !== '' && endStr !== '') {
    // Full range: "500-999"
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
  } else {
    return null;
  }

  // Validate range
  if (start > end || start >= fileSize || end >= fileSize) {
    return null;
  }

  return { start, end };
}

/**
 * Get MIME type from file extension
 */
function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return VIDEO_MIME_TYPES[ext] || 'application/octet-stream';
}

export class StreamingService {
  /**
   * Create a readable stream for a video file with optional range support
   */
  async createStream(options: StreamOptions): Promise<StreamResult> {
    const { videoId, rangeHeader } = options;

    // Get video details
    const video = await videosService.findById(videoId);

    // Check file availability
    if (!video.is_available || !fileExists(video.file_path)) {
      throw new AppError(410, 'Video file is not available');
    }

    // Get file stats
    const stats = statSync(video.file_path);
    const fileSize = stats.size;
    const mimeType = getMimeType(video.file_path);

    // Handle range request
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, fileSize);

      if (!range) {
        // Invalid range - return 416 Range Not Satisfiable
        throw new AppError(416, 'Range Not Satisfiable');
      }

      const { start, end } = range;
      const contentLength = end - start + 1;

      const stream = createReadStream(video.file_path, { start, end });

      return {
        stream,
        statusCode: 206,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': contentLength,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        },
      };
    }

    // No range - return full file
    const stream = createReadStream(video.file_path);

    return {
      stream,
      statusCode: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': fileSize,
        'Accept-Ranges': 'bytes',
      },
    };
  }
}

export const streamingService = new StreamingService();
