# MetaStrip

MetaStrip is a privacy-focused Node.js website that removes standard optional metadata from common files.

Supported formats:

- Images: JPG, PNG, WebP, AVIF, TIFF
- Video: MP4, MOV, MKV, WebM, AVI
- Audio: MP3, M4A, WAV, FLAC, OGG
- Documents: PDF, DOCX, XLSX, PPTX

## What it removes

- Image EXIF, GPS, camera, device, creator, software, and timestamp metadata
- Video and audio container metadata without re-encoding streams
- PDF document information and catalog XMP metadata
- Office core, extended, custom, thumbnail, and common comment-author metadata

## Privacy controls

- Files use random temporary names
- One file is processed at a time to stay within low-memory hosting limits
- The original upload is deleted immediately after processing
- The cleaned copy expires after 10 minutes by default
- Optional deletion happens after the first successful download
- Every restart clears all temporary files
- Upload folders are never exposed as static directories

## Run locally

Requires Node.js 20.19 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Environment variables

- `PORT`: web server port, default `3000`
- `MAX_FILE_MB`: upload size limit, default `40`, maximum `100`
- `FILE_TTL_MINUTES`: cleaned-file lifetime, default `10`, maximum `60`
- `NODE_ENV`: set to `production` when deployed

## Test

```bash
npm test
```

The smoke test creates sample image, video, PDF, and DOCX files with metadata, cleans them, verifies the results, and tests the HTTP upload and one-time download flow.

## Important limits

MetaStrip removes standard optional metadata. It does not inspect visible content, OCR text, faces, watermarks, steganography, document body text, embedded attachments, or data held by the service where a file is later uploaded.
