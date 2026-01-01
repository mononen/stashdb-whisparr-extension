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
    batchList.innerHTML = '';
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

  // Render batches (newest first)
  batchList.innerHTML = batches
    .slice()
    .reverse()
    .map(batch => renderBatch(batch, expandedBatchIds.has(batch.id)))
    .join('');

  // Attach event listeners
  attachEventListeners();
}

// Render a single batch
function renderBatch(batch, expanded = false) {
  const stats = getStats(batch.scenes);
  const time = formatTime(batch.timestamp);
  
  return `
    <div class="batch ${expanded ? 'expanded' : ''}" data-batch-id="${batch.id}">
      <div class="batch-header">
        <div>
          <span class="batch-time">${time}</span>
          <div class="batch-stats">
            ${stats.success > 0 ? `<span class="batch-stat success">${stats.success} done</span>` : ''}
            ${stats.error > 0 ? `<span class="batch-stat error">${stats.error} failed</span>` : ''}
            ${stats.pending > 0 ? `<span class="batch-stat pending">${stats.pending} pending</span>` : ''}
          </div>
        </div>
        <svg class="chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </div>
      <div class="batch-scenes">
        ${batch.scenes.map(scene => renderScene(batch.id, scene)).join('')}
      </div>
    </div>
  `;
}

// Render a single scene row
function renderScene(batchId, scene) {
  const shortId = scene.stashId.substring(0, 8);
  const showRetry = scene.status === 'error';
  const errorTooltip = scene.error ? `data-error="${escapeHtml(scene.error)}"` : '';
  
  return `
    <div class="scene" data-scene-id="${scene.stashId}">
      <div class="scene-info">
        <div class="scene-title">${escapeHtml(scene.title || 'Unknown Scene')}</div>
        <div class="scene-id">${shortId}...</div>
      </div>
      <span class="status-badge ${scene.status} ${scene.error ? 'error-tooltip' : ''}" ${errorTooltip}>
        ${getStatusLabel(scene.status)}
      </span>
      ${showRetry ? `
        <button class="scene-retry" data-batch-id="${batchId}" data-scene-id="${scene.stashId}">
          Retry
        </button>
      ` : ''}
    </div>
  `;
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

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

