// Drizzle ORM Schema Definitions
// Central barrel export for all database tables and relations

// Users & Sessions
export * from './users.schema';

// Directories & Scanning
export * from './directories.schema';

// Videos & Metadata
export * from './videos.schema';

// Organization (Creators, Tags, Studios, Platforms)
export * from './organization.schema';

// Content (Playlists, Favorites, Bookmarks, Ratings)
export * from './content.schema';

// Media (Thumbnails, Storyboards)
export * from './media.schema';

// Conversion Jobs
export * from './conversion.schema';

// Statistics Snapshots
export * from './stats.schema';

// Tagging Rules & Auto-Tagging
export * from './tagging.schema';

// Triage Progress
export * from './triage.schema';

// App Settings
export * from './app-settings.schema';

// Face Recognition
export * from './face-recognition.schema';

// Relations (for Drizzle relational queries)
export * from './relations';
