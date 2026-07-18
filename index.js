'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const {
  cleanFile,
  detectFile,
  inspectMetadata,
} = require('./lib/cleaners');

const app = express();
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = Math.min(Math.max(Number(process.env.MAX_FILE_MB || 40), 1), 100);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const FILE_TTL_MINUTES = Math.min(Math.max(Number(process.env.FILE_TTL_MINUTES || 10), 1), 60);
const FILE_TTL_MS = FILE_TTL_MINUTES * 60 * 1000;
const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, 'temp', 'uploads');
const OUTPUT_DIR = path.join(ROOT_DIR, 'temp', 'outputs');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const downloads = new Map();
let processing = false;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
}));

const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again later.' },
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again later.' },
});
app.use('/api', apiLimiter);

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
});
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: 1,
    fields: 4,
  },
});

function sanitizeBaseName(filename) {
  const extension = path.extname(filename || 'file');
  const base = path.basename(filename || 'file', extension)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 _.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80);
  return base || 'file';
}

function formatOutputName(originalName, extension) {
  return `cleaned-${sanitizeBaseName(originalName)}.${extension}`;
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Failed to delete temporary file:', error.message);
  }
}

async function purgeDirectory(directory) {
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
    .map((entry) => safeUnlink(path.join(directory, entry.name))));
}

async function deleteDownload(token) {
  const item = downloads.get(token);
  if (!item) return;
  downloads.delete(token);
  await safeUnlink(item.path);
}

function registerDownload(item) {
  const token = crypto.randomBytes(24).toString('base64url');
  downloads.set(token, item);
  return token;
}

function cleanErrorMessage(error) {
  const known = [
    'not supported',
    'does not match',
    'could not be verified',
    'invalid or damaged',
    'encrypted PDFs',
    'FFmpeg is unavailable',
    'too large',
  ];
  if (known.some((phrase) => error.message.includes(phrase))) return error.message;
  if (process.env.NODE_ENV !== 'production') console.error(error);
  return 'The file could not be cleaned. It might be damaged or use an unsupported codec.';
}

app.get('/api/config', (_request, response) => {
  response.json({
    maxFileMb: MAX_FILE_MB,
    fileTtlMinutes: FILE_TTL_MINUTES,
    busy: processing,
    supported: {
      images: ['JPG', 'PNG', 'WebP', 'AVIF', 'TIFF'],
      video: ['MP4', 'MOV', 'MKV', 'WebM', 'AVI'],
      audio: ['MP3', 'M4A', 'WAV', 'FLAC', 'OGG'],
      documents: ['PDF', 'DOCX', 'XLSX', 'PPTX'],
    },
  });
});

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', processing, downloads: downloads.size });
});

app.post('/api/clean', uploadLimiter, (request, response) => {
  if (processing) {
    response.status(429).json({ error: 'Another file is being processed. Try again in a moment.' });
    return;
  }
  processing = true;

  upload.single('file')(request, response, async (uploadError) => {
    let inputPath;
    let outputPath;
    try {
      if (uploadError) {
        if (uploadError.code === 'LIMIT_FILE_SIZE') {
          throw new Error(`The file is too large. The limit is ${MAX_FILE_MB} MB.`);
        }
        throw uploadError;
      }
      if (!request.file) throw new Error('Choose a file first.');

      inputPath = request.file.path;
      const detected = await detectFile(inputPath, request.file.originalname);
      const metadata = await inspectMetadata(inputPath, detected.category);
      const outputToken = crypto.randomUUID();
      outputPath = path.join(OUTPUT_DIR, `${outputToken}.${detected.extension}`);

      await cleanFile({
        inputPath,
        outputPath,
        category: detected.category,
        extension: detected.extension,
      });

      const sourceStats = await fsp.stat(inputPath);
      const outputStats = await fsp.stat(outputPath);
      if (outputStats.size === 0) throw new Error('The cleaned output is empty.');

      const deleteAfterDownload = request.body.deleteAfterDownload !== 'false';
      const expiresAt = Date.now() + FILE_TTL_MS;
      const downloadToken = registerDownload({
        path: outputPath,
        filename: formatOutputName(request.file.originalname, detected.extension),
        mime: detected.mime,
        expiresAt,
        deleteAfterDownload,
      });
      outputPath = null;

      response.json({
        token: downloadToken,
        downloadUrl: `/api/download/${downloadToken}`,
        deleteUrl: `/api/files/${downloadToken}`,
        filename: formatOutputName(request.file.originalname, detected.extension),
        category: detected.category,
        sourceBytes: sourceStats.size,
        outputBytes: outputStats.size,
        expiresAt: new Date(expiresAt).toISOString(),
        deleteAfterDownload,
        metadata,
        message: metadata.length
          ? `${metadata.length} metadata field${metadata.length === 1 ? '' : 's'} found and cleared.`
          : 'No readable personal metadata was found. The file was rebuilt without optional metadata.',
      });
    } catch (error) {
      response.status(error.message === 'Choose a file first.' ? 400 : 422).json({
        error: cleanErrorMessage(error),
      });
    } finally {
      processing = false;
      await Promise.all([safeUnlink(inputPath), safeUnlink(outputPath)]);
    }
  });
});

app.get('/api/download/:token', async (request, response) => {
  const item = downloads.get(request.params.token);
  if (!item || item.expiresAt <= Date.now()) {
    if (item) await deleteDownload(request.params.token);
    response.status(404).json({ error: 'This download expired or does not exist.' });
    return;
  }

  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Content-Type', item.mime);
  response.download(item.path, item.filename, async (error) => {
    if (error && !response.headersSent) {
      response.status(500).json({ error: 'The file could not be downloaded.' });
    }
    if (!error && item.deleteAfterDownload) {
      await deleteDownload(request.params.token);
    }
  });
});

app.delete('/api/files/:token', async (request, response) => {
  if (!downloads.has(request.params.token)) {
    response.status(404).json({ error: 'This file is already deleted or expired.' });
    return;
  }
  await deleteDownload(request.params.token);
  response.status(204).end();
});

app.use('/api', (_request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'Unexpected server error.' });
});

async function cleanupExpired() {
  const now = Date.now();
  const expired = [...downloads.entries()]
    .filter(([, item]) => item.expiresAt <= now)
    .map(([token]) => deleteDownload(token));
  await Promise.all(expired);
}

async function start() {
  await purgeDirectory(UPLOAD_DIR);
  await purgeDirectory(OUTPUT_DIR);
  setInterval(cleanupExpired, 60_000).unref();

  const server = app.listen(PORT, HOST, () => {
    console.log(`MetaStrip is running on http://${HOST}:${PORT}`);
    console.log(`Upload limit: ${MAX_FILE_MB} MB | File lifetime: ${FILE_TTL_MINUTES} minutes`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received. Cleaning temporary files.`);
    server.close(async () => {
      await Promise.all([
        purgeDirectory(UPLOAD_DIR),
        purgeDirectory(OUTPUT_DIR),
      ]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start MetaStrip:', error);
    process.exit(1);
  });
}

module.exports = { app, start };
