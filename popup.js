// Popup script for batch status display and filter management

// ============================================
// DOM Elements
// ============================================
const content = document.getElementById('content');
const batchList = document.getElementById('batchList');
const emptyState = document.getElementById('emptyState');
const footer = document.getElementById('footer');
const retryAllBtn = document.getElementById('retryAllBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const notificationsToggle = document.getElementById('notificationsToggle');
const filterBadge = document.getElementById('filterBadge');
const resetFiltersBtn = document.getElementById('resetFiltersBtn');

// ============================================
// State
// ============================================
let batches = [];
let filters = [];  // Now an array of individual filter objects
let expandedBatchIds = new Set();
let isFirstRender = true;

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    loadBatchStatus(),
    loadFilters(),
    loadNotificationSetting()
  ]);
  
  initTabNavigation();
  initFilterEventListeners();
  
  // Listen for real-time updates from background script
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'batchStatusUpdate') {
      batches = message.batches || [];
      renderBatches();
    }
    if (message.action === 'filterUpdate') {
      filters = message.filters;
      renderFilters();
    }
  });
});

// ============================================
// Tab Navigation
// ============================================
function initTabNavigation() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.dataset.tab;
      
      // Update button states
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Update tab content visibility
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(`${tabId}Tab`).classList.add('active');
    });
  });
}

// ============================================
// Notification Settings
// ============================================
async function loadNotificationSetting() {
  const data = await browser.storage.local.get({ notificationsEnabled: true });
  notificationsToggle.checked = data.notificationsEnabled;
}

notificationsToggle.addEventListener('change', async () => {
  await browser.storage.local.set({ notificationsEnabled: notificationsToggle.checked });
});

// ============================================
// Batch Management
// ============================================
async function loadBatchStatus() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getBatchStatus' });
    batches = response?.batches || [];
    renderBatches();
  } catch (error) {
    console.error('[Popup] Error loading batch status:', error);
  }
}

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
  attachBatchEventListeners();
}

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
  if (stats.filtered > 0) {
    const filteredStat = document.createElement('span');
    filteredStat.className = 'batch-stat filtered';
    filteredStat.textContent = `${stats.filtered} filtered`;
    statsDiv.appendChild(filteredStat);
  }
  if (stats.pending > 0) {
    const pendingStat = document.createElement('span');
    pendingStat.className = 'batch-stat pending';
    pendingStat.textContent = `${stats.pending} pending`;
    statsDiv.appendChild(pendingStat);
  }
  if (stats.cancelled > 0) {
    const cancelledStat = document.createElement('span');
    cancelledStat.className = 'batch-stat cancelled';
    cancelledStat.textContent = `${stats.cancelled} cancelled`;
    statsDiv.appendChild(cancelledStat);
  }
  if (stats.removed > 0) {
    const removedStat = document.createElement('span');
    removedStat.className = 'batch-stat removed';
    removedStat.textContent = `${stats.removed} removed`;
    statsDiv.appendChild(removedStat);
  }
  headerInfo.appendChild(statsDiv);
  header.appendChild(headerInfo);
  
  // Add cancel button if there are pending scenes
  if (stats.pending > 0) {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'batch-cancel';
    cancelBtn.dataset.batchId = batch.id;
    cancelBtn.textContent = 'Cancel';
    cancelBtn.title = 'Cancel remaining scenes';
    header.appendChild(cancelBtn);
  }

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

function renderScene(batchId, scene) {
  const shortId = scene.stashId.substring(0, 8);
  const showRetry = scene.status === 'error';
  const showUndo = ['added', 'searched'].includes(scene.status);
  
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
  badge.className = `status-badge ${scene.status}`;
  badge.textContent = getStatusLabel(scene.status);
  
  // Add native title tooltip for error/filter reasons
  if (scene.error) {
    badge.title = scene.error;
  }
  
  sceneEl.appendChild(badge);

  if (showRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.className = 'scene-retry';
    retryBtn.dataset.batchId = batchId;
    retryBtn.dataset.sceneId = scene.stashId;
    retryBtn.textContent = 'Retry';
    sceneEl.appendChild(retryBtn);
  }

  if (showUndo) {
    const undoBtn = document.createElement('button');
    undoBtn.className = 'scene-undo';
    undoBtn.dataset.batchId = batchId;
    undoBtn.dataset.sceneId = scene.stashId;
    undoBtn.textContent = 'Undo';
    undoBtn.title = 'Remove from Whisparr';
    sceneEl.appendChild(undoBtn);
  }

  return sceneEl;
}

function getStats(scenes) {
  return {
    success: scenes.filter(s => ['added', 'searched', 'exists'].includes(s.status)).length,
    error: scenes.filter(s => s.status === 'error').length,
    filtered: scenes.filter(s => s.status === 'filtered').length,
    pending: scenes.filter(s => ['waiting', 'adding'].includes(s.status)).length,
    cancelled: scenes.filter(s => s.status === 'cancelled').length,
    removed: scenes.filter(s => s.status === 'removed').length
  };
}

function getStatusLabel(status) {
  const labels = {
    waiting: 'Waiting',
    adding: 'Adding...',
    added: 'Added',
    searched: 'Searched',
    exists: 'Exists',
    error: 'Error',
    filtered: 'Filtered',
    cancelled: 'Cancelled',
    removing: 'Removing...',
    removed: 'Removed'
  };
  return labels[status] || status;
}

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

function attachBatchEventListeners() {
  // Batch header toggle (but not when clicking cancel button)
  document.querySelectorAll('.batch-header').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle if clicking cancel button
      if (e.target.classList.contains('batch-cancel')) return;
      
      const batchEl = header.closest('.batch');
      const batchId = batchEl.dataset.batchId;
      batchEl.classList.toggle('expanded');
      
      if (batchEl.classList.contains('expanded')) {
        expandedBatchIds.add(batchId);
      } else {
        expandedBatchIds.delete(batchId);
      }
    });
  });

  // Batch cancel buttons
  document.querySelectorAll('.batch-cancel').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const batchId = btn.dataset.batchId;
      
      btn.disabled = true;
      btn.textContent = 'Cancelling...';
      
      try {
        await browser.runtime.sendMessage({
          action: 'cancelBatch',
          batchId
        });
      } catch (error) {
        console.error('[Popup] Cancel failed:', error);
        btn.disabled = false;
        btn.textContent = 'Cancel';
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

  // Individual scene undo buttons
  document.querySelectorAll('.scene-undo').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const batchId = btn.dataset.batchId;
      const sceneId = btn.dataset.sceneId;
      
      btn.disabled = true;
      btn.textContent = '...';
      
      try {
        await browser.runtime.sendMessage({
          action: 'undoScene',
          batchId,
          sceneId
        });
      } catch (error) {
        console.error('[Popup] Undo failed:', error);
        btn.disabled = false;
        btn.textContent = 'Undo';
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

// ============================================
// Filter Management (Individual Filter Cards)
// ============================================

const filterList = document.getElementById('filterList');
const filterEmpty = document.getElementById('filterEmpty');
const addFilterBtn = document.getElementById('addFilterBtn');

async function loadFilters() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getFilters' });
    filters = response?.filters || [];
    renderFilters();
  } catch (error) {
    console.error('[Popup] Error loading filters:', error);
  }
}

function renderFilters() {
  // Ensure filters is an array
  if (!Array.isArray(filters)) {
    filters = [];
  }
  
  // Update filter badge in tab bar
  const enabledCount = filters.filter(f => f.enabled).length;
  if (filters.length > 0) {
    filterBadge.textContent = enabledCount;
    filterBadge.style.display = 'inline';
  } else {
    filterBadge.style.display = 'none';
  }
  
  // Show/hide empty state
  if (filters.length === 0) {
    filterEmpty.style.display = 'block';
    // Remove all filter cards
    filterList.querySelectorAll('.filter-card').forEach(card => card.remove());
    return;
  }
  
  filterEmpty.style.display = 'none';
  
  // Render filter cards
  const fragment = document.createDocumentFragment();
  filters.forEach(filter => {
    fragment.appendChild(renderFilterCard(filter));
  });
  
  // Replace existing cards
  filterList.querySelectorAll('.filter-card').forEach(card => card.remove());
  filterList.appendChild(fragment);
}

function renderFilterCard(filter) {
  const card = document.createElement('div');
  card.className = `filter-card${filter.enabled ? '' : ' disabled'}`;
  card.dataset.filterId = filter.id;
  
  // Header row: Toggle, Type dropdown, Mode button, Delete button
  const header = document.createElement('div');
  header.className = 'filter-card-header';
  
  // Enable/Disable toggle
  const toggle = document.createElement('label');
  toggle.className = 'filter-toggle';
  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.checked = filter.enabled;
  toggleInput.addEventListener('change', () => toggleFilter(filter.id));
  toggle.appendChild(toggleInput);
  const toggleSlider = document.createElement('span');
  toggleSlider.className = 'filter-toggle-slider';
  toggle.appendChild(toggleSlider);
  header.appendChild(toggle);
  
  // Type dropdown
  const typeSelect = document.createElement('select');
  typeSelect.className = 'filter-type-select';
  ['studio', 'performer', 'name', 'tag'].forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type.charAt(0).toUpperCase() + type.slice(1);
    if (filter.type === type) option.selected = true;
    typeSelect.appendChild(option);
  });
  typeSelect.addEventListener('change', () => updateFilter(filter.id, { type: typeSelect.value }));
  header.appendChild(typeSelect);
  
  // Mode button (Block/Allow toggle)
  const modeBtn = document.createElement('button');
  modeBtn.className = `filter-mode-btn${filter.mode === 'allowlist' ? ' allowlist' : ''}`;
  modeBtn.textContent = filter.mode === 'allowlist' ? 'Allow' : 'Block';
  modeBtn.addEventListener('click', () => {
    const newMode = filter.mode === 'blocklist' ? 'allowlist' : 'blocklist';
    updateFilter(filter.id, { mode: newMode });
  });
  header.appendChild(modeBtn);
  
  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'filter-delete-btn';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.title = 'Delete filter';
  deleteBtn.addEventListener('click', () => deleteFilter(filter.id));
  header.appendChild(deleteBtn);
  
  card.appendChild(header);
  
  // Body row: Regex input
  const body = document.createElement('div');
  body.className = 'filter-card-body';
  
  // Regex input
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'filter-value-input';
  input.placeholder = 'Enter regex pattern (e.g., ^studio.*, keyword|other)';
  input.value = filter.value || '';
  
  // Validate regex on input
  input.addEventListener('input', () => {
    const isValid = validateRegex(input.value);
    input.classList.remove('valid', 'invalid');
    if (input.value.trim()) {
      input.classList.add(isValid ? 'valid' : 'invalid');
    }
  });
  
  // Save on blur or enter
  input.addEventListener('blur', () => {
    if (input.value !== filter.value) {
      updateFilter(filter.id, { value: input.value });
    }
  });
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      input.blur();
    }
  });
  
  body.appendChild(input);
  
  // Regex indicator
  const regexIndicator = document.createElement('span');
  regexIndicator.className = 'regex-indicator';
  regexIndicator.textContent = '/.../';
  regexIndicator.title = 'Regex pattern';
  body.appendChild(regexIndicator);
  
  card.appendChild(body);
  
  return card;
}

function validateRegex(pattern) {
  if (!pattern || pattern.trim() === '') return true;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch (e) {
    return false;
  }
}

function initFilterEventListeners() {
  // Add filter button
  addFilterBtn.addEventListener('click', addNewFilter);
  
  // Reset filters button
  resetFiltersBtn.addEventListener('click', async () => {
    if (filters.length === 0) return;
    
    if (confirm('Delete all filters?')) {
      try {
        const response = await browser.runtime.sendMessage({ action: 'resetFilters' });
        if (response?.success) {
          filters = response.filters || [];
          renderFilters();
        }
      } catch (error) {
        console.error('[Popup] Error resetting filters:', error);
      }
    }
  });
}

async function addNewFilter() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'addFilter' });
    if (response?.success && response.filters) {
      filters = response.filters;
      renderFilters();
      
      // Focus the new filter's input
      const newCard = filterList.querySelector(`[data-filter-id="${response.newFilter.id}"]`);
      if (newCard) {
        const input = newCard.querySelector('.filter-value-input');
        if (input) {
          setTimeout(() => input.focus(), 50);
        }
      }
    }
  } catch (error) {
    console.error('[Popup] Error adding filter:', error);
  }
}

async function updateFilter(filterId, updates) {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'updateFilter',
      filterId,
      updates
    });
    
    if (response?.success && response.filters) {
      filters = response.filters;
      renderFilters();
    }
  } catch (error) {
    console.error('[Popup] Error updating filter:', error);
  }
}

async function toggleFilter(filterId) {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'toggleFilter',
      filterId
    });
    
    if (response?.success && response.filters) {
      filters = response.filters;
      renderFilters();
    }
  } catch (error) {
    console.error('[Popup] Error toggling filter:', error);
  }
}

async function deleteFilter(filterId) {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'deleteFilter',
      filterId
    });
    
    if (response?.success && response.filters) {
      filters = response.filters;
      renderFilters();
    }
  } catch (error) {
    console.error('[Popup] Error deleting filter:', error);
  }
}
