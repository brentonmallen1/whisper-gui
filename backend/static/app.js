(() => {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────
  const uploadSection   = document.getElementById('upload-section');
  const progressSection = document.getElementById('progress-section');
  const resultSection   = document.getElementById('result-section');
  const errorSection    = document.getElementById('error-section');
  const transcribePanel = document.getElementById('transcribe-panel');

  const dropZone        = document.getElementById('drop-zone');
  const fileInput       = document.getElementById('file-input');
  const browseBtn       = document.getElementById('browse-btn');

  const progressBar     = document.getElementById('progress-bar');
  const progressLabel   = document.getElementById('progress-label');
  const progressFilename = document.getElementById('progress-filename');

  const audioPlayer     = document.getElementById('audio-player');
  const resultText      = document.getElementById('result-text');
  const resultWords     = document.getElementById('result-words');
  const editBtn         = document.getElementById('edit-btn');
  const editLabel       = document.getElementById('edit-label');
  const copyBtn         = document.getElementById('copy-btn');
  const exportBtn       = document.getElementById('export-btn');
  const resetBtn        = document.getElementById('reset-btn');

  const errorMsg        = document.getElementById('error-msg');
  const retryBtn        = document.getElementById('retry-btn');
  const infoBadge       = document.getElementById('info-badge');

  const tabTranscribeBtn = document.getElementById('tab-transcribe');
  const tabFilesBtn      = document.getElementById('tab-files');
  const filesPanel       = document.getElementById('files-panel');
  const filesEmpty       = document.getElementById('files-empty');
  const filesList        = document.getElementById('files-list');

  // Transcribe-tab wrapper (everything inside <main> except files-section)
  const transcribeView = [uploadSection, progressSection, resultSection, errorSection];

  // ── State ─────────────────────────────────────────────────────────────
  let currentJobId = null;
  let pollTimer    = null;

  const ACCEPTED = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.webm', '.opus', '.aac', '.wma'];

  // ── Init ──────────────────────────────────────────────────────────────
  fetchInfo();

  // ── Tab switching ─────────────────────────────────────────────────────
  function setTab(name) {
    const isFiles = name === 'files';

    // Update tab button states
    tabTranscribeBtn.classList.toggle('active', !isFiles);
    tabFilesBtn.classList.toggle('active', isFiles);
    tabTranscribeBtn.setAttribute('aria-selected', String(!isFiles));
    tabFilesBtn.setAttribute('aria-selected', String(isFiles));

    // Update panel visibility
    filesPanel.classList.toggle('hidden', !isFiles);
    transcribePanel.classList.toggle('hidden', isFiles);

    if (!isFiles && !currentJobId) showSection('upload');
  }

  tabTranscribeBtn.addEventListener('click', () => setTab('transcribe'));
  tabFilesBtn.addEventListener('click', () => {
    setTab('files');
    loadFiles();
  });

  // Keyboard navigation for tabs
  [tabTranscribeBtn, tabFilesBtn].forEach(btn => {
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const nextTab = e.key === 'ArrowLeft' ? tabTranscribeBtn : tabFilesBtn;
        nextTab.focus();
        nextTab.click();
      }
    });
  });

  // ── Engine info badge ─────────────────────────────────────────────────
  async function fetchInfo() {
    try {
      const res = await fetch('/api/info');
      if (!res.ok) return;
      const data = await res.json();
      const gpu = data.gpu_available
        ? (data.gpu_name ? `GPU: ${data.gpu_name}` : 'GPU')
        : 'CPU';
      infoBadge.textContent = `${data.engine} · ${data.model} · ${gpu}`;
    } catch (err) {
      console.debug('Failed to fetch info:', err);
    }
  }

  // ── Drop zone events ──────────────────────────────────────────────────
  browseBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target !== browseBtn) fileInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  ['dragleave', 'dragend'].forEach(evt =>
    dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'))
  );

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });

  // ── Action buttons ────────────────────────────────────────────────────
  copyBtn.addEventListener('click', async () => {
    const btnText = copyBtn.querySelector('.btn-text');
    try {
      await navigator.clipboard.writeText(resultText.value);
      copyBtn.classList.add('copied');
      if (btnText) btnText.textContent = 'Copied!';
      copyBtn.setAttribute('aria-label', 'Copied to clipboard');

      setTimeout(() => {
        copyBtn.classList.remove('copied');
        if (btnText) btnText.textContent = 'Copy';
        copyBtn.removeAttribute('aria-label');
      }, 2000);
    } catch (err) {
      console.debug('Clipboard access denied:', err);
    }
  });

  exportBtn.addEventListener('click', () => {
    if (currentJobId) {
      window.location.href = `/api/export/${currentJobId}`;
    }
  });

  editBtn.addEventListener('click', () => {
    const isEditing = !resultText.hasAttribute('readonly');
    if (isEditing) {
      resultText.setAttribute('readonly', '');
      editBtn.classList.remove('editing');
      editBtn.setAttribute('aria-pressed', 'false');
      editLabel.textContent = 'Edit';
    } else {
      resultText.removeAttribute('readonly');
      resultText.focus();
      editBtn.classList.add('editing');
      editBtn.setAttribute('aria-pressed', 'true');
      editLabel.textContent = 'Done';
    }
  });

  resetBtn.addEventListener('click', reset);
  retryBtn.addEventListener('click', reset);

  // ── File browser ──────────────────────────────────────────────────────
  async function loadFiles() {
    filesList.innerHTML = '';
    filesEmpty.classList.add('hidden');
    try {
      const res = await fetch('/api/files');
      if (!res.ok) return;
      const files = await res.json();
      if (!files.length) {
        filesEmpty.classList.remove('hidden');
        return;
      }
      files.forEach(meta => filesList.appendChild(buildFileItem(meta)));
    } catch (err) {
      console.debug('Failed to load files:', err);
      filesEmpty.classList.remove('hidden');
    }
  }

  function buildFileItem(meta) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M9 18V5l12-2v13"/>
        <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
      </svg>
      <div class="file-info">
        <span class="file-name">${escHtml(meta.filename || meta.audio_file)}</span>
        <span class="file-meta">${fmtSize(meta.size)} · ${fmtDate(meta.uploaded_at)}</span>
      </div>
      <button class="btn btn-primary">Transcribe</button>
    `;
    li.querySelector('button').addEventListener('click', () =>
      retranscribeFile(meta.job_id, meta.filename || meta.audio_file)
    );
    return li;
  }

  async function retranscribeFile(jobId, filename) {
    setTab('transcribe');
    showSection('progress');
    progressFilename.textContent = filename;
    setProgress('indeterminate', 'Starting transcription...');

    let newJobId;
    try {
      const res = await fetch(`/api/retranscribe/${jobId}`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed to start' }));
        throw new Error(err.detail || 'Failed to start');
      }
      const data = await res.json();
      newJobId = data.job_id;
    } catch (err) {
      showError(err.message);
      return;
    }

    currentJobId = newJobId;
    setProgress('indeterminate', 'Transcribing...');
    pollStatus(currentJobId);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  // ── Core flow ─────────────────────────────────────────────────────────
  function handleFile(file) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      showError(`Unsupported file type: ${ext}. Accepted: ${ACCEPTED.join(', ')}`);
      return;
    }
    uploadFile(file);
  }

  async function uploadFile(file) {
    showSection('progress');
    progressFilename.textContent = file.name;
    setProgress('indeterminate', 'Uploading...');

    const form = new FormData();
    form.append('file', file);

    let jobId;
    try {
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
        throw new Error(err.detail || 'Upload failed');
      }
      const data = await res.json();
      jobId = data.job_id;
    } catch (err) {
      showError(err.message);
      return;
    }

    currentJobId = jobId;
    setProgress('indeterminate', 'Transcribing...');
    pollStatus(jobId);
  }

  function pollStatus(jobId) {
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();

        if (job.status === 'done') {
          stopPolling();
          showResult(job.result);
        } else if (job.status === 'error') {
          stopPolling();
          showError(job.error || 'Transcription failed.');
        } else if (job.status === 'processing') {
          setProgress('indeterminate', 'Transcribing... (this may take a moment)');
        }
      } catch (err) {
        console.debug('Poll error:', err);
      }
    }, 1200);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── UI helpers ────────────────────────────────────────────────────────
  function showSection(name) {
    uploadSection.classList.add('hidden');
    progressSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    errorSection.classList.add('hidden');

    if (name === 'upload')   uploadSection.classList.remove('hidden');
    if (name === 'progress') progressSection.classList.remove('hidden');
    if (name === 'result')   resultSection.classList.remove('hidden');
    if (name === 'error')    errorSection.classList.remove('hidden');
  }

  function setProgress(mode, label) {
    progressLabel.textContent = label;
    if (mode === 'indeterminate') {
      progressBar.style.width = '';
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = mode + '%';
    }
  }

  function showResult(text) {
    resultText.value = text;
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    resultWords.textContent = `${wordCount.toLocaleString()} word${wordCount !== 1 ? 's' : ''}`;
    audioPlayer.src = `/api/audio/${currentJobId}`;
    showSection('result');
  }

  function showError(msg) {
    stopPolling();
    errorMsg.textContent = msg;
    showSection('error');
  }

  function reset() {
    stopPolling();
    currentJobId = null;
    fileInput.value = '';
    resultText.value = '';
    resultText.setAttribute('readonly', '');
    editBtn.classList.remove('editing');
    editBtn.setAttribute('aria-pressed', 'false');
    editLabel.textContent = 'Edit';
    audioPlayer.pause();
    audioPlayer.src = '';
    showSection('upload');
  }
})();
