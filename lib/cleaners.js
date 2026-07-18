'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const exifr = require('exifr');
const ffmpegPath = process.env.FFMPEG_PATH || require('@ffmpeg-installer/ffmpeg').path;
const JSZip = require('jszip');
const {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
} = require('pdf-lib');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff']);
const MEDIA_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'mp3', 'm4a', 'wav', 'flac', 'ogg']);
const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const SUPPORTED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...MEDIA_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  'pdf',
]);

const OUTPUT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

let fileTypeModulePromise;
function getFileTypeModule() {
  fileTypeModulePromise ||= import('file-type');
  return fileTypeModulePromise;
}

function normalizeExtension(filename) {
  const extension = path.extname(filename || '').slice(1).toLowerCase();
  return extension === 'jpeg' ? 'jpg' : extension === 'tif' ? 'tiff' : extension;
}

function safeScalar(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 4).map(safeScalar).join(', ');
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 180);
  return String(value).slice(0, 180);
}

function addIfPresent(result, label, value) {
  const clean = safeScalar(value);
  if (clean && clean !== '0' && clean !== 'undefined') result.push({ label, value: clean });
}

function enforceOfficeLimits(zip) {
  const entries = Object.values(zip.files);
  if (entries.length > 5000) {
    throw new Error('The Office file contains too many internal files.');
  }

  const uncompressedBytes = entries.reduce((total, entry) => {
    const size = Number(entry?._data?.uncompressedSize || 0);
    return total + (Number.isFinite(size) ? size : 0);
  }, 0);

  if (uncompressedBytes > 120 * 1024 * 1024) {
    throw new Error('The Office file expands beyond the safe processing limit.');
  }
}

async function validateOfficeArchive(filePath, extension) {
  const data = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(data);
  enforceOfficeLimits(zip);
  const requiredEntry = {
    docx: 'word/document.xml',
    xlsx: 'xl/workbook.xml',
    pptx: 'ppt/presentation.xml',
  }[extension];

  if (!zip.file(requiredEntry)) {
    throw new Error('The uploaded Office file is invalid or damaged.');
  }
}

async function detectFile(filePath, originalName) {
  const originalExtension = normalizeExtension(originalName);
  if (!SUPPORTED_EXTENSIONS.has(originalExtension)) {
    throw new Error('This file type is not supported.');
  }

  const { fileTypeFromFile } = await getFileTypeModule();
  const detected = await fileTypeFromFile(filePath);

  if (OFFICE_EXTENSIONS.has(originalExtension)) {
    if (!detected || !['zip', originalExtension].includes(detected.ext)) {
      throw new Error('The uploaded Office file does not match its extension.');
    }
    await validateOfficeArchive(filePath, originalExtension);
    return {
      extension: originalExtension,
      category: 'office',
      mime: OUTPUT_MIME[originalExtension],
    };
  }

  const normalizedDetected = detected?.ext === 'jpeg'
    ? 'jpg'
    : detected?.ext === 'tif'
      ? 'tiff'
      : detected?.ext;

  const aliases = {
    m4v: 'mp4',
    oga: 'ogg',
  };
  const detectedExtension = aliases[normalizedDetected] || normalizedDetected;

  if (!detectedExtension) {
    throw new Error('The file format could not be verified.');
  }

  if (originalExtension === 'mov' && detectedExtension === 'mp4') {
    return { extension: 'mov', category: 'media', mime: OUTPUT_MIME.mov };
  }
  if (originalExtension === 'm4a' && detectedExtension === 'mp4') {
    return { extension: 'm4a', category: 'media', mime: OUTPUT_MIME.m4a };
  }
  if (originalExtension === 'jpeg' && detectedExtension === 'jpg') {
    return { extension: 'jpg', category: 'image', mime: OUTPUT_MIME.jpg };
  }

  if (detectedExtension !== originalExtension) {
    throw new Error(`The file content appears to be .${detectedExtension}, not .${originalExtension}.`);
  }

  if (IMAGE_EXTENSIONS.has(originalExtension)) {
    return { extension: originalExtension, category: 'image', mime: OUTPUT_MIME[originalExtension] };
  }
  if (MEDIA_EXTENSIONS.has(originalExtension)) {
    return { extension: originalExtension, category: 'media', mime: OUTPUT_MIME[originalExtension] };
  }
  if (originalExtension === 'pdf') {
    return { extension: 'pdf', category: 'pdf', mime: OUTPUT_MIME.pdf };
  }

  throw new Error('This file type is not supported.');
}

async function inspectImageMetadata(inputPath) {
  const found = [];
  try {
    const metadata = await exifr.parse(inputPath, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      icc: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
    });

    if (!metadata) return found;

    addIfPresent(found, 'Camera make', metadata.Make);
    addIfPresent(found, 'Camera model', metadata.Model);
    if (metadata.latitude != null && metadata.longitude != null) {
      addIfPresent(found, 'GPS location', `${metadata.latitude}, ${metadata.longitude}`);
    }
    addIfPresent(found, 'Captured', metadata.DateTimeOriginal || metadata.CreateDate);
    addIfPresent(found, 'Modified', metadata.ModifyDate);
    addIfPresent(found, 'Software', metadata.Software);
    addIfPresent(found, 'Artist', metadata.Artist || metadata.Creator);
    addIfPresent(found, 'Copyright', metadata.Copyright);
    addIfPresent(found, 'Description', metadata.ImageDescription || metadata.Description);
    addIfPresent(found, 'Device owner', metadata.OwnerName || metadata.CameraOwnerName);
    addIfPresent(found, 'Serial number', metadata.SerialNumber || metadata.BodySerialNumber);
    addIfPresent(found, 'Orientation', metadata.Orientation);
  } catch {
    return found;
  }
  return found.slice(0, 12);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 400_000) stderr = stderr.slice(-400_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || options.acceptCodes?.includes(code)) {
        resolve({ stdout, stderr, code });
        return;
      }
      const error = new Error(`Processing failed with exit code ${code}.`);
      error.details = stderr;
      reject(error);
    });
  });
}

function parseFfmpegMetadata(stderr) {
  const found = [];
  const lines = stderr.split(/\r?\n/);
  let inMetadata = false;

  for (const line of lines) {
    if (/^\s*Metadata:\s*$/.test(line)) {
      inMetadata = true;
      continue;
    }
    if (!inMetadata) continue;

    const match = line.match(/^\s{4,}([^:]+)\s*:\s*(.+?)\s*$/);
    if (!match) {
      if (/^\s*(Duration|Stream|Chapter|Input|Output|At least one output)/.test(line)) {
        inMetadata = false;
      }
      continue;
    }

    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    const ignored = new Set([
      'major_brand',
      'minor_version',
      'compatible_brands',
      'encoder',
      'vendor_id',
      'handler_name',
    ]);
    if (ignored.has(key)) continue;

    const label = key
      .replace(/[_-]+/g, ' ')
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
    addIfPresent(found, label, value);
  }

  const unique = [];
  const seen = new Set();
  for (const item of found) {
    const signature = `${item.label}:${item.value}`;
    if (!seen.has(signature)) {
      seen.add(signature);
      unique.push(item);
    }
  }
  return unique.slice(0, 12);
}

async function inspectMediaMetadata(inputPath) {
  if (!ffmpegPath) return [];
  try {
    const result = await runProcess(ffmpegPath, ['-hide_banner', '-i', inputPath], {
      acceptCodes: [1],
    });
    return parseFfmpegMetadata(result.stderr);
  } catch {
    return [];
  }
}

async function inspectPdfMetadata(inputPath) {
  const found = [];
  try {
    const bytes = await fs.readFile(inputPath);
    const pdf = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: false,
    });
    addIfPresent(found, 'Title', pdf.getTitle());
    addIfPresent(found, 'Author', pdf.getAuthor());
    addIfPresent(found, 'Subject', pdf.getSubject());
    addIfPresent(found, 'Keywords', pdf.getKeywords());
    addIfPresent(found, 'Creator', pdf.getCreator());
    addIfPresent(found, 'Producer', pdf.getProducer());
    addIfPresent(found, 'Created', pdf.getCreationDate());
    addIfPresent(found, 'Modified', pdf.getModificationDate());
  } catch (error) {
    if (/encrypted/i.test(error.message)) {
      throw new Error('Encrypted PDFs are not supported.');
    }
  }
  return found;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractXmlTag(xml, tag) {
  const escaped = tag.replace(':', '\\:');
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  if (!match) return null;
  return decodeXmlEntities(match[1].replace(/<[^>]+>/g, '').trim());
}

async function inspectOfficeMetadata(inputPath) {
  const found = [];
  const data = await fs.readFile(inputPath);
  const zip = await JSZip.loadAsync(data);
  const core = zip.file('docProps/core.xml');
  const app = zip.file('docProps/app.xml');

  if (core) {
    const xml = await core.async('string');
    addIfPresent(found, 'Creator', extractXmlTag(xml, 'dc:creator'));
    addIfPresent(found, 'Last modified by', extractXmlTag(xml, 'cp:lastModifiedBy'));
    addIfPresent(found, 'Title', extractXmlTag(xml, 'dc:title'));
    addIfPresent(found, 'Subject', extractXmlTag(xml, 'dc:subject'));
    addIfPresent(found, 'Description', extractXmlTag(xml, 'dc:description'));
    addIfPresent(found, 'Keywords', extractXmlTag(xml, 'cp:keywords'));
    addIfPresent(found, 'Created', extractXmlTag(xml, 'dcterms:created'));
    addIfPresent(found, 'Modified', extractXmlTag(xml, 'dcterms:modified'));
  }
  if (app) {
    const xml = await app.async('string');
    addIfPresent(found, 'Company', extractXmlTag(xml, 'Company'));
    addIfPresent(found, 'Manager', extractXmlTag(xml, 'Manager'));
    addIfPresent(found, 'Application', extractXmlTag(xml, 'Application'));
  }
  return found.slice(0, 12);
}

async function inspectMetadata(inputPath, category) {
  if (category === 'image') return inspectImageMetadata(inputPath);
  if (category === 'media') return inspectMediaMetadata(inputPath);
  if (category === 'pdf') return inspectPdfMetadata(inputPath);
  if (category === 'office') return inspectOfficeMetadata(inputPath);
  return [];
}

async function cleanImage(inputPath, outputPath, extension) {
  const pipeline = sharp(inputPath, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  }).autoOrient();

  switch (extension) {
    case 'jpg':
      await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(outputPath);
      break;
    case 'png':
      await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outputPath);
      break;
    case 'webp':
      await pipeline.webp({ quality: 95, effort: 4 }).toFile(outputPath);
      break;
    case 'avif':
      await pipeline.avif({ quality: 85, effort: 4 }).toFile(outputPath);
      break;
    case 'tiff':
      await pipeline.tiff({ quality: 95, compression: 'lzw' }).toFile(outputPath);
      break;
    default:
      throw new Error('Unsupported image format.');
  }
}

async function cleanMedia(inputPath, outputPath) {
  if (!ffmpegPath) {
    throw new Error('FFmpeg is unavailable on this server.');
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-map', '0',
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',
    '-map_metadata:s:a', '-1',
    '-map_metadata:s:s', '-1',
    '-map_chapters', '-1',
    '-c', 'copy',
    '-metadata', 'title=',
    '-metadata', 'artist=',
    '-metadata', 'author=',
    '-metadata', 'comment=',
    '-metadata', 'description=',
    '-metadata', 'copyright=',
    '-metadata', 'creation_time=',
    '-metadata:s:v', 'handler_name=',
    '-metadata:s:a', 'handler_name=',
    outputPath,
  ];
  await runProcess(ffmpegPath, args);
}

async function cleanPdf(inputPath, outputPath) {
  const bytes = await fs.readFile(inputPath);
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: false,
    });
  } catch (error) {
    if (/encrypted/i.test(error.message)) {
      throw new Error('Encrypted PDFs are not supported.');
    }
    throw new Error('The PDF is invalid or damaged.');
  }

  const metadataName = PDFName.of('Metadata');
  const metadataRefs = new Set();

  for (const [reference, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      const metadataReference = object.get(metadataName);
      if (metadataReference instanceof PDFRef) metadataRefs.add(metadataReference);
      object.delete(metadataName);
    }

    const streamDictionary = object?.dict;
    if (streamDictionary instanceof PDFDict) {
      const type = streamDictionary.get(PDFName.of('Type'));
      if (String(type) === '/Metadata') metadataRefs.add(reference);
    }
  }

  for (const reference of metadataRefs) pdf.context.delete(reference);
  pdf.catalog.delete(metadataName);

  const infoReference = pdf.context.trailerInfo.Info;
  if (infoReference) {
    pdf.context.delete(infoReference);
    delete pdf.context.trailerInfo.Info;
  }

  const output = await pdf.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
  await fs.writeFile(outputPath, output);
}

const MINIMAL_CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"></cp:coreProperties>`;
const MINIMAL_APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application></Application></Properties>`;
const MINIMAL_CUSTOM_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>`;

function anonymizeCommentMetadata(xml) {
  return xml
    .replace(/(<[^>]*\b(?:author|name|initials|email|userId|providerId)=")[^"]*(")/gi, '$1Anonymous$2')
    .replace(/(<(?:[^:>]+:)?author(?:\s[^>]*)?>)[\s\S]*?(<\/(?:[^:>]+:)?author>)/gi, '$1Anonymous$2');
}

async function cleanOffice(inputPath, outputPath) {
  const data = await fs.readFile(inputPath);
  let zip;
  try {
    zip = await JSZip.loadAsync(data);
    enforceOfficeLimits(zip);
  } catch (error) {
    if (/safe processing limit|too many internal files/.test(error.message)) throw error;
    throw new Error('The Office file is invalid or damaged.');
  }

  if (zip.file('docProps/core.xml')) zip.file('docProps/core.xml', MINIMAL_CORE_XML);
  if (zip.file('docProps/app.xml')) zip.file('docProps/app.xml', MINIMAL_APP_XML);
  if (zip.file('docProps/custom.xml')) zip.file('docProps/custom.xml', MINIMAL_CUSTOM_XML);
  zip.remove('docProps/thumbnail.jpeg');
  zip.remove('docProps/thumbnail.jpg');
  zip.remove('docProps/thumbnail.png');

  const metadataPatterns = [
    /^word\/comments.*\.xml$/i,
    /^word\/people\.xml$/i,
    /^xl\/comments.*\.xml$/i,
    /^xl\/persons\/.*\.xml$/i,
    /^ppt\/commentAuthors\.xml$/i,
    /^ppt\/comments\/.*\.xml$/i,
    /^ppt\/authors\/.*\.xml$/i,
  ];

  const entries = Object.keys(zip.files).filter((name) => metadataPatterns.some((pattern) => pattern.test(name)));
  for (const name of entries) {
    const entry = zip.file(name);
    if (!entry) continue;
    const xml = await entry.async('string');
    zip.file(name, anonymizeCommentMetadata(xml));
  }

  const output = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'UNIX',
  });
  await fs.writeFile(outputPath, output);
}

async function cleanFile({ inputPath, outputPath, category, extension }) {
  if (category === 'image') return cleanImage(inputPath, outputPath, extension);
  if (category === 'media') return cleanMedia(inputPath, outputPath);
  if (category === 'pdf') return cleanPdf(inputPath, outputPath);
  if (category === 'office') return cleanOffice(inputPath, outputPath);
  throw new Error('Unsupported file category.');
}

module.exports = {
  cleanFile,
  detectFile,
  inspectMetadata,
  normalizeExtension,
  OUTPUT_MIME,
  SUPPORTED_EXTENSIONS,
};
