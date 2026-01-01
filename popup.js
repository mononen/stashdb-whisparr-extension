// Popup script for batch status display

const content = document.getElementById('content');
const batchList = document.getElementById('batchList');
const emptyState = document.getElementById('emptyState');
const footer = document.getElementById('footer');
const retryAllBtn = document.getElementById('retryAllBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const notificationsToggle = document.getElementById('notificationsToggle');

let batches = [];
let expandedBatchIds = new Set(); // Track which batches are expanded
let isFirstRender = true;

// Load batch status on popup open
document.addEventListener('DOMContentLoaded', async () => {
  await loadBatchStatus();
  await loadNotificationSetting();
  
  // Listen for real-time updates from background script
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'batchStatusUpdate') {
      batches = message.batches || [];
      renderBatches();
    }
  });
});

// Load notification setting
async function loadNotificationSetting() {
  const data = await browser.storage.local.get({ notificationsEnabled: true });
  notificationsToggle.checked = data.notificationsEnabled;
}

// Handle notifications toggle change
notificationsToggle.addEventListener('change', async () => {
  await browser.storage.local.set({ notificationsEnabled: notificationsToggle.checked });
});

// Load batch status from background script
async function loadBatchStatus() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getBatchStatus' });
    batches = response?.batches || [];
    renderBatches();
  } catch (error) {
    console.error('[Popup] Error loading batch status:', error);
  }
}

// Render all batches
function renderBatches() {
  if (batches.length === 0) {
    emptyState.style.display = 'flex';
    batchList.replaceChildren();
    footer.style.display = 'none';
    isFirstRender = true;
    expandedBatchIds.clear();
    return;
  }

  emptyState.style.display = 'none';
  footer.style.display = 'flex';

  // Check if there are any failed scenes
  const hasFailedScenes = batches.some(batch => 
    batch.scenes.some(scene => scene.status === 'error')
  );
  retryAllBtn.disabled = !hasFailedScenes;

  // On first render, expand the most recent batch
  if (isFirstRender && batches.length > 0) {
    const newestBatch = batches[batches.length - 1];
    expandedBatchIds.add(newestBatch.id);
    isFirstRender = false;
  }

  // Render batches (newest first) using DOM methods
  const fragment = document.createDocumentFragment();
  batches
    .slice()
    .reverse()
    .forEach(batch => fragment.appendChild(renderBatch(batch, expandedBatchIds.has(batch.id))));
  batchList.replaceChildren(fragment);

  // Attach event listeners
  attachEventListeners();
}

// Render a single batch
function renderBatch(batch, expanded = false) {
  const stats = getStats(batch.scenes);
  const time = formatTime(batch.timestamp);
  
  const batchEl = document.createElement('div');
  batchEl.className = `batch ${expanded ? 'expanded' : ''}`;
  batchEl.dataset.batchId = batch.id;

  // Create batch header
  const header = document.createElement('div');
  header.className = 'batch-header';

  const headerInfo = document.createElement('div');
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'batch-time';
  timeSpan.textContent = time;
  headerInfo.appendChild(timeSpan);

  const statsDiv = document.createElement('div');
  statsDiv.className = 'batch-stats';
  
  if (stats.success > 0) {
    const successStat = document.createElement('span');
    successStat.className = 'batch-stat success';
    successStat.textContent = `${stats.success} done`;
    statsDiv.appendChild(successStat);
  }
  if (stats.error > 0) {
    const errorStat = document.createElement('span');
    errorStat.className = 'batch-stat error';
    errorStat.textContent = `${stats.error} failed`;
    statsDiv.appendChild(errorStat);
  }
  if (stats.pending > 0) {
    const pendingStat = document.createElement('span');
    pendingStat.className = 'batch-stat pending';
    pendingStat.textContent = `${stats.pending} pending`;
    statsDiv.appendChild(pendingStat);
  }
  headerInfo.appendChild(statsDiv);
  header.appendChild(headerInfo);

  // Create chevron SVG
  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'chevron');
  chevron.setAttribute('width', '16');
  chevron.setAttribute('height', '16');
  chevron.setAttribute('viewBox', '0 0 24 24');
  chevron.setAttribute('fill', 'none');
  chevron.setAttribute('stroke', 'currentColor');
  chevron.setAttribute('stroke-width', '2');
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', '6 9 12 15 18 9');
  chevron.appendChild(polyline);
  header.appendChild(chevron);

  batchEl.appendChild(header);

  // Create scenes container
  const scenesDiv = document.createElement('div');
  scenesDiv.className = 'batch-scenes';
  batch.scenes.forEach(scene => scenesDiv.appendChild(renderScene(batch.id, scene)));
  batchEl.appendChild(scenesDiv);

  return batchEl;
}

// Render a single scene row
function renderScene(batchId, scene) {
  const shortId = scene.stashId.substring(0, 8);
  const showRetry = scene.status === 'error';
  
  const sceneEl = document.createElement('div');
  sceneEl.className = 'scene';
  sceneEl.dataset.sceneId = scene.stashId;

  const sceneInfo = document.createElement('div');
  sceneInfo.className = 'scene-info';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'scene-title';
  titleDiv.textContent = scene.title || 'Unknown Scene';
  sceneInfo.appendChild(titleDiv);

  const idDiv = document.createElement('div');
  idDiv.className = 'scene-id';
  idDiv.textContent = `${shortId}...`;
  sceneInfo.appendChild(idDiv);

  sceneEl.appendChild(sceneInfo);

  const badge = document.createElement('span');
  badge.className = `status-badge ${scene.status}${scene.error ? ' error-tooltip' : ''}`;
  if (scene.error) {
    badge.dataset.error = scene.error;
  }
  badge.textContent = getStatusLabel(scene.status);
  sceneEl.appendChild(badge);

  if (showRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'scene-retry';
    retryBtn.dataset.batchId = batchId;
    retryBtn.dataset.sceneId = scene.stashId;
    retryBtn.textContent = 'Retry';
    sceneEl.appendChild(retryBtn);
  }

  return sceneEl;
}

// Get statistics for a batch
function getStats(scenes) {
  return {
    success: scenes.filter(s => ['added', 'searched', 'exists'].includes(s.status)).length,
    error: scenes.filter(s => s.status === 'error').length,
    pending: scenes.filter(s => ['waiting', 'adding'].includes(s.status)).length
  };
}

// Get human-readable status label
function getStatusLabel(status) {
  const labels = {
    waiting: 'Waiting',
    adding: 'Adding...',
    added: 'Added',
    searched: 'Searched',
    exists: 'Exists',
    error: 'Error'
  };
  return labels[status] || status;
}

// Format timestamp to relative or absolute time
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  
  return date.toLocaleDateString(undefined, { 
    month: 'short', 
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Attach event listeners to rendered elements
function attachEventListeners() {
  // Batch header toggle
  document.querySelectorAll('.batch-header').forEach(header => {
    header.addEventListener('click', () => {
      const batchEl = header.closest('.batch');
      const batchId = batchEl.dataset.batchId;
      batchEl.classList.toggle('expanded');
      
      // Track expanded state
      if (batchEl.classList.contains('expanded')) {
        expandedBatchIds.add(batchId);
      } else {
        expandedBatchIds.delete(batchId);
      }
    });
  });

  // Individual scene retry buttons
  document.querySelectorAll('.scene-retry').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const batchId = btn.dataset.batchId;
      const sceneId = btn.dataset.sceneId;
      
      btn.disabled = true;
      btn.textContent = '...';
      
      try {
        await browser.runtime.sendMessage({
          action: 'retryScene',
          batchId,
          sceneId
        });
      } catch (error) {
        console.error('[Popup] Retry failed:', error);
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
  });
}

// Retry all failed scenes
retryAllBtn.addEventListener('click', async () => {
  retryAllBtn.disabled = true;
  retryAllBtn.textContent = 'Retrying...';
  
  try {
    await browser.runtime.sendMessage({ action: 'retryAllFailed' });
  } catch (error) {
    console.error('[Popup] Retry all failed:', error);
  }
  
  retryAllBtn.textContent = 'Retry All Failed';
});

// Clear all batches
clearAllBtn.addEventListener('click', async () => {
  try {
    await browser.runtime.sendMessage({ action: 'clearBatches' });
    batches = [];
    renderBatches();
  } catch (error) {
    console.error('[Popup] Clear failed:', error);
  }
});

