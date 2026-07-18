# MetaStrip

A cloud metadata inspector and cleaner for images, video, audio, PDFs, and Microsoft Office files.

## Features

- Inspect metadata without producing a cleaned file
- Remove EXIF, GPS, XMP, IPTC, media-container, PDF, and Office properties
- Privacy scores with risk categories
- Batch processing for up to eight files
- ZIP downloads with a JSON removal report
- Output verification after cleaning
- Optional ICC colour-profile preservation
- Automatic deletion and one-time download links
- No database or permanent file storage

## Local setup

```bash
npm install --package-lock=false --registry=https://registry.npmjs.org
npm test
npm start
```

Open `http://localhost:3000`.

## Render settings

- Runtime: Node
- Build command: `npm install --omit=dev --package-lock=false --registry=https://registry.npmjs.org`
- Start command: `npm start`
- Health check path: `/api/health`

The health route is defined before rate limiting in version 2, so it is safe for Render health checks.

## Environment variables

```text
NODE_ENV=production
MAX_FILE_MB=40
MAX_FILES=8
MAX_TOTAL_MB=40
FILE_TTL_MINUTES=10
```

Render provides `PORT` automatically.

## Important limitation

MetaStrip removes metadata that its supported parsers detect. It does not remove visible text, faces, watermarks, audio content, hidden steganography, or unsupported proprietary metadata blocks.
