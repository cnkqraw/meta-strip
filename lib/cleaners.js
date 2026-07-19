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

sharp.concurrency(1);
sharp.cache(false);

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

const CATEGORY_LABELS = {
  location: 'Location',
  identity: 'Identity',
  device: 'Device',
  time: 'Dates and time',
  software: 'Software',
  descriptive: 'Descriptions',
  document: 'Document properties',
  rights: 'Copyright',
  technical: 'Technical',
  other: 'Other',
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
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return null;
  if (Array.isArray(value)) {
    const compact = value.slice(0, 8).map(safeScalar).filter(Boolean);
    return compact.length ? compact.join(', ') : null;
  }
  if (typeof value === 'object') {
    const compact = {};
    for (const [key, nested] of Object.entries(value).slice(0, 8)) {
      const clean = safeScalar(nested);
      if (clean) compact[key] = clean;
    }
    if (!Object.keys(compact).length) return null;
    return JSON.stringify(compact).slice(0, 220);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null' || text === '0') return null;
  return text.slice(0, 220);
}

function classifyMetadataKey(key, fallbackCategory = 'other') {
  const normalized = String(key).toLowerCase();
  if (/(gps|latitude|longitude|location|altitude|position)/.test(normalized)) {
    return { category: 'location', risk: 'high' };
  }
  if (/(owner|artist|author|creator|email|person|username|serial|by-line|contact)/.test(normalized)) {
    return { category: 'identity', risk: 'high' };
  }
  if (/(camera|make|model|lens|device|hostcomputer|computer|hardware|firmware)/.test(normalized)) {
    return { category: 'device', risk: 'medium' };
  }
  if (/(date|time|created|modified|digitized|timestamp)/.test(normalized)) {
    return { category: 'time', risk: 'medium' };
  }
  if (/(software|application|producer|encoder|creator tool|program)/.test(normalized)) {
    return { category: 'software', risk: 'medium' };
  }
  if (/(title|description|comment|subject|keyword|caption|headline|rating|label)/.test(normalized)) {
    return { category: 'descriptive', risk: 'medium' };
  }
  if (/(copyright|rights|license|credit)/.test(normalized)) {
    return { category: 'rights', risk: 'low' };
  }
  if (/(company|manager|last modified by|template|revision|document)/.test(normalized)) {
    return { category: 'document', risk: 'medium' };
  }
  if (/(orientation|exposure|aperture|fnumber|iso|focal|flash|metering|white balance|color|resolution|dimension|pixel|duration|bitrate|frame|codec)/.test(normalized)) {
    return { category: 'technical', risk: 'low' };
  }
  return { category: fallbackCategory, risk: fallbackCategory === 'technical' ? 'low' : 'medium' };
}

function metadataLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function addMetadata(result, label, value, options = {}) {
  const clean = safeScalar(value);
  if (!clean) return;
  const classified = classifyMetadataKey(label, options.category);
  const item = {
    label,
    value: clean,
    category: options.category || classified.category,
    categoryLabel: CATEGORY_LABELS[options.category || classified.category] || CATEGORY_LABELS.other,
    risk: options.risk || classified.risk,
    source: options.source || 'Metadata',
  };
  const signature = `${item.label.toLowerCase()}:${item.value.toLowerCase()}`;
  if (result.some((existing) => `${existing.label.toLowerCase()}:${existing.value.toLowerCase()}` === signature)) return;
  result.push(item);
}

function metadataSignature(item) {
  return `${String(item.label).toLowerCase()}:${String(item.value).toLowerCase()}`;
}

function compareMetadata(before, after) {
  const afterSet = new Set(after.map(metadataSignature));
  return before.filter((item) => !afterSet.has(metadataSignature(item)));
}

function summarizeMetadata(items) {
  const categoryCaps = {
    location: 60,
    identity: 38,
    device: 25,
    time: 20,
    software: 12,
    descriptive: 14,
    document: 22,
    rights: 8,
    technical: 8,
    other: 12,
  };
  const itemWeights = { high: 20, medium: 8, low: 2 };
  const categoryTotals = {};

  for (const item of items) {
    const category = item.category || 'other';
    const current = categoryTotals[category] || 0;
    categoryTotals[category] = Math.min(
      categoryCaps[category] || 12,
      current + (itemWeights[item.risk] || 4),
    );
  }

  const riskPoints = Math.min(100, Object.values(categoryTotals).reduce((total, value) => total + value, 0));
  const privacyScore = Math.max(0, 100 - riskPoints);
  const riskLevel = privacyScore >= 90
    ? 'safe'
    : privacyScore >= 70
      ? 'low'
      : privacyScore >= 40
        ? 'medium'
        : 'high';
  const categories = Object.keys(categoryTotals).map((category) => ({
    id: category,
    label: CATEGORY_LABELS[category] || CATEGORY_LABELS.other,
    count: items.filter((item) => item.category === category).length,
    riskPoints: categoryTotals[category],
  }));

  return {
    privacyScore,
    riskLevel,
    riskPoints,
    totalFields: items.length,
    highRiskFields: items.filter((item) => item.risk === 'high').length,
    categories,
  };
}

function enforceOfficeLimits(zip) {
  const entries = Object.values(zip.files);
  if (entries.length > 5000) throw new Error('The Office file contains too many internal files.');
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
  if (!zip.file(requiredEntry)) throw new Error('The uploaded Office file is invalid or damaged.');
}

async function detectFile(filePath, originalName) {
  const originalExtension = normalizeExtension(originalName);
  if (!SUPPORTED_EXTENSIONS.has(originalExtension)) throw new Error('This file type is not supported.');

  const { fileTypeFromFile } = await getFileTypeModule();
  const detected = await fileTypeFromFile(filePath);

  if (OFFICE_EXTENSIONS.has(originalExtension)) {
    if (!detected || !['zip', originalExtension].includes(detected.ext)) {
      throw new Error('The uploaded Office file does not match its extension.');
    }
    await validateOfficeArchive(filePath, originalExtension);
    return { extension: originalExtension, category: 'office', mime: OUTPUT_MIME[originalExtension] };
  }

  const normalizedDetected = detected?.ext === 'jpeg'
    ? 'jpg'
    : detected?.ext === 'tif'
      ? 'tiff'
      : detected?.ext;
  const aliases = { m4v: 'mp4', oga: 'ogg' };
  const detectedExtension = aliases[normalizedDetected] || normalizedDetected;

  if (!detectedExtension) throw new Error('The file format could not be verified.');
  if (originalExtension === 'mov' && detectedExtension === 'mp4') {
    return { extension: 'mov', category: 'media', mime: OUTPUT_MIME.mov };
  }
  if (originalExtension === 'm4a' && detectedExtension === 'mp4') {
    return { extension: 'm4a', category: 'media', mime: OUTPUT_MIME.m4a };
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
  if (originalExtension === 'pdf') return { extension: 'pdf', category: 'pdf', mime: OUTPUT_MIME.pdf };
  throw new Error('This file type is not supported.');
}

async function inspectImageMetadata(inputPath) {
  const found = [];
  let metadata;
  try {
    metadata = await exifr.parse(inputPath, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      icc: false,
      jfif: false,
      ihdr: false,
      translateKeys: true,
      translateValues: true,
      reviveValues: true,
      mergeOutput: true,
      makerNote: false,
      userComment: true,
    });
  } catch {
    return found;
  }
  if (!metadata) return found;

  if (metadata.latitude != null && metadata.longitude != null) {
    addMetadata(found, 'GPS location', `${metadata.latitude}, ${metadata.longitude}`, {
      category: 'location', risk: 'high', source: 'GPS',
    });
  }
  addMetadata(found, 'GPS altitude', metadata.GPSAltitude ?? metadata.altitude, { category: 'location', risk: 'high', source: 'GPS' });
  addMetadata(found, 'Camera make', metadata.Make, { category: 'device', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Camera model', metadata.Model, { category: 'device', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Camera owner', metadata.OwnerName || metadata.CameraOwnerName, { category: 'identity', risk: 'high', source: 'EXIF' });
  addMetadata(found, 'Camera serial number', metadata.SerialNumber || metadata.BodySerialNumber, { category: 'identity', risk: 'high', source: 'EXIF' });
  addMetadata(found, 'Lens make', metadata.LensMake, { category: 'device', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Lens model', metadata.LensModel, { category: 'device', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Lens serial number', metadata.LensSerialNumber, { category: 'identity', risk: 'high', source: 'EXIF' });
  addMetadata(found, 'Artist', metadata.Artist || metadata.Creator || metadata.Byline, { category: 'identity', risk: 'high', source: 'EXIF/IPTC' });
  addMetadata(found, 'Copyright', metadata.Copyright || metadata.CopyrightNotice, { category: 'rights', risk: 'low', source: 'EXIF/IPTC' });
  addMetadata(found, 'Captured', metadata.DateTimeOriginal || metadata.CreateDate, { category: 'time', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Digitized', metadata.DateTimeDigitized, { category: 'time', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Modified', metadata.ModifyDate || metadata.DateTime, { category: 'time', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Software', metadata.Software || metadata.CreatorTool, { category: 'software', risk: 'medium', source: 'EXIF/XMP' });
  addMetadata(found, 'Host computer', metadata.HostComputer, { category: 'device', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Title', metadata.Title || metadata.ObjectName || metadata.XPTitle, { category: 'descriptive', risk: 'medium', source: 'XMP/IPTC' });
  addMetadata(found, 'Description', metadata.ImageDescription || metadata.Description || metadata.Caption, { category: 'descriptive', risk: 'medium', source: 'EXIF/XMP' });
  addMetadata(found, 'Comment', metadata.UserComment || metadata.Comment || metadata.XPComment, { category: 'descriptive', risk: 'medium', source: 'EXIF' });
  addMetadata(found, 'Keywords', metadata.Keywords || metadata.Subject || metadata.XPKeywords, { category: 'descriptive', risk: 'medium', source: 'XMP/IPTC' });
  addMetadata(found, 'Orientation', metadata.Orientation, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'ISO', metadata.ISO || metadata.ISOSpeedRatings, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Exposure time', metadata.ExposureTime, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Aperture', metadata.FNumber || metadata.ApertureValue, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Focal length', metadata.FocalLength, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, '35mm focal length', metadata.FocalLengthIn35mmFormat || metadata.FocalLengthIn35mmFilm, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Flash', metadata.Flash, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Metering mode', metadata.MeteringMode, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'White balance', metadata.WhiteBalance, { category: 'technical', risk: 'low', source: 'EXIF' });
  addMetadata(found, 'Color space', metadata.ColorSpace, { category: 'technical', risk: 'low', source: 'EXIF' });

  const ignoredKeys = new Set([
    'latitude', 'longitude', 'thumbnail', 'thumbnailoffset', 'thumbnaillength',
    'makernote', 'icc_profile', 'xmp', 'iptc', 'exif', 'gps', 'jfif',
    'make', 'model', 'ownername', 'cameraownername', 'serialnumber', 'bodyserialnumber',
    'lensmake', 'lensmodel', 'lensserialnumber', 'artist', 'creator', 'byline',
    'copyright', 'copyrightnotice', 'datetimeoriginal', 'createdate', 'datetimedigitized',
    'modifydate', 'datetime', 'software', 'creatortool', 'hostcomputer', 'title',
    'objectname', 'xptitle', 'imagedescription', 'description', 'caption', 'usercomment',
    'comment', 'xpcomment', 'keywords', 'subject', 'xpkeywords', 'orientation', 'iso',
    'isospeedratings', 'exposuretime', 'fnumber', 'aperturevalue', 'focallength',
    'focallengthin35mmformat', 'focallengthin35mmfilm', 'flash', 'meteringmode',
    'whitebalance', 'colorspace', 'gpsaltitude', 'altitude',
  ]);

  for (const [key, value] of Object.entries(metadata)) {
    if (found.length >= 60) break;
    if (ignoredKeys.has(key.toLowerCase())) continue;
    const clean = safeScalar(value);
    if (!clean) continue;
    const classified = classifyMetadataKey(key, 'technical');
    addMetadata(found, metadataLabel(key), clean, {
      category: classified.category,
      risk: classified.risk,
      source: 'Embedded metadata',
    });
  }

  return found.slice(0, 60);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
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
      if (/^\s*(Duration|Stream|Chapter|Input|Output|At least one output)/.test(line)) inMetadata = false;
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    const ignored = new Set(['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'vendor_id', 'handler_name']);
    if (ignored.has(key.toLowerCase())) continue;
    const classified = classifyMetadataKey(key, 'descriptive');
    addMetadata(found, metadataLabel(key), value, {
      category: classified.category,
      risk: classified.risk,
      source: 'Media container',
    });
  }
  return found.slice(0, 40);
}

async function inspectMediaMetadata(inputPath) {
  if (!ffmpegPath) return [];
  try {
    const result = await runProcess(ffmpegPath, ['-hide_banner', '-i', inputPath], { acceptCodes: [1] });
    return parseFfmpegMetadata(result.stderr);
  } catch {
    return [];
  }
}

async function inspectPdfMetadata(inputPath) {
  const found = [];
  try {
    const bytes = await fs.readFile(inputPath);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
    addMetadata(found, 'Title', pdf.getTitle(), { category: 'descriptive', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Author', pdf.getAuthor(), { category: 'identity', risk: 'high', source: 'PDF info' });
    addMetadata(found, 'Subject', pdf.getSubject(), { category: 'descriptive', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Keywords', pdf.getKeywords(), { category: 'descriptive', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Creator', pdf.getCreator(), { category: 'software', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Producer', pdf.getProducer(), { category: 'software', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Created', pdf.getCreationDate(), { category: 'time', risk: 'medium', source: 'PDF info' });
    addMetadata(found, 'Modified', pdf.getModificationDate(), { category: 'time', risk: 'medium', source: 'PDF info' });
  } catch (error) {
    if (/encrypted/i.test(error.message)) throw new Error('Encrypted PDFs are not supported.');
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
  const custom = zip.file('docProps/custom.xml');

  if (core) {
    const xml = await core.async('string');
    addMetadata(found, 'Creator', extractXmlTag(xml, 'dc:creator'), { category: 'identity', risk: 'high', source: 'Office core properties' });
    addMetadata(found, 'Last modified by', extractXmlTag(xml, 'cp:lastModifiedBy'), { category: 'identity', risk: 'high', source: 'Office core properties' });
    addMetadata(found, 'Title', extractXmlTag(xml, 'dc:title'), { category: 'descriptive', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Subject', extractXmlTag(xml, 'dc:subject'), { category: 'descriptive', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Description', extractXmlTag(xml, 'dc:description'), { category: 'descriptive', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Keywords', extractXmlTag(xml, 'cp:keywords'), { category: 'descriptive', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Created', extractXmlTag(xml, 'dcterms:created'), { category: 'time', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Modified', extractXmlTag(xml, 'dcterms:modified'), { category: 'time', risk: 'medium', source: 'Office core properties' });
    addMetadata(found, 'Revision', extractXmlTag(xml, 'cp:revision'), { category: 'document', risk: 'low', source: 'Office core properties' });
  }
  if (app) {
    const xml = await app.async('string');
    addMetadata(found, 'Company', extractXmlTag(xml, 'Company'), { category: 'document', risk: 'medium', source: 'Office extended properties' });
    addMetadata(found, 'Manager', extractXmlTag(xml, 'Manager'), { category: 'identity', risk: 'high', source: 'Office extended properties' });
    addMetadata(found, 'Application', extractXmlTag(xml, 'Application'), { category: 'software', risk: 'medium', source: 'Office extended properties' });
    addMetadata(found, 'Template', extractXmlTag(xml, 'Template'), { category: 'document', risk: 'low', source: 'Office extended properties' });
  }
  if (custom) {
    addMetadata(found, 'Custom properties', 'Present', { category: 'document', risk: 'medium', source: 'Office custom properties' });
  }
  if (zip.file('docProps/thumbnail.jpeg') || zip.file('docProps/thumbnail.jpg') || zip.file('docProps/thumbnail.png')) {
    addMetadata(found, 'Embedded thumbnail', 'Present', { category: 'document', risk: 'medium', source: 'Office package' });
  }
  return found.slice(0, 40);
}

async function inspectMetadata(inputPath, category) {
  if (category === 'image') return inspectImageMetadata(inputPath);
  if (category === 'media') return inspectMediaMetadata(inputPath);
  if (category === 'pdf') return inspectPdfMetadata(inputPath);
  if (category === 'office') return inspectOfficeMetadata(inputPath);
  return [];
}

async function cleanImage(inputPath, outputPath, extension, options = {}) {
  let pipeline = sharp(inputPath, {
    animated: false,
    failOn: 'warning',
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  }).autoOrient();

  if (options.preserveIcc && typeof pipeline.keepIccProfile === 'function') {
    pipeline = pipeline.keepIccProfile();
  }

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
  if (!ffmpegPath) throw new Error('FFmpeg is unavailable on this server.');
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
    pdf = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
  } catch (error) {
    if (/encrypted/i.test(error.message)) throw new Error('Encrypted PDFs are not supported.');
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
  const output = await pdf.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
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

async function cleanFile({ inputPath, outputPath, category, extension, options = {} }) {
  if (category === 'image') return cleanImage(inputPath, outputPath, extension, options);
  if (category === 'media') return cleanMedia(inputPath, outputPath);
  if (category === 'pdf') return cleanPdf(inputPath, outputPath);
  if (category === 'office') return cleanOffice(inputPath, outputPath);
  throw new Error('Unsupported file category.');
}

module.exports = {
  cleanFile,
  detectFile,
  inspectMetadata,
  summarizeMetadata,
  compareMetadata,
  normalizeExtension,
  OUTPUT_MIME,
  SUPPORTED_EXTENSIONS,
  CATEGORY_LABELS,
};
