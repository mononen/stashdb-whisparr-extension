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
let filters = null;
let expandedBatchIds = new Set();
let expandedFilterCategories = new Set();
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
  const hasTooltip = scene.error || scene.status === 'filtered';
  badge.className = `status-badge ${scene.status}${hasTooltip ? ' error-tooltip' : ''}`;
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

function getStats(scenes) {
  return {
    success: scenes.filter(s => ['added', 'searched', 'exists'].includes(s.status)).length,
    error: scenes.filter(s => s.status === 'error').length,
    filtered: scenes.filter(s => s.status === 'filtered').length,
    pending: scenes.filter(s => ['waiting', 'adding'].includes(s.status)).length
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
    filtered: 'Filtered'
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
  // Batch header toggle
  document.querySelectorAll('.batch-header').forEach(header => {
    header.addEventListener('click', () => {
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

// ============================================
// Filter Management
// ============================================
async function loadFilters() {
  try {
    const response = await browser.runtime.sendMessage({ action: 'getFilters' });
    filters = response?.filters || null;
    renderFilters();
  } catch (error) {
    console.error('[Popup] Error loading filters:', error);
  }
}

function renderFilters() {
  if (!filters) return;
  
  const categories = ['studios', 'performers', 'names', 'tags'];
  let totalFilterCount = 0;
  
  categories.forEach(category => {
    const config = filters[category];
    if (!config) return;
    
    const count = config.values?.length || 0;
    totalFilterCount += count;
    
    // Update count badge
    const countEl = document.querySelector(`[data-count="${category}"]`);
    if (countEl) {
      countEl.textContent = count;
      countEl.style.display = count > 0 ? 'inline' : 'none';
    }
    
    // Update mode select
    const modeSelect = document.querySelector(`select[data-category="${category}"][data-setting="mode"]`);
    if (modeSelect) {
      modeSelect.value = config.mode || 'blocklist';
    }
    
    // Update matchLogic select
    const logicSelect = document.querySelector(`select[data-category="${category}"][data-setting="matchLogic"]`);
    if (logicSelect) {
      logicSelect.value = config.matchLogic || 'or';
    }
    
    // Update chips
    const chipsContainer = document.querySelector(`.filter-chips[data-category="${category}"]`);
    if (chipsContainer) {
      renderFilterChips(chipsContainer, category, config.values || []);
    }
    
    // Restore expanded state
    const categoryEl = document.querySelector(`.filter-category[data-category="${category}"]`);
    if (categoryEl && expandedFilterCategories.has(category)) {
      categoryEl.classList.add('expanded');
    }
  });
  
  // Update filter badge in tab bar
  if (totalFilterCount > 0) {
    filterBadge.textContent = totalFilterCount;
    filterBadge.style.display = 'inline';
  } else {
    filterBadge.style.display = 'none';
  }
}

function renderFilterChips(container, category, values) {
  container.replaceChildren();
  
  if (values.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'filter-empty';
    emptyEl.textContent = 'No filters added';
    container.appendChild(emptyEl);
    return;
  }
  
  values.forEach(value => {
    const chip = document.createElement('div');
    chip.className = 'filter-chip';
    
    const textSpan = document.createElement('span');
    textSpan.textContent = value;
    chip.appendChild(textSpan);
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'filter-chip-remove';
    removeBtn.innerHTML = '&times;';
    removeBtn.dataset.category = category;
    removeBtn.dataset.value = value;
    removeBtn.addEventListener('click', () => removeFilterValue(category, value));
    chip.appendChild(removeBtn);
    
    container.appendChild(chip);
  });
}

function initFilterEventListeners() {
  // Category header toggle
  document.querySelectorAll('.filter-category-header').forEach(header => {
    header.addEventListener('click', () => {
      const categoryEl = header.closest('.filter-category');
      const category = categoryEl.dataset.category;
      categoryEl.classList.toggle('expanded');
      
      if (categoryEl.classList.contains('expanded')) {
        expandedFilterCategories.add(category);
      } else {
        expandedFilterCategories.delete(category);
      }
    });
  });
  
  // Mode and logic select changes
  document.querySelectorAll('.filter-control select').forEach(select => {
    select.addEventListener('change', async () => {
      const category = select.dataset.category;
      const setting = select.dataset.setting;
      const value = select.value;
      
      try {
        const config = {};
        config[setting] = value;
        
        await browser.runtime.sendMessage({
          action: 'updateFilterCategory',
          category,
          config
        });
      } catch (error) {
        console.error('[Popup] Error updating filter setting:', error);
      }
    });
  });
  
  // Add filter buttons
  document.querySelectorAll('.filter-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      const input = document.querySelector(`.filter-add-row input[data-category="${category}"]`);
      const value = input?.value?.trim();
      
      if (value) {
        addFilterValue(category, value);
        input.value = '';
      }
    });
  });
  
  // Enter key on filter inputs
  document.querySelectorAll('.filter-add-row input').forEach(input => {
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const category = input.dataset.category;
        const value = input.value.trim();
        
        if (value) {
          addFilterValue(category, value);
          input.value = '';
        }
      }
    });
  });
  
  // Reset filters button
  resetFiltersBtn.addEventListener('click', async () => {
    if (confirm('Reset all filters to defaults?')) {
      try {
        const response = await browser.runtime.sendMessage({ action: 'resetFilters' });
        if (response?.filters) {
          filters = response.filters;
          renderFilters();
        }
      } catch (error) {
        console.error('[Popup] Error resetting filters:', error);
      }
    }
  });
}

async function addFilterValue(category, value) {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'addFilterValue',
      category,
      value
    });
    
    if (response?.filters) {
      filters = response.filters;
      renderFilters();
    }
  } catch (error) {
    console.error('[Popup] Error adding filter value:', error);
  }
}

async function removeFilterValue(category, value) {
  try {
    const response = await browser.runtime.sendMessage({
      action: 'removeFilterValue',
      category,
      value
    });
    
    if (response?.filters) {
      filters = response.filters;
      renderFilters();
    }
  } catch (error) {
    console.error('[Popup] Error removing filter value:', error);
  }
}
