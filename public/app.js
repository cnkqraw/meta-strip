'use strict';

const elements = {
  dropzone: document.querySelector('#dropzone'),
  fileInput: document.querySelector('#file-input'),
  selectedFile: document.querySelector('#selected-file'),
  filePreview: document.querySelector('#file-preview'),
  fileName: document.querySelector('#file-name'),
  fileDetails: document.querySelector('#file-details'),
  removeFile: document.querySelector('#remove-file'),
  cleanButton: document.querySelector('#clean-button'),
  deleteAfterDownload: document.querySelector('#delete-after-download'),
  progressCard: document.querySelector('#progress-card'),
  progressStatus: document.querySelector('#progress-status'),
  progressPercent: document.querySelector('#progress-percent'),
  progressFill: document.querySelector('#progress-fill'),
  progressNote: document.querySelector('#progress-note'),
  resultCard: document.querySelector('#result-card'),
  resultMessage: document.querySelector('#result-message'),
  sourceSize: document.querySelector('#source-size'),
  outputSize: document.querySelector('#output-size'),
  expiryTime: document.querySelector('#expiry-time'),
  metadataCount: document.querySelector('#metadata-count'),
  metadataList: document.querySelector('#metadata-list'),
  downloadButton: document.querySelector('#download-button'),
  cleanAnother: document.querySelector('#clean-another'),
  errorCard: document.querySelector('#error-card'),
  errorMessage: document.querySelector('#error-message'),
  fileLimit: document.querySelector('#file-limit'),
};

let selectedFile = null;
let previewUrl = null;
let currentDeleteUrl = null;
let config = {
  maxFileMb: 40,
  fileTtlMinutes: 10,
};

function bytesToSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function fileKind(file) {
  if (file.type.startsWith('image/')) return 'Image';
  if (file.type.startsWith('video/')) return 'Video';
  if (file.type.startsWith('audio/')) return 'Audio';
  if (file.type === 'application/pdf') return 'PDF';
  return 'Document';
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  elements.filePreview.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.5h6.5L18.5 8v12.5H7z"></path>
      <path d="M13.5 3.5V8h5"></path>
    </svg>`;
}

function showPreview(file) {
  clearPreview();
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
  previewUrl = URL.createObjectURL(file);

  if (file.type.startsWith('image/')) {
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = '';
    elements.filePreview.replaceChildren(image);
  } else {
    const video = document.createElement('video');
    video.src = previewUrl;
    video.muted = true;
    video.playsInline = true;
    elements.filePreview.replaceChildren(video);
  }
}

function hideError() {
  elements.errorCard.classList.add('hidden');
  elements.errorMessage.textContent = '';
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorCard.classList.remove('hidden');
}

function resetResult() {
  elements.resultCard.classList.add('hidden');
  elements.metadataList.replaceChildren();
  elements.downloadButton.href = '#';
  currentDeleteUrl = null;
}

function setSelectedFile(file) {
  hideError();
  resetResult();

  if (!file) {
    selectedFile = null;
    elements.fileInput.value = '';
    elements.selectedFile.classList.add('hidden');
    elements.cleanButton.disabled = true;
    clearPreview();
    return;
  }

  if (file.size > config.maxFileMb * 1024 * 1024) {
    setSelectedFile(null);
    showError(`That file is larger than the ${config.maxFileMb} MB limit.`);
    return;
  }

  selectedFile = file;
  elements.fileName.textContent = file.name;
  elements.fileDetails.textContent = `${fileKind(file)} · ${bytesToSize(file.size)}`;
  elements.selectedFile.classList.remove('hidden');
  elements.cleanButton.disabled = false;
  showPreview(file);
}

function setProgress(percent, status, note) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressPercent.textContent = `${safePercent}%`;
  elements.progressFill.style.width = `${safePercent}%`;
  if (status) elements.progressStatus.textContent = status;
  if (note) elements.progressNote.textContent = note;
}

function renderMetadata(items) {
  elements.metadataList.replaceChildren();
  elements.metadataCount.textContent = `${items.length} field${items.length === 1 ? '' : 's'}`;

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'metadata-empty';
    empty.textContent = 'No readable personal fields were found. The file was still rebuilt without optional metadata.';
    elements.metadataList.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'metadata-item';
    const label = document.createElement('span');
    const value = document.createElement('span');
    label.textContent = item.label;
    value.textContent = item.value;
    row.append(label, value);
    elements.metadataList.append(row);
  }
}

async function deleteCurrentFile() {
  if (!currentDeleteUrl) return;
  const deleteUrl = currentDeleteUrl;
  currentDeleteUrl = null;
  try {
    await fetch(deleteUrl, { method: 'DELETE', keepalive: true });
  } catch {
    // Expiry cleanup on the server remains the fallback.
  }
}

function showResult(result) {
  elements.resultMessage.textContent = result.message;
  elements.sourceSize.textContent = bytesToSize(result.sourceBytes);
  elements.outputSize.textContent = bytesToSize(result.outputBytes);
  elements.expiryTime.textContent = result.deleteAfterDownload ? 'After download' : `${config.fileTtlMinutes} min`;
  elements.downloadButton.href = result.downloadUrl;
  elements.downloadButton.download = result.filename;
  currentDeleteUrl = result.deleteUrl;
  renderMetadata(result.metadata || []);
  elements.resultCard.classList.remove('hidden');
}

function uploadSelectedFile() {
  if (!selectedFile) return;

  hideError();
  resetResult();
  elements.cleanButton.disabled = true;
  elements.progressCard.classList.remove('hidden');
  setProgress(0, 'Uploading securely', 'Your file is held only long enough to process it.');

  const formData = new FormData();
  formData.append('file', selectedFile, selectedFile.name);
  formData.append('deleteAfterDownload', String(elements.deleteAfterDownload.checked));

  const request = new XMLHttpRequest();
  request.open('POST', '/api/clean');
  request.responseType = 'json';
  request.timeout = 120_000;

  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const uploadPercent = (event.loaded / event.total) * 72;
    setProgress(uploadPercent, 'Uploading securely', 'The cleaner starts as soon as the upload finishes.');
  });

  request.upload.addEventListener('load', () => {
    setProgress(78, 'Removing metadata', 'Large media files might take a little longer.');
  });

  request.addEventListener('load', () => {
    elements.progressCard.classList.add('hidden');
    elements.cleanButton.disabled = false;

    const response = request.response || {};
    if (request.status >= 200 && request.status < 300) {
      setProgress(100, 'Complete', 'Your cleaned file is ready.');
      showResult(response);
      elements.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    showError(response.error || 'The file could not be cleaned.');
  });

  request.addEventListener('error', () => {
    elements.progressCard.classList.add('hidden');
    elements.cleanButton.disabled = false;
    showError('The upload failed. Check the server and try again.');
  });

  request.addEventListener('timeout', () => {
    elements.progressCard.classList.add('hidden');
    elements.cleanButton.disabled = false;
    showError('Processing timed out. Try a smaller file.');
  });

  request.send(formData);
}

async function cleanAnother() {
  await deleteCurrentFile();
  setSelectedFile(null);
  resetResult();
  elements.dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) return;
    config = { ...config, ...(await response.json()) };
    elements.fileLimit.textContent = `Up to ${config.maxFileMb} MB`;
  } catch {
    // Defaults match the server defaults.
  }
}

elements.dropzone.addEventListener('click', () => elements.fileInput.click());
elements.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.fileInput.addEventListener('change', () => setSelectedFile(elements.fileInput.files[0] || null));
elements.removeFile.addEventListener('click', (event) => {
  event.stopPropagation();
  setSelectedFile(null);
});
elements.cleanButton.addEventListener('click', uploadSelectedFile);
elements.cleanAnother.addEventListener('click', cleanAnother);
elements.downloadButton.addEventListener('click', () => {
  if (elements.deleteAfterDownload.checked) {
    setTimeout(() => {
      currentDeleteUrl = null;
      elements.downloadButton.removeAttribute('href');
      elements.downloadButton.setAttribute('aria-disabled', 'true');
    }, 1200);
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.add('dragover');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove('dragover');
  });
}
elements.dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) setSelectedFile(file);
});

window.addEventListener('beforeunload', () => {
  if (currentDeleteUrl) fetch(currentDeleteUrl, { method: 'DELETE', keepalive: true });
});

loadConfig();
