# Speaking Practice Status

Date reviewed: August 13, 2026

## Current State

Speaking Practice Phase 2 is integrated into the LMS:

- `server.js` includes Migration 58 for speaking topics, topic usage, attempts, and feedback.
- `server.js` includes the student speaking APIs and admin topic-management APIs.
- `public/parent.html` includes the Learning Lab and Speaking Lab tabs with recording, playback, upload, analysis, reflection, and history UI.
- `public/admin.html` includes a Learning Lab tab with module rollout status and speaking topic management.

## Fixes Applied After Copilot

- Removed the server-side `currentStudent` reference that would crash the topic endpoint.
- Added dedicated temporary upload storage for speaking recordings instead of reusing the general material/homework upload middleware.
- Added local-storage fallback behavior when Cloudinary is not configured.
- Added temporary cleanup for both Cloudinary and local recordings.
- Prevented duplicate seed topics on repeated migrations.
- Normalized AI feedback keys before saving them to the database.
- Added existing parent portal headers to speaking API requests.
- Fixed the recording indicator showing before recording starts.
- Added admin UI for listing, adding, approving, and activating/deactivating speaking topics.

## Verified

- `node --check server.js`
- Inline script parsing for `public/admin.html`
- Inline script parsing for `public/parent.html`

## Not Fully Verified Locally

End-to-end recording, Cloudinary upload, Groq analysis, and live database migration still need a browser/server run with valid environment variables.
