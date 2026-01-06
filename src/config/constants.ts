export const SUPPORTED_VIDEO_FORMATS = [
  '.mkv',
  '.mp4',
  '.mov',
  '.wmv',
  '.avi',
  '.flv',
  '.webm',
  '.m4v',
  '.mpg',
  '.mpeg',
] as const;

export const VIDEO_MIME_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.m4v': 'video/x-m4v',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};

export const API_PREFIX = '/api';

export const COOKIE_NAME = 'session_id';

export const HASH_ALGORITHM = 'sha256';
