# Frontend Implementation Checklist

Implementation roadmap for the video streaming frontend. Features are organized into phases for systematic development.

## Table of Contents

- [Phase 1: Core Authentication & Setup](#phase-1-core-authentication--setup)
- [Phase 2: Video Browsing & Playback](#phase-2-video-browsing--playback)
- [Phase 3: Directory Management](#phase-3-directory-management)
- [Phase 4: Organization Features](#phase-4-organization-features)
- [Phase 5: User Interactions](#phase-5-user-interactions)
- [Phase 6: Playlists](#phase-6-playlists)
- [Phase 7: Advanced Features](#phase-7-advanced-features)
- [UI/UX Considerations](#uiux-considerations)
- [Edge Cases to Handle](#edge-cases-to-handle)
- [Technical Notes](#technical-notes)

---

## Phase 1: Core Authentication & Setup

**Goal**: Establish authentication flow and protected routes.

### Features to Implement

- [ ] **Login Page**
  - Username/password form
  - Form validation (username: 3-50 chars, password: 8-100 chars)
  - Error message display (401: invalid credentials)
  - "Remember me" checkbox (optional)
  - Redirect to videos page on success

- [ ] **Registration Page**
  - Username/password form with same validation
  - Display "User already exists" message (409 error)
  - Explain single-user limitation
  - Auto-redirect to login after successful registration

- [ ] **Session Cookie Management**
  - Configure HTTP client to include credentials (`credentials: 'include'`)
  - Store user info in app state/context after login
  - Session persists across page refreshes

- [ ] **Protected Route Wrapper**
  - Check authentication status on protected pages
  - Redirect to login if 401 error
  - Show loading spinner while checking auth

- [ ] **Logout Functionality**
  - Logout button in header/navbar
  - Call `/api/auth/logout` endpoint
  - Clear user state
  - Redirect to login page

- [ ] **401 Error Handling**
  - Global interceptor for 401 responses
  - Clear user state on session expiration
  - Redirect to login with "Session expired" message

### API Endpoints Used

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

---

## Phase 2: Video Browsing & Playback

**Goal**: Core video viewing functionality.

### Features to Implement

- [ ] **Video List Page**
  - Grid or list view of videos
  - Display: thumbnail, title/filename, duration, file size
  - Pagination controls (page, limit)
  - Show total count and current page
  - Loading state while fetching

- [ ] **Search and Filter Controls**
  - Search input (searches file name and title)
  - Directory filter dropdown
  - Clear filters button

- [ ] **Sort Options**
  - Sort by: created date, filename, duration, file size, indexed date
  - Ascending/descending toggle
  - Persist sort preference (optional)

- [ ] **Video Player Component**
  - HTML5 video player with range request support
  - Controls: play/pause, seek bar, volume, fullscreen
  - Playback speed controls (0.5x, 1x, 1.5x, 2x)
  - Keyboard shortcuts (space = play/pause, arrow keys = seek)
  - Display current time / total duration

- [ ] **Video Detail Page**
  - Large video player
  - Display all metadata (title, description, themes, duration, resolution, codec, bitrate, fps)
  - Show file info (filename, path, size, hash)
  - Display creators, tags, ratings
  - Edit metadata button (opens modal)

- [ ] **File Availability Indicator**
  - Show badge/icon if `is_available = 0`
  - Display "File not found" message
  - Disable playback for unavailable videos
  - Show last verified timestamp

- [ ] **Missing File Handling**
  - Show error message instead of player
  - Offer "Verify file" button (calls `/api/videos/:id/verify`)
  - Update status after verification

### API Endpoints Used

- `GET /api/videos` (list with pagination)
- `GET /api/videos/:id` (details)
- `GET /api/videos/:id/stream` (playback)
- `POST /api/videos/:id/verify` (check availability)
- `PATCH /api/videos/:id` (update metadata)

---

## Phase 3: Directory Management

**Goal**: Register and monitor video directories.

### Features to Implement

- [ ] **Directory Registration Form**
  - Input for absolute directory path
  - Path validation (client-side)
  - Success/error message display
  - Auto-refresh directory list after registration

- [ ] **Directory List View**
  - Table showing all directories
  - Columns: path, active status, last scan, video count
  - Edit and delete buttons per row

- [ ] **Manual Scan Trigger**
  - "Scan Now" button per directory
  - Show loading spinner during scan
  - Display "Scan completed" message
  - Refresh statistics after scan

- [ ] **Directory Statistics Dashboard**
  - Total videos count
  - Total size (in GB/MB)
  - Available vs unavailable videos count
  - Last scan timestamp
  - Visual charts (optional)

- [ ] **Scan Status/Progress Indicator**
  - Show "Scanning..." badge during active scans
  - Progress bar (if backend supports progress)
  - Real-time updates (optional: polling or WebSocket)

- [ ] **Auto-Scan Settings Toggle**
  - Checkbox for auto-scan enabled
  - Input for scan interval (minutes)
  - Save settings via PATCH endpoint

### API Endpoints Used

- `POST /api/directories` (register)
- `GET /api/directories` (list)
- `GET /api/directories/:id` (details)
- `PATCH /api/directories/:id` (update settings)
- `DELETE /api/directories/:id` (remove)
- `POST /api/directories/:id/scan` (manual scan)
- `GET /api/directories/:id/stats` (statistics)

---

## Phase 4: Organization Features

**Goal**: Tag, creator, and metadata management.

### Features to Implement

- [ ] **Tag Tree Visualization**
  - Hierarchical tree component (expandable/collapsible)
  - Show parent-child relationships with indentation
  - Click tag to filter videos
  - Visual indicator for nested levels

- [ ] **Tag Creation with Parent Selection**
  - Modal with form: name, description, parent dropdown
  - Parent dropdown shows existing tags in tree format
  - Option to create root tag (no parent)

- [ ] **Tag Assignment to Videos**
  - Multi-select tag picker on video detail page
  - Show currently assigned tags with remove button
  - Add tag dropdown/search
  - Save changes instantly

- [ ] **Creator Management (CRUD)**
  - Creator list page
  - Add creator modal (name, description)
  - Edit creator inline or modal
  - Delete creator with confirmation

- [ ] **Creator Assignment to Videos**
  - Multi-select creator picker on video detail page
  - Show assigned creators with avatars (optional)
  - Add/remove creators instantly

- [ ] **Custom Metadata Editor**
  - Key-value pair editor on video detail page
  - Add new key-value button
  - Edit existing values inline
  - Delete metadata key with confirmation
  - Validation: key (1-255 chars), value (max 10000 chars)

### API Endpoints Used

- `GET /api/tags?tree=true` (hierarchical tags)
- `POST /api/tags` (create tag)
- `PATCH /api/tags/:id` (update tag)
- `DELETE /api/tags/:id` (delete tag)
- `POST /api/videos/:id/tags` (assign tag)
- `DELETE /api/videos/:id/tags/:tag_id` (remove tag)
- `GET /api/creators` (list creators)
- `POST /api/creators` (create)
- `PATCH /api/creators/:id` (update)
- `DELETE /api/creators/:id` (delete)
- `POST /api/videos/:id/creators` (assign)
- `DELETE /api/videos/:id/creators/:creator_id` (remove)
- `GET /api/videos/:id/metadata` (list metadata)
- `POST /api/videos/:id/metadata` (set key-value)
- `DELETE /api/videos/:id/metadata/:key` (delete key)

---

## Phase 5: User Interactions

**Goal**: Ratings, favorites, and bookmarks.

### Features to Implement

- [ ] **Rating System (1-5 Stars)**
  - Star rating component on video detail page
  - Click to rate (1-5 stars)
  - Optional comment textarea
  - Submit rating button
  - Show "Your rating" if already rated

- [ ] **Average Rating Display**
  - Show average rating on video cards
  - Display total ratings count
  - Star visualization (filled/half/empty stars)
  - Rating distribution chart (optional)

- [ ] **Favorites Toggle Button**
  - Heart icon on video cards and detail page
  - Click to add/remove from favorites
  - Filled heart if favorited
  - Instant feedback (no page reload)

- [ ] **Favorites List Page**
  - Show all favorited videos
  - Same layout as video list
  - Sort by date added
  - Remove from favorites button

- [ ] **Bookmark Creation at Timestamp**
  - "Add Bookmark" button in video player
  - Modal with form: name, description, timestamp (pre-filled)
  - Save bookmark instantly
  - Show success message

- [ ] **Bookmark Timeline Visualization**
  - Timeline/timeline markers on video player seek bar
  - Show bookmark positions as dots/flags
  - Tooltip on hover showing bookmark name
  - Color-coded by type (optional)

- [ ] **Bookmark Jump Navigation**
  - List of bookmarks below video player
  - Click bookmark to jump to timestamp
  - Show bookmark name, description, timestamp
  - Edit/delete buttons per bookmark

### API Endpoints Used

- `POST /api/videos/:id/ratings` (rate video)
- `GET /api/videos/:id/ratings` (get ratings)
- `PATCH /api/ratings/:id` (update rating)
- `DELETE /api/ratings/:id` (delete rating)
- `POST /api/favorites` (add to favorites)
- `GET /api/favorites` (list favorites)
- `DELETE /api/favorites/:video_id` (remove)
- `GET /api/favorites/:video_id/check` (check status)
- `POST /api/videos/:id/bookmarks` (create)
- `GET /api/videos/:id/bookmarks` (list)
- `PATCH /api/bookmarks/:id` (update)
- `DELETE /api/bookmarks/:id` (delete)

---

## Phase 6: Playlists

**Goal**: Create, manage, and play playlists.

### Features to Implement

- [ ] **Playlist Creation Modal**
  - Form with name and description
  - Submit to create playlist
  - Redirect to playlist detail page

- [ ] **Playlist List View**
  - Grid/list of user's playlists
  - Show playlist name, description, video count
  - Click to view playlist details
  - Edit/delete buttons

- [ ] **Add Videos to Playlist**
  - "Add to Playlist" button on video cards
  - Dropdown showing user's playlists
  - Select playlist to add video
  - Show success message

- [ ] **Remove Videos from Playlist**
  - Remove button on playlist detail page
  - Confirmation dialog
  - Update playlist view instantly

- [ ] **Drag-and-Drop Reordering**
  - Drag handles on playlist videos
  - Visual feedback during drag
  - Save new order via PATCH endpoint
  - Show "Reordering..." loading state

- [ ] **Playlist Player (Auto-Advance)**
  - Play playlist from first video
  - Auto-advance to next video on end
  - Skip to next/previous buttons
  - Show current video position (e.g., "3/10")

### API Endpoints Used

- `POST /api/playlists` (create)
- `GET /api/playlists` (list)
- `GET /api/playlists/:id` (details)
- `PATCH /api/playlists/:id` (update)
- `DELETE /api/playlists/:id` (delete)
- `GET /api/playlists/:id/videos` (get videos)
- `POST /api/playlists/:id/videos` (add video)
- `DELETE /api/playlists/:id/videos/:video_id` (remove)
- `PATCH /api/playlists/:id/videos/reorder` (reorder)

---

## Phase 7: Advanced Features

**Goal**: Thumbnails and database backups.

### Features to Implement

- [ ] **Thumbnail Generation UI**
  - "Generate Thumbnail" button on video detail page
  - Modal to select timestamp (slider or input)
  - Preview current frame (optional)
  - Submit to generate thumbnail

- [ ] **Thumbnail Carousel/Preview**
  - Show thumbnails on video hover (optional)
  - Timeline thumbnails on seek bar hover
  - Thumbnail grid on video detail page
  - Delete thumbnail button

- [ ] **Database Backup Creation**
  - "Create Backup" button on settings/admin page
  - Show success message with filename
  - Display backup in list immediately

- [ ] **Backup Restore Confirmation Flow**
  - "Restore" button per backup
  - Confirmation modal with warning
  - Password re-entry for security (optional)
  - Show "Restoring..." loading state

- [ ] **Export Database as JSON**
  - "Export" button on admin page
  - Trigger file download
  - Show export date in filename

- [ ] **Backup Management Page**
  - Table of all backups
  - Columns: filename, date, size
  - Actions: restore, delete, download
  - Sort by date (newest first)

### API Endpoints Used

- `POST /api/videos/:id/thumbnails` (generate)
- `GET /api/videos/:id/thumbnails` (list)
- `GET /api/thumbnails/:id/image` (serve image)
- `DELETE /api/thumbnails/:id` (delete)
- `POST /api/backup` (create backup)
- `GET /api/backup` (list backups)
- `GET /api/backup/export` (export as JSON)
- `POST /api/backup/:filename/restore` (restore)
- `DELETE /api/backup/:filename` (delete)

---

## UI/UX Considerations

### Video Player

- **Seek Bar**: Visual progress indicator with hover preview
- **Volume Control**: Slider with mute/unmute button
- **Fullscreen**: Toggle button with ESC key support
- **Playback Speed**: Dropdown with common speeds (0.5x, 1x, 1.5x, 2x)
- **Keyboard Shortcuts**:
  - Space: Play/pause
  - Arrow Left/Right: Seek backward/forward 5 seconds
  - Arrow Up/Down: Volume up/down
  - F: Fullscreen
  - M: Mute/unmute

### Tag Tree

- **Expandable/Collapsible**: Click to expand/collapse branches
- **Indentation**: Visual hierarchy with padding or lines
- **Icons**: Folder icons for parent tags, tag icons for leaves
- **Search**: Filter tags by name (optional)
- **Breadcrumbs**: Show path when viewing nested tag

### Playlists

- **Visual Order**: Show numbers or drag handles for position
- **Current Video**: Highlight currently playing video
- **Auto-Play Toggle**: Option to disable auto-advance
- **Shuffle/Repeat**: Additional playback modes (optional)

### Bookmarks

- **Timeline Markers**: Visual dots on seek bar
- **Thumbnail Preview**: Show thumbnail at bookmark position (optional)
- **Color Coding**: Different colors for different bookmark types
- **Quick Add**: One-click bookmark at current timestamp

### Ratings

- **Star Visualization**: Filled stars for whole numbers, half-star for .5
- **Interactive**: Hover to preview rating before clicking
- **Average Display**: "4.5 ★ (10 ratings)"
- **Review List**: Show all ratings with comments (optional)

### Pagination

- **Page Info**: "Showing 1-20 of 150"
- **Page Size Selector**: Dropdown for 10, 20, 50, 100 items
- **Jump to Page**: Input to jump directly to page number
- **Previous/Next**: Buttons with disabled state at boundaries

### Loading States

- **Skeleton Screens**: Show placeholders while loading lists
- **Spinners**: Use for individual actions (scan, bookmark, etc.)
- **Progress Bars**: For long operations (backup, restore)
- **Disable Buttons**: Prevent duplicate requests during loading

### Error Handling

- **Toast Notifications**: Pop-up messages for errors/success
- **Inline Errors**: Show validation errors below inputs
- **Error Boundaries**: Catch React errors gracefully
- **Retry Button**: Allow retry for failed requests

### Responsive Design

- **Mobile Video Player**: Touch-friendly controls
- **Responsive Grid**: Adjust columns based on screen size
- **Mobile Navigation**: Hamburger menu for small screens
- **Touch Gestures**: Swipe for next/previous in playlists

---

## Edge Cases to Handle

### Authentication

- **Session Expiration**: Redirect to login with message
- **Already Logged In**: Redirect from login to videos page
- **User Already Exists**: Show clear error on registration
- **Concurrent Sessions**: Handle logout in one tab affecting others

### Video Playback

- **Video File Not Found**: Show error, offer verify button
- **Unsupported Format**: Display format error message
- **Slow Network**: Show buffering indicator
- **Large Files**: Use range requests for efficient streaming

### Directory Scanning

- **Directory Not Found**: Show error, prevent registration
- **Scan in Progress**: Disable "Scan Now" button
- **Empty Directory**: Show "No videos found" message
- **Permission Denied**: Display permission error

### Tags and Creators

- **Duplicate Tag Name**: Prevent creation, show error
- **Delete Parent Tag**: Warn about cascading delete
- **Tag with No Videos**: Show "0 videos" instead of empty state
- **Circular Parent Reference**: Validate on backend, show error

### Playlists

- **Empty Playlist**: Show "Add videos to get started" message
- **Video Already in Playlist**: Prevent duplicate, show message
- **Reorder Failed**: Revert UI changes, show error
- **Deleted Video in Playlist**: Mark as unavailable, allow removal

### Favorites and Bookmarks

- **Already Favorited**: Toggle removes from favorites
- **Bookmark at Invalid Timestamp**: Validate against video duration
- **Duplicate Bookmark**: Allow multiple bookmarks at same timestamp
- **Delete Video with Bookmarks**: Cascade delete bookmarks

### Backup and Restore

- **Restore Overwrites Data**: Show strong warning
- **Large Backup File**: Show progress indicator
- **Backup Failed**: Show error, suggest retry
- **Export Download Failed**: Trigger manual download retry

---

## Technical Notes

### HTTP Client Configuration

**Fetch API**:
```javascript
const response = await fetch('http://localhost:3000/api/videos', {
  credentials: 'include' // Always include session cookie
});
```

**Axios**:
```javascript
axios.defaults.withCredentials = true;
axios.defaults.baseURL = 'http://localhost:3000/api';
```

### Session Cookie Handling

- **Cookie Name**: `session_id`
- **Cookie Type**: httpOnly (not accessible via JavaScript)
- **Expiration**: 7 days (168 hours) by default
- **Auto-Renewal**: Not supported, user must re-login after expiration

### HTTP Range Requests for Video Streaming

The HTML5 video player automatically sends `Range` headers:

```html
<video src="http://localhost:3000/api/videos/1/stream" controls></video>
```

Server responds with `206 Partial Content` and `Content-Range` headers.

### Hierarchical Tags

Use `?tree=true` to get nested structure:

```javascript
const response = await fetch('/api/tags?tree=true', {
  credentials: 'include'
});

const { data } = await response.json();
// data is an array of tags with recursive 'children' arrays
```

### Playlist Ordering

Videos in playlists have a `position` field (0-indexed):

```javascript
// Reorder example
const videos = [
  { video_id: 2, position: 0 },
  { video_id: 1, position: 1 },
  { video_id: 3, position: 2 }
];

await axios.patch(`/api/playlists/${playlistId}/videos/reorder`, { videos });
```

### Video Availability

Videos can be soft-deleted (file missing):

```javascript
if (video.is_available === 0) {
  // Show "File not found" message
  // Disable playback
  // Offer verify button
}
```

### File Size Formatting

Convert bytes to human-readable format:

```javascript
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
};
```

### Duration Formatting

Convert seconds to HH:MM:SS:

```javascript
const formatDuration = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
};
```

### Error Response Handling

All errors follow consistent format:

```javascript
try {
  const response = await fetch(url, options);
  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error.message);
  }

  return data.data;
} catch (error) {
  console.error('API Error:', error.message);
  // Show toast or inline error
}
```

### State Management Suggestions

- **Global State**: User session, current video, theme
- **Local State**: Form inputs, UI toggles, temporary data
- **Server State**: Videos, playlists, tags, creators (use React Query or SWR)
- **URL State**: Current page, filters, sort order (use query params)

### Performance Optimization

- **Lazy Load Images**: Use `loading="lazy"` for thumbnails
- **Virtual Scrolling**: For long video lists (1000+ items)
- **Debounce Search**: Wait 300ms after user stops typing
- **Cache API Responses**: Use React Query or SWR for automatic caching
- **Optimize Thumbnails**: Request smaller sizes if available

---

## Recommended Tech Stack

### Core Framework

- **React** (v18+) or **Vue** (v3+) or **Svelte**
- TypeScript (optional but recommended)

### Routing

- React Router (React)
- Vue Router (Vue)
- SvelteKit (Svelte)

### State Management

- React Query or SWR for server state
- Context API or Zustand for global state
- React Hook Form for form management

### UI Component Library

- Material-UI (MUI)
- Chakra UI
- shadcn/ui
- Ant Design

### Video Player

- Video.js
- Plyr
- React Player
- Native HTML5 video element

### Drag and Drop

- react-beautiful-dnd
- @dnd-kit/core
- Sortable.js

### HTTP Client

- Axios
- Native Fetch API

### Styling

- Tailwind CSS
- CSS Modules
- Styled Components
- Emotion

---

## Testing Checklist

- [ ] Authentication flow (login, logout, session expiration)
- [ ] Video playback with range requests
- [ ] Pagination and filtering
- [ ] Tag tree expansion/collapse
- [ ] Playlist drag-and-drop reordering
- [ ] Bookmark creation and navigation
- [ ] Rating submission and average calculation
- [ ] Favorites add/remove toggle
- [ ] Directory scan trigger
- [ ] Backup creation and restore
- [ ] Error handling for all API calls
- [ ] Responsive design on mobile/tablet
- [ ] Keyboard shortcuts in video player
- [ ] File availability verification

---

## Getting Started

1. **Read API-OVERVIEW.md** for authentication patterns
2. **Read API-ENDPOINTS.md** for complete endpoint reference
3. **Start with Phase 1** (authentication and setup)
4. **Test endpoints** using Swagger UI at `/docs`
5. **Build incrementally**, testing each feature before moving on

## Support Resources

- **API Documentation**: `http://localhost:3000/docs` (Swagger UI)
- **Health Check**: `http://localhost:3000/health`
- **Base URL**: `http://localhost:3000/api`
- **CLAUDE.md**: Backend project context and architecture

---

**Happy coding!** Feel free to ask questions or request clarifications as you implement these features.
