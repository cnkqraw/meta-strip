'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const archiver = require('archiver');
const { rateLimit } = require('express-rate-limit');
const {
  cleanFile,
  detectFile,
  inspectMetadata,
  summarizeMetadata,
  compareMetadata,
} = require('./lib/cleaners');

const app = express();
const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_MB = clamp(Number(process.env.MAX_FILE_MB || 40), 1, 100);
const MAX_FILES = clamp(Number(process.env.MAX_FILES || 8), 1, 20);
const MAX_TOTAL_MB = clamp(Number(process.env.MAX_TOTAL_MB || 40), MAX_FILE_MB, 200);
const FILE_TTL_MINUTES = clamp(Number(process.env.FILE_TTL_MINUTES || 10), 1, 60);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_TOTAL_BYTES = MAX_TOTAL_MB * 1024 * 1024;
const FILE_TTL_MS = FILE_TTL_MINUTES * 60 * 1000;
const ROOT_DIR = __dirname;
const UPLOAD_DIR = path.join(ROOT_DIR, 'temp', 'uploads');
const OUTPUT_DIR = path.join(ROOT_DIR, 'temp', 'outputs');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const downloads = new Map();
let processing = false;

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      mediaSrc: ["'self'", 'blob:'],
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

// Keep health checks outside rate limiting. Render calls this route frequently.
app.get('/api/health', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({ status: 'ok', processing, downloads: downloads.size });
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
}));

const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 80,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Try again in a few minutes.' },
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Try again in a few minutes.' },
});
app.use('/api', apiLimiter);

app.get('/api/config', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({
    maxFileMb: MAX_FILE_MB,
    maxFiles: MAX_FILES,
    maxTotalMb: MAX_TOTAL_MB,
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

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_request, _file, callback) => callback(null, `${crypto.randomUUID()}.upload`),
});
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
    fields: 8,
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

function outputName(originalName, extension) {
  return `cleaned-${sanitizeBaseName(originalName)}.${extension}`;
}

function uniqueOutputName(originalName, extension, usedNames) {
  const base = outputName(originalName, extension);
  if (!usedNames.has(base.toLowerCase())) {
    usedNames.add(base.toLowerCase());
    return base;
  }

  const stem = path.basename(base, path.extname(base));
  let index = 2;
  while (usedNames.has(`${stem}-${index}.${extension}`.toLowerCase())) index += 1;
  const unique = `${stem}-${index}.${extension}`;
  usedNames.add(unique.toLowerCase());
  return unique;
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
  const message = String(error?.message || '');
  const known = [
    'not supported',
    'does not match',
    'could not be verified',
    'invalid or damaged',
    'Encrypted PDFs',
    'FFmpeg is unavailable',
    'too large',
    'too many',
    'safe processing limit',
    'Choose at least one file',
    'total upload limit',
  ];
  if (known.some((phrase) => message.toLowerCase().includes(phrase.toLowerCase()))) return message;
  console.error(error);
  return 'The file could not be processed. It might be damaged or use an unsupported codec.';
}

function statusForError(error) {
  if (error?.code === 'LIMIT_FILE_SIZE' || error?.code === 'LIMIT_FILE_COUNT') return 413;
  if (/too large|too many|total upload limit/i.test(error?.message || '')) return 413;
  if (/Choose at least one file/i.test(error?.message || '')) return 400;
  return 422;
}

function acquireProcessing(response) {
  if (processing) {
    response.status(429).json({ error: 'Another request is being processed. Try again in a moment.' });
    return false;
  }
  processing = true;
  return true;
}

function validateUploadedFiles(files) {
  if (!files?.length) throw new Error('Choose at least one file first.');
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`The total upload is too large. The combined limit is ${MAX_TOTAL_MB} MB.`);
  }
  return totalBytes;
}

function aggregateSummary(fileResults, mode) {
  const metadataKey = mode === 'clean' ? 'beforeMetadata' : 'metadata';
  const scores = fileResults.map((item) => item.beforeAnalysis?.privacyScore ?? item.analysis?.privacyScore ?? 100);
  const afterScores = fileResults.map((item) => item.afterAnalysis?.privacyScore ?? 100);
  const totalFields = fileResults.reduce((total, item) => total + (item[metadataKey]?.length || 0), 0);
  const removedFields = fileResults.reduce((total, item) => total + (item.removedMetadata?.length || 0), 0);
  const remainingFields = fileResults.reduce((total, item) => total + (item.afterMetadata?.length || 0), 0);
  return {
    files: fileResults.length,
    totalFields,
    removedFields,
    remainingFields,
    beforeScore: scores.length ? Math.min(...scores) : 100,
    afterScore: afterScores.length ? Math.min(...afterScores) : null,
  };
}

async function createZipArchive(items, zipPath, report) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', (error) => {
      if (error.code === 'ENOENT') return;
      reject(error);
    });
    archive.on('error', reject);
    archive.pipe(output);
    for (const item of items) archive.file(item.outputPath, { name: item.filename });
    archive.append(`${JSON.stringify(report, null, 2)}\n`, { name: 'metastrip-report.json' });
    archive.finalize();
  });
}

async function inspectUploadedFiles(files) {
  const results = [];
  for (const file of files) {
    const detected = await detectFile(file.path, file.originalname);
    const metadata = await inspectMetadata(file.path, detected.category);
    results.push({
      filename: file.originalname,
      category: detected.category,
      extension: detected.extension,
      sourceBytes: file.size,
      metadata,
      analysis: summarizeMetadata(metadata),
    });
  }
  return results;
}

async function cleanUploadedFiles(files, options) {
  const startedAt = Date.now();
  const usedNames = new Set();
  const results = [];

  for (const file of files) {
    const detected = await detectFile(file.path, file.originalname);
    const beforeMetadata = await inspectMetadata(file.path, detected.category);
    const generatedName = uniqueOutputName(file.originalname, detected.extension, usedNames);
    const outputPath = path.join(OUTPUT_DIR, `${crypto.randomUUID()}.${detected.extension}`);

    try {
      await cleanFile({
        inputPath: file.path,
        outputPath,
        category: detected.category,
        extension: detected.extension,
        options,
      });

      const outputStats = await fsp.stat(outputPath);
      if (outputStats.size === 0) throw new Error('The cleaned output is empty.');
      const afterMetadata = await inspectMetadata(outputPath, detected.category);

      results.push({
        filename: generatedName,
        originalFilename: file.originalname,
        category: detected.category,
        extension: detected.extension,
        mime: detected.mime,
        sourceBytes: file.size,
        outputBytes: outputStats.size,
        beforeMetadata,
        afterMetadata,
        removedMetadata: compareMetadata(beforeMetadata, afterMetadata),
        beforeAnalysis: summarizeMetadata(beforeMetadata),
        afterAnalysis: summarizeMetadata(afterMetadata),
        outputPath,
      });
    } catch (error) {
      await safeUnlink(outputPath);
      throw error;
    }
  }

  return { results, elapsedMs: Date.now() - startedAt };
}

function publicCleanResult(item) {
  return {
    filename: item.filename,
    originalFilename: item.originalFilename,
    category: item.category,
    sourceBytes: item.sourceBytes,
    outputBytes: item.outputBytes,
    beforeMetadata: item.beforeMetadata,
    afterMetadata: item.afterMetadata,
    removedMetadata: item.removedMetadata,
    beforeAnalysis: item.beforeAnalysis,
    afterAnalysis: item.afterAnalysis,
  };
}

app.post('/api/inspect', uploadLimiter, (request, response) => {
  if (!acquireProcessing(response)) return;

  upload.array('files', MAX_FILES)(request, response, async (uploadError) => {
    const uploadedPaths = [];
    try {
      if (uploadError) throw uploadError;
      const files = request.files || [];
      uploadedPaths.push(...files.map((file) => file.path));
      validateUploadedFiles(files);

      const startedAt = Date.now();
      const results = await inspectUploadedFiles(files);
      response.json({
        mode: 'inspect',
        files: results,
        summary: aggregateSummary(results, 'inspect'),
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      response.status(statusForError(error)).json({ error: cleanErrorMessage(error) });
    } finally {
      processing = false;
      await Promise.all(uploadedPaths.map(safeUnlink));
    }
  });
});

app.post('/api/clean', uploadLimiter, (request, response) => {
  if (!acquireProcessing(response)) return;

  upload.array('files', MAX_FILES)(request, response, async (uploadError) => {
    const uploadedPaths = [];
    const generatedPaths = [];
    try {
      if (uploadError) throw uploadError;
      const files = request.files || [];
      uploadedPaths.push(...files.map((file) => file.path));
      const totalSourceBytes = validateUploadedFiles(files);
      const preserveIcc = request.body.preserveIcc !== 'false';
      const deleteAfterDownload = request.body.deleteAfterDownload !== 'false';
      const { results, elapsedMs } = await cleanUploadedFiles(files, { preserveIcc });
      generatedPaths.push(...results.map((item) => item.outputPath));

      const expiresAt = Date.now() + FILE_TTL_MS;
      const publicFiles = results.map(publicCleanResult);
      const summary = aggregateSummary(publicFiles, 'clean');
      const totalOutputBytes = results.reduce((total, item) => total + item.outputBytes, 0);
      let downloadPath;
      let downloadName;
      let downloadMime;
      let batch = false;

      if (results.length === 1) {
        downloadPath = results[0].outputPath;
        downloadName = results[0].filename;
        downloadMime = results[0].mime;
        generatedPaths.splice(generatedPaths.indexOf(downloadPath), 1);
      } else {
        batch = true;
        downloadPath = path.join(OUTPUT_DIR, `${crypto.randomUUID()}.zip`);
        downloadName = `metastrip-cleaned-${results.length}-files.zip`;
        downloadMime = 'application/zip';
        const report = {
          generatedAt: new Date().toISOString(),
          service: 'MetaStrip',
          summary,
          files: publicFiles,
        };
        await createZipArchive(results, downloadPath, report);
        await Promise.all(results.map((item) => safeUnlink(item.outputPath)));
        generatedPaths.length = 0;
      }

      const token = registerDownload({
        path: downloadPath,
        filename: downloadName,
        mime: downloadMime,
        expiresAt,
        deleteAfterDownload,
      });

      response.json({
        mode: 'clean',
        batch,
        filename: downloadName,
        downloadUrl: `/api/download/${token}`,
        deleteUrl: `/api/files/${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
        deleteAfterDownload,
        preserveIcc,
        files: publicFiles,
        summary,
        totalSourceBytes,
        totalOutputBytes,
        elapsedMs,
      });
    } catch (error) {
      response.status(statusForError(error)).json({ error: cleanErrorMessage(error) });
    } finally {
      processing = false;
      await Promise.all([
        ...uploadedPaths.map(safeUnlink),
        ...generatedPaths.map(safeUnlink),
      ]);
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
    if (!error && item.deleteAfterDownload) await deleteDownload(request.params.token);
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
    console.log(`Limits: ${MAX_FILES} files | ${MAX_FILE_MB} MB each | ${MAX_TOTAL_MB} MB total | ${FILE_TTL_MINUTES} minute lifetime`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received. Cleaning temporary files.`);
    server.close(async () => {
      await Promise.all([purgeDirectory(UPLOAD_DIR), purgeDirectory(OUTPUT_DIR)]);
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
