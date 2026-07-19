'use strict';

const elements = {
  dropzone: document.querySelector('#dropzone'),
  fileInput: document.querySelector('#file-input'),
  selectedSection: document.querySelector('#selected-section'),
  selectedFiles: document.querySelector('#selected-files'),
  selectedCount: document.querySelector('#selected-count'),
  clearFiles: document.querySelector('#clear-files'),
  modeButtons: [...document.querySelectorAll('.mode-button')],
  cleanOptions: document.querySelector('#clean-options'),
  preserveIcc: document.querySelector('#preserve-icc'),
  deleteAfterDownload: document.querySelector('#delete-after-download'),
  actionButton: document.querySelector('#action-button'),
  actionLabel: document.querySelector('#action-button .button-label'),
  toolLabel: document.querySelector('#tool-label'),
  cleanerTitle: document.querySelector('#cleaner-title'),
  toolDescription: document.querySelector('#tool-description'),
  fileLimit: document.querySelector('#file-limit'),
  progressCard: document.querySelector('#progress-card'),
  progressTitle: document.querySelector('#progress-title'),
  progressPercent: document.querySelector('#progress-percent'),
  progressFill: document.querySelector('#progress-fill'),
  progressSteps: [...document.querySelectorAll('.progress-step')],
  stepThreeTitle: document.querySelector('#step-three-title'),
  stepThreeCopy: document.querySelector('#step-three-copy'),
  resultCard: document.querySelector('#result-card'),
  resultIcon: document.querySelector('#result-icon'),
  resultLabel: document.querySelector('#result-label'),
  resultTitle: document.querySelector('#result-title'),
  resultCopy: document.querySelector('#result-copy'),
  scoreComparison: document.querySelector('#score-comparison'),
  beforeRing: document.querySelector('#before-ring'),
  beforeScore: document.querySelector('#before-score'),
  beforeRisk: document.querySelector('#before-risk'),
  afterRing: document.querySelector('#after-ring'),
  afterScore: document.querySelector('#after-score'),
  afterRisk: document.querySelector('#after-risk'),
  resultFileCount: document.querySelector('#result-file-count'),
  resultFieldCount: document.querySelector('#result-field-count'),
  fieldsStatLabel: document.querySelector('#fields-stat-label'),
  resultTime: document.querySelector('#result-time'),
  fourthStatLabel: document.querySelector('#fourth-stat-label'),
  resultExpiry: document.querySelector('#result-expiry'),
  resultSummary: document.querySelector('#result-summary'),
  resultFiles: document.querySelector('#result-files'),
  resultActions: document.querySelector('#result-actions'),
  downloadButton: document.querySelector('#download-button'),
  downloadLabel: document.querySelector('#download-button span'),
  startOver: document.querySelector('#start-over'),
  errorCard: document.querySelector('#error-card'),
  errorMessage: document.querySelector('#error-message'),
};

const fileIconSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h6.5L18.5 8v12.5H7z"></path><path d="M13.5 3.5V8h5"></path></svg>';
const removeIconSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>';
const resultFileIconSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h6.5L18.5 8v12.5H7z"></path><path d="M13.5 3.5V8h5"></path></svg>';

let selectedFiles = [];
let previewUrls = [];
let mode = 'clean';
let currentDeleteUrl = null;
let progressTimer = null;
let config = {
  maxFileMb: 40,
  maxFiles: 8,
  maxTotalMb: 40,
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

function durationText(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds || 0)) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

function fileKind(file) {
  if (file.type.startsWith('image/')) return 'Image';
  if (file.type.startsWith('video/')) return 'Video';
  if (file.type.startsWith('audio/')) return 'Audio';
  if (file.type === 'application/pdf') return 'PDF';
  const extension = file.name.split('.').pop()?.toUpperCase();
  return extension || 'Document';
}

function revokePreviews() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}

function previewForFile(file) {
  const wrapper = document.createElement('div');
  wrapper.className = 'file-preview';
  if (file.type.startsWith('image/')) {
    const url = URL.createObjectURL(file);
    previewUrls.push(url);
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    wrapper.append(image);
    return wrapper;
  }
  if (file.type.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    previewUrls.push(url);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    wrapper.append(video);
    return wrapper;
  }
  wrapper.innerHTML = fileIconSvg;
  return wrapper;
}

function hideError() {
  elements.errorCard.classList.add('hidden');
  elements.errorMessage.textContent = '';
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorCard.classList.remove('hidden');
  elements.errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetResult() {
  elements.resultCard.classList.add('hidden');
  elements.resultSummary.replaceChildren();
  elements.resultFiles.replaceChildren();
  elements.downloadButton.href = '#';
  currentDeleteUrl = null;
}

function totalSelectedBytes() {
  return selectedFiles.reduce((total, file) => total + file.size, 0);
}

function fileIdentity(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function validateFiles(files) {
  const accepted = [];
  const existing = new Set(selectedFiles.map(fileIdentity));
  for (const file of files) {
    if (accepted.length + selectedFiles.length >= config.maxFiles) break;
    if (file.size > config.maxFileMb * 1024 * 1024) {
      showError(`${file.name} is larger than the ${config.maxFileMb} MB per-file limit.`);
      continue;
    }
    if (existing.has(fileIdentity(file))) continue;
    accepted.push(file);
    existing.add(fileIdentity(file));
  }

  const proposedBytes = totalSelectedBytes() + accepted.reduce((total, file) => total + file.size, 0);
  if (proposedBytes > config.maxTotalMb * 1024 * 1024) {
    showError(`The combined selection exceeds the ${config.maxTotalMb} MB total limit.`);
    return [];
  }
  if (files.length + selectedFiles.length > config.maxFiles) {
    showError(`You can process up to ${config.maxFiles} files at once.`);
  }
  return accepted;
}

function addFiles(files) {
  hideError();
  resetResult();
  const accepted = validateFiles([...files]);
  selectedFiles.push(...accepted);
  renderSelectedFiles();
}

function removeFileAt(index) {
  selectedFiles.splice(index, 1);
  renderSelectedFiles();
}

function clearSelectedFiles() {
  selectedFiles = [];
  elements.fileInput.value = '';
  renderSelectedFiles();
}

function renderSelectedFiles() {
  revokePreviews();
  elements.selectedFiles.replaceChildren();
  const hasFiles = selectedFiles.length > 0;
  elements.selectedSection.classList.toggle('hidden', !hasFiles);
  elements.actionButton.disabled = !hasFiles;

  if (!hasFiles) {
    elements.selectedCount.textContent = '0 files selected';
    return;
  }

  elements.selectedCount.textContent = `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} · ${bytesToSize(totalSelectedBytes())}`;

  selectedFiles.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.append(previewForFile(file));

    const copy = document.createElement('div');
    copy.className = 'file-copy';
    const name = document.createElement('strong');
    name.textContent = file.name;
    const details = document.createElement('span');
    details.textContent = `${fileKind(file)} · ${bytesToSize(file.size)}`;
    copy.append(name, details);

    const remove = document.createElement('button');
    remove.className = 'icon-button';
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${file.name}`);
    remove.innerHTML = removeIconSvg;
    remove.addEventListener('click', () => removeFileAt(index));

    row.append(copy, remove);
    elements.selectedFiles.append(row);
  });
}

function setMode(nextMode) {
  if (nextMode === mode) return;
  mode = nextMode;
  hideError();
  resetResult();

  for (const button of elements.modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }

  const cleaning = mode === 'clean';
  elements.cleanOptions.classList.toggle('hidden', !cleaning);
  elements.toolLabel.textContent = cleaning ? 'Metadata cleaner' : 'Metadata inspector';
  elements.cleanerTitle.textContent = cleaning ? 'Drop files to clean them' : 'Drop files to inspect them';
  elements.toolDescription.textContent = cleaning
    ? 'We scan, clean, verify, then prepare a private download.'
    : 'See hidden metadata and a privacy score without creating a cleaned copy.';
  elements.actionLabel.textContent = cleaning ? 'Remove metadata' : 'Inspect metadata';
  elements.stepThreeTitle.textContent = cleaning ? 'Remove' : 'Report';
  elements.stepThreeCopy.textContent = cleaning ? 'Strip private fields' : 'Build privacy report';
}

function resetProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  elements.progressPercent.textContent = '0%';
  elements.progressFill.style.width = '0%';
  elements.progressTitle.textContent = 'Preparing your files';
  for (const step of elements.progressSteps) step.classList.remove('active', 'complete');
}

function setProgress(percent, title, activeStep) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressPercent.textContent = `${safePercent}%`;
  elements.progressFill.style.width = `${safePercent}%`;
  if (title) elements.progressTitle.textContent = title;
  elements.progressSteps.forEach((step, index) => {
    step.classList.toggle('complete', index < activeStep);
    step.classList.toggle('active', index === activeStep);
  });
}

function beginProcessingAnimation() {
  let percent = 74;
  let stage = 1;
  setProgress(percent, 'Analyzing hidden metadata', stage);
  progressTimer = setInterval(() => {
    percent = Math.min(94, percent + Math.max(1, Math.round((95 - percent) / 5)));
    if (percent >= 83 && stage === 1) stage = 2;
    if (percent >= 91 && stage === 2) stage = 3;
    const titles = mode === 'clean'
      ? ['Uploading files', 'Analyzing hidden metadata', 'Removing private fields', 'Verifying cleaned output']
      : ['Uploading files', 'Analyzing hidden metadata', 'Building privacy report', 'Finalizing results'];
    setProgress(percent, titles[stage], stage);
  }, 650);
}

function riskText(score) {
  if (score >= 90) return 'Private';
  if (score >= 70) return 'Low exposure';
  if (score >= 40) return 'Medium exposure';
  return 'High exposure';
}

function setScore(ring, scoreElement, riskElement, value) {
  const score = Math.max(0, Math.min(100, Math.round(Number(value ?? 100))));
  ring.style.setProperty('--score', score);
  scoreElement.textContent = String(score);
  riskElement.textContent = riskText(score);
}

function categorySummary(files, metadataKey) {
  const map = new Map();
  for (const file of files) {
    for (const item of file[metadataKey] || []) {
      const current = map.get(item.category) || { label: item.categoryLabel || item.category, count: 0 };
      current.count += 1;
      map.set(item.category, current);
    }
  }
  return map;
}

function renderSummaryChips(files, metadataKey) {
  elements.resultSummary.replaceChildren();
  const categories = categorySummary(files, metadataKey);
  if (!categories.size) {
    const chip = document.createElement('span');
    chip.className = 'summary-chip technical';
    chip.textContent = 'No readable metadata found';
    elements.resultSummary.append(chip);
    return;
  }
  for (const [category, details] of categories) {
    const chip = document.createElement('span');
    chip.className = `summary-chip ${category}`;
    chip.textContent = `${details.label}: ${details.count}`;
    elements.resultSummary.append(chip);
  }
}

function groupMetadata(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.categoryLabel || item.category || 'Other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function renderMetadataList(container, items) {
  container.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-metadata';
    empty.textContent = 'No readable optional metadata was found in this file.';
    container.append(empty);
    return;
  }

  for (const [groupName, groupItems] of groupMetadata(items)) {
    const group = document.createElement('div');
    group.className = 'metadata-group';
    const title = document.createElement('div');
    title.className = 'metadata-group-title';
    const label = document.createElement('span');
    label.textContent = groupName;
    const count = document.createElement('span');
    count.textContent = `${groupItems.length} field${groupItems.length === 1 ? '' : 's'}`;
    title.append(label, count);

    const list = document.createElement('div');
    list.className = 'metadata-list';
    for (const item of groupItems) {
      const row = document.createElement('div');
      row.className = 'metadata-item';
      const field = document.createElement('strong');
      field.textContent = item.label;
      const value = document.createElement('span');
      value.textContent = item.value;
      value.title = item.value;
      const risk = document.createElement('i');
      risk.className = `risk-dot ${item.risk || 'medium'}`;
      risk.title = `${item.risk || 'medium'} risk`;
      row.append(field, value, risk);
      list.append(row);
    }
    group.append(title, list);
    container.append(group);
  }
}

function renderFileResult(file, cleanMode, openByDefault) {
  const details = document.createElement('details');
  details.className = 'file-result';
  details.open = openByDefault;

  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'result-file-icon';
  icon.innerHTML = resultFileIconSvg;
  const copy = document.createElement('span');
  copy.className = 'result-file-copy';
  const name = document.createElement('strong');
  name.textContent = cleanMode ? file.originalFilename : file.filename;
  const note = document.createElement('span');
  const fieldCount = cleanMode ? file.removedMetadata.length : file.metadata.length;
  note.textContent = cleanMode
    ? `${fieldCount} removed · ${bytesToSize(file.sourceBytes)} → ${bytesToSize(file.outputBytes)}`
    : `${fieldCount} metadata field${fieldCount === 1 ? '' : 's'} · Privacy score ${file.analysis.privacyScore}/100`;
  copy.append(name, note);
  summary.append(icon, copy);

  const body = document.createElement('div');
  body.className = 'file-result-body';
  if (cleanMode) {
    const verification = document.createElement('div');
    const remaining = file.afterMetadata.length;
    verification.className = `verification-row${remaining ? ' warning' : ''}`;
    const message = document.createElement('span');
    message.textContent = remaining
      ? `${remaining} readable field${remaining === 1 ? '' : 's'} remain after verification.`
      : 'Verified clean: no readable optional metadata remains.';
    const score = document.createElement('strong');
    score.textContent = `${file.beforeAnalysis.privacyScore} → ${file.afterAnalysis.privacyScore}`;
    verification.append(message, score);
    body.append(verification);

    const metadataContainer = document.createElement('div');
    renderMetadataList(metadataContainer, file.removedMetadata);
    body.append(metadataContainer);
  } else {
    const metadataContainer = document.createElement('div');
    renderMetadataList(metadataContainer, file.metadata);
    body.append(metadataContainer);
  }

  details.append(summary, body);
  return details;
}

function showResult(result) {
  const cleanMode = result.mode === 'clean';
  clearInterval(progressTimer);
  progressTimer = null;
  setProgress(100, cleanMode ? 'Cleaning complete' : 'Inspection complete', 4);
  for (const step of elements.progressSteps) {
    step.classList.remove('active');
    step.classList.add('complete');
  }
  setTimeout(() => elements.progressCard.classList.add('hidden'), 260);

  elements.resultIcon.classList.toggle('scan-icon', !cleanMode);
  elements.resultIcon.innerHTML = cleanMode
    ? '<svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.4 3.4 7.7-8"></path></svg>'
    : '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4 4"></path></svg>';
  elements.resultLabel.textContent = cleanMode ? 'Cleaning complete' : 'Privacy scan complete';
  elements.resultTitle.textContent = cleanMode
    ? (result.summary.removedFields ? 'Your files are private again.' : 'Your files were already clean.')
    : 'Your privacy report is ready.';
  elements.resultCopy.textContent = cleanMode
    ? `${result.summary.removedFields} metadata field${result.summary.removedFields === 1 ? ' was' : 's were'} removed and the output was checked again.`
    : `${result.summary.totalFields} readable metadata field${result.summary.totalFields === 1 ? ' was' : 's were'} found across your selection.`;

  elements.scoreComparison.classList.toggle('inspect-only', !cleanMode);
  setScore(elements.beforeRing, elements.beforeScore, elements.beforeRisk, result.summary.beforeScore);
  if (cleanMode) setScore(elements.afterRing, elements.afterScore, elements.afterRisk, result.summary.afterScore);

  elements.resultFileCount.textContent = String(result.summary.files);
  elements.fieldsStatLabel.textContent = cleanMode ? 'Removed' : 'Found';
  const fieldCount = cleanMode ? result.summary.removedFields : result.summary.totalFields;
  elements.resultFieldCount.textContent = `${fieldCount} field${fieldCount === 1 ? '' : 's'}`;
  elements.resultTime.textContent = durationText(result.elapsedMs);
  elements.fourthStatLabel.textContent = cleanMode ? 'Auto-delete' : 'Action';
  elements.resultExpiry.textContent = cleanMode
    ? (result.deleteAfterDownload ? 'After download' : `${config.fileTtlMinutes} min`)
    : 'No file saved';

  renderSummaryChips(result.files, cleanMode ? 'removedMetadata' : 'metadata');
  elements.resultFiles.replaceChildren();
  result.files.forEach((file, index) => {
    elements.resultFiles.append(renderFileResult(file, cleanMode, result.files.length === 1 || index === 0));
  });

  elements.resultActions.classList.toggle('inspect-actions', !cleanMode);
  if (cleanMode) {
    elements.downloadButton.href = result.downloadUrl;
    elements.downloadButton.download = result.filename;
    elements.downloadLabel.textContent = result.batch ? 'Download cleaned ZIP' : 'Download cleaned file';
    currentDeleteUrl = result.deleteUrl;
  } else {
    elements.downloadButton.href = '#';
    currentDeleteUrl = null;
  }

  elements.resultCard.classList.remove('hidden');
  elements.resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function deleteCurrentFile() {
  if (!currentDeleteUrl) return;
  const deleteUrl = currentDeleteUrl;
  currentDeleteUrl = null;
  try {
    await fetch(deleteUrl, { method: 'DELETE', keepalive: true });
  } catch {
    // Server expiry remains the fallback.
  }
}

function responsePayload(request) {
  if (request.response && typeof request.response === 'object') return request.response;
  try {
    return JSON.parse(request.responseText || '{}');
  } catch {
    return {};
  }
}

function runRequest() {
  if (!selectedFiles.length) return;
  hideError();
  resetResult();
  resetProgress();
  elements.actionButton.disabled = true;
  elements.progressCard.classList.remove('hidden');
  setProgress(1, 'Uploading files', 0);

  const formData = new FormData();
  for (const file of selectedFiles) formData.append('files', file, file.name);
  if (mode === 'clean') {
    formData.append('preserveIcc', String(elements.preserveIcc.checked));
    formData.append('deleteAfterDownload', String(elements.deleteAfterDownload.checked));
  }

  const request = new XMLHttpRequest();
  request.open('POST', mode === 'clean' ? '/api/clean' : '/api/inspect');
  request.responseType = 'json';
  request.timeout = 180_000;

  request.upload.addEventListener('progress', (event) => {
    if (!event.lengthComputable) return;
    const uploadPercent = Math.max(2, Math.min(72, (event.loaded / event.total) * 72));
    setProgress(uploadPercent, 'Uploading files', 0);
  });

  request.upload.addEventListener('load', beginProcessingAnimation);

  request.addEventListener('load', () => {
    elements.actionButton.disabled = false;
    const payload = responsePayload(request);
    if (request.status >= 200 && request.status < 300) {
      showResult(payload);
      return;
    }
    clearInterval(progressTimer);
    elements.progressCard.classList.add('hidden');
    showError(payload.error || 'The files could not be processed.');
  });

  request.addEventListener('error', () => {
    clearInterval(progressTimer);
    elements.progressCard.classList.add('hidden');
    elements.actionButton.disabled = false;
    showError('The upload failed. The server might be waking up or restarting. Try again in a moment.');
  });

  request.addEventListener('timeout', () => {
    clearInterval(progressTimer);
    elements.progressCard.classList.add('hidden');
    elements.actionButton.disabled = false;
    showError('Processing timed out. Try fewer or smaller files.');
  });

  request.send(formData);
}

async function startOver() {
  await deleteCurrentFile();
  clearSelectedFiles();
  resetResult();
  resetProgress();
  elements.dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) return;
    config = { ...config, ...(await response.json()) };
    elements.fileLimit.textContent = `Up to ${config.maxFiles} files · ${config.maxTotalMb} MB total`;
  } catch {
    // Defaults match server defaults.
  }
}

elements.modeButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
elements.dropzone.addEventListener('click', () => elements.fileInput.click());
elements.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.fileInput.addEventListener('change', () => {
  addFiles(elements.fileInput.files || []);
  elements.fileInput.value = '';
});
elements.clearFiles.addEventListener('click', clearSelectedFiles);
elements.actionButton.addEventListener('click', runRequest);
elements.startOver.addEventListener('click', startOver);
elements.downloadButton.addEventListener('click', () => {
  if (elements.deleteAfterDownload.checked) {
    setTimeout(() => {
      currentDeleteUrl = null;
      elements.downloadButton.removeAttribute('href');
      elements.downloadButton.setAttribute('aria-disabled', 'true');
    }, 1400);
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
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

window.addEventListener('beforeunload', () => {
  revokePreviews();
  if (currentDeleteUrl) fetch(currentDeleteUrl, { method: 'DELETE', keepalive: true });
});

loadConfig();
