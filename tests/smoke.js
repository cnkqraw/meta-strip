'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const ffmpegPath = process.env.FFMPEG_PATH || require('@ffmpeg-installer/ffmpeg').path;
const JSZip = require('jszip');
const { PDFDocument } = require('pdf-lib');
const {
  cleanFile,
  detectFile,
  inspectMetadata,
} = require('../lib/cleaners');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} failed (${code})\n${stderr}`));
    });
  });
}

async function createFixtures(dir) {
  const image = path.join(dir, 'camera.jpg');
  await sharp({
    create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 55, b: 90 } },
  })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toFile(image);

  const video = path.join(dir, 'clip.mp4');
  await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=0.5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-metadata', 'title=Private title',
    '-metadata', 'artist=Private artist',
    '-metadata:s:v:0', 'title=Private stream title',
    video,
  ]);

  const pdf = path.join(dir, 'document.pdf');
  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([200, 200]);
  pdfDoc.setTitle('Private title');
  pdfDoc.setAuthor('Private author');
  await fs.writeFile(pdf, await pdfDoc.save());

  const docx = path.join(dir, 'report.docx');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  zip.file('docProps/core.xml', '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Private author</dc:creator><dc:title>Private title</dc:title></cp:coreProperties>');
  zip.file('docProps/app.xml', '<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Private company</Company></Properties>');
  await fs.writeFile(docx, await zip.generateAsync({ type: 'nodebuffer' }));

  return { image, video, pdf, docx };
}

async function testCleaner(inputPath, originalName, expectedCategory) {
  const detected = await detectFile(inputPath, originalName);
  assert.equal(detected.category, expectedCategory);
  const before = await inspectMetadata(inputPath, detected.category);
  const output = path.join(path.dirname(inputPath), `cleaned-${path.basename(inputPath)}`);
  await cleanFile({
    inputPath,
    outputPath: output,
    category: detected.category,
    extension: detected.extension,
  });
  const stats = await fs.stat(output);
  assert.ok(stats.size > 0, `${originalName} output should not be empty`);
  const after = await inspectMetadata(output, detected.category);
  return { before, after, output };
}

async function waitForServer(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (text.includes('MetaStrip is running')) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with ${code}`));
    });
  });
}

async function integrationTest(imagePath) {
  const port = 39000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', MAX_FILE_MB: '10' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  try {
    await waitForServer(child);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);

    const imageBytes = await fs.readFile(imagePath);
    const form = new FormData();
    form.append('file', new Blob([imageBytes], { type: 'image/jpeg' }), 'camera.jpg');
    form.append('deleteAfterDownload', 'true');

    const cleaned = await fetch(`http://127.0.0.1:${port}/api/clean`, {
      method: 'POST',
      body: form,
    });
    const payload = await cleaned.json();
    assert.equal(cleaned.status, 200, JSON.stringify(payload));
    assert.ok(payload.downloadUrl);

    const download = await fetch(`http://127.0.0.1:${port}${payload.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.ok((await download.arrayBuffer()).byteLength > 0);

    const secondDownload = await fetch(`http://127.0.0.1:${port}${payload.downloadUrl}`);
    assert.equal(secondDownload.status, 404, 'One-time download should be deleted');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    if (stderr) process.stderr.write(stderr);
  }
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'metastrip-test-'));
  try {
    const fixtures = await createFixtures(temp);

    const image = await testCleaner(fixtures.image, 'camera.jpg', 'image');
    assert.ok(image.before.some((item) => item.label === 'Orientation'));
    assert.equal(image.after.length, 0, 'Image metadata should be removed');

    const video = await testCleaner(fixtures.video, 'clip.mp4', 'media');
    assert.ok(video.before.some((item) => item.label === 'Title'));
    assert.ok(!video.after.some((item) => ['Title', 'Artist'].includes(item.label)));

    const pdf = await testCleaner(fixtures.pdf, 'document.pdf', 'pdf');
    assert.ok(pdf.before.some((item) => item.label === 'Author'));
    assert.equal(pdf.after.length, 0, 'PDF info metadata should be removed');

    const office = await testCleaner(fixtures.docx, 'report.docx', 'office');
    assert.ok(office.before.some((item) => item.label === 'Creator'));
    assert.equal(office.after.length, 0, 'Office document properties should be removed');

    await integrationTest(fixtures.image);
    console.log('All MetaStrip smoke tests passed.');
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
