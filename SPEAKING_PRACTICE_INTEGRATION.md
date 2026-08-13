# Speaking Practice Integration Reference

The speaking practice feature has already been integrated into the app. The standalone files below are retained as references from the original Copilot draft:

- `speaking-practice-init.sql`
- `speaking-practice-api.js`
- `speaking-practice-ui.html`

The active implementation is in:

- `server.js`
- `public/parent.html`
- `public/admin.html`

## Runtime Requirements

- `DATABASE_URL`
- `CLOUDINARY_URL` for hosted recordings and Groq analysis
- `GROQ_API_KEY`
- `GROQ_VISION_MODEL` optional, defaults in `server.js`

Without Cloudinary/Groq, the app still stores a temporary local recording and returns fallback feedback, but real AI video analysis requires a hosted recording URL.

## Verification Commands

```bash
node --check server.js
node -e "const fs=require('fs'); for (const file of ['public/admin.html','public/parent.html']) { const html=fs.readFileSync(file,'utf8'); let i=0; for (const m of html.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)) { i++; new Function(m[1]); } console.log(file + ': parsed ' + i + ' inline scripts'); }"
```

## Manual QA Checklist

- Open parent portal and click Speaking Lab.
- Confirm a daily topic loads.
- Record, stop, replay, and submit a recording.
- Confirm feedback appears and reflection saves.
- Confirm history updates after completion.
- Open admin Learning Lab.
- Add, approve/unapprove, activate/deactivate a speaking topic.
- Confirm the production database contains the four speaking tables after startup.
