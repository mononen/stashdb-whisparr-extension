// ============================================
// Batch State Management
// ============================================

// In-memory cache of batches (also persisted to storage)
let batchesCache = [];

// Cancellation flag for in-progress batch operations
let cancelledBatchIds = new Set();

// Load batches from storage on startup
async function loadBatches() {
  const data = await browser.storage.local.get({ batches: [] });
  batchesCache = data.batches || [];
  return batchesCache;
}

// Save batches to storage and broadcast update
async function saveBatches() {
  await browser.storage.local.set({ batches: batchesCache });
  broadcastBatchUpdate();
}

// Broadcast batch status update to popup
function broadcastBatchUpdate() {
  browser.runtime.sendMessage({
    action: 'batchStatusUpdate',
    batches: batchesCache
  }).catch(() => {
    // Popup might not be open, ignore error
  });
}

// Create a new batch
function createBatch(stashIds) {
  const batch = {
    id: `batch-${Date.now()}`,
    timestamp: Date.now(),
    scenes: stashIds.map(stashId => ({
      stashId,
      title: null,
      status: 'waiting',
      error: null
    }))
  };
  batchesCache.push(batch);
  saveBatches();
  return batch;
}

// Update a scene's status in a batch
function updateSceneStatus(batchId, stashId, updates) {
  const batch = batchesCache.find(b => b.id === batchId);
  if (batch) {
    const scene = batch.scenes.find(s => s.stashId === stashId);
    if (scene) {
      Object.assign(scene, updates);
      saveBatches();
    }
  }
}

// Load batches on extension load
loadBatches();

// ============================================
// Filter State Management
// ============================================

// Default filters is now an empty array (individual filters)
const defaultFilters = [];

// In-memory cache of filters (array of filter objects)
let filtersCache = [];

/**
 * Create a new filter object with defaults
 * @returns {Object} New filter object
 */
function createNewFilter() {
  return {
    id: `filter-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: 'studio',  // studio, performer, name, tag
    mode: 'blocklist',  // blocklist, allowlist
    value: '',  // regex pattern
    enabled: true
  };
}

// Load filters from storage on startup
async function loadFilters() {
  const data = await browser.storage.local.get({ filters: defaultFilters });
  // Handle migration from old format to new format
  if (Array.isArray(data.filters)) {
    filtersCache = data.filters;
  } else if (typeof data.filters === 'object' && data.filters !== null) {
    // Migrate from old category-based format
    filtersCache = migrateOldFilters(data.filters);
    // Save migrated filters
    await browser.storage.local.set({ filters: filtersCache });
  } else {
    filtersCache = [];
  }
  return filtersCache;
}

/**
 * Migrate from old category-based filter format to new array format
 */
function migrateOldFilters(oldFilters) {
  const newFilters = [];
  const categories = ['studios', 'performers', 'names', 'tags'];
  const typeMap = { studios: 'studio', performers: 'performer', names: 'name', tags: 'tag' };
  
  for (const category of categories) {
    const config = oldFilters[category];
    if (config && config.values && config.values.length > 0) {
      for (const value of config.values) {
        newFilters.push({
          id: `filter-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: typeMap[category],
          mode: config.mode || 'blocklist',
          value: escapeRegex(value),  // Convert plain text to regex-safe
          enabled: true
        });
      }
    }
  }
  
  console.log("[StashDB-Whisparr] Migrated", newFilters.length, "filters from old format");
  return newFilters;
}

/**
 * Escape special regex characters for plain text matching
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Save filters to storage and broadcast update
async function saveFilters() {
  await browser.storage.local.set({ filters: filtersCache });
  broadcastFilterUpdate();
}

// Broadcast filter update to popup
function broadcastFilterUpdate() {
  browser.runtime.sendMessage({
    action: 'filterUpdate',
    filters: filtersCache
  }).catch(() => {
    // Popup might not be open, ignore error
  });
}

// Load filters on extension load
loadFilters();

// ============================================
// Filter Evaluation Logic (Array-based with Regex)
// ============================================

/**
 * Normalize metadata from either scraped StashDB data or Whisparr lookup data
 * @param {Object} sceneData - Scene data (from scraping or Whisparr lookup)
 * @returns {Object} Normalized metadata { studio, performers, tags, title }
 */
function normalizeSceneMetadata(sceneData) {
  // Handle scraped metadata format (from content script)
  if (sceneData.stashId && (sceneData.studio !== undefined || sceneData.performers !== undefined)) {
    return {
      studio: sceneData.studio || '',
      performers: sceneData.performers || [],
      tags: sceneData.tags || [],
      title: sceneData.title || ''
    };
  }
  
  // Handle Whisparr lookup format (fallback)
  const studio = sceneData.studio?.title || sceneData.studioTitle || '';
  const performers = (sceneData.credits || [])
    .filter(c => c.creditType === 'Actor' || c.type === 'Actor')
    .map(c => c.name || c.personName || '')
    .filter(Boolean);
  const tags = sceneData.genres || [];
  const title = sceneData.title || '';
  
  return { studio, performers, tags, title };
}

/**
 * Get the scene value(s) for a given filter type
 * @param {string} filterType - The filter type (studio, performer, name, tag)
 * @param {Object} metadata - Normalized scene metadata
 * @returns {string|Array} The value(s) to test against
 */
function getSceneValueByType(filterType, metadata) {
  switch (filterType) {
    case 'studio':
      return metadata.studio || '';
    case 'performer':
      return metadata.performers || [];
    case 'name':
      return metadata.title || '';
    case 'tag':
      return metadata.tags || [];
    default:
      return '';
  }
}

/**
 * Test if a regex pattern matches a value or any item in an array
 * @param {RegExp} regex - The regex pattern to test
 * @param {string|Array} value - The value(s) to test
 * @returns {boolean} True if regex matches
 */
function regexMatchesValue(regex, value) {
  if (Array.isArray(value)) {
    return value.some(v => regex.test(v || ''));
  }
  return regex.test(value || '');
}

/**
 * Evaluate a single filter against scene metadata
 * @param {Object} filter - The filter object
 * @param {Object} metadata - Normalized scene metadata
 * @returns {Object} { pass: boolean, reason: string|null }
 */
function evaluateFilter(filter, metadata) {
  // Skip disabled filters
  if (!filter.enabled) {
    return { pass: true, reason: null };
  }
  
  // Skip filters with empty values
  if (!filter.value || filter.value.trim() === '') {
    return { pass: true, reason: null };
  }
  
  // Get the scene value for this filter type
  const sceneValue = getSceneValueByType(filter.type, metadata);
  
  // Try to create regex from filter value
  let regex;
  try {
    regex = new RegExp(filter.value, 'i');
  } catch (e) {
    console.warn("[StashDB-Whisparr] Invalid regex in filter:", filter.value, e);
    return { pass: true, reason: null };  // Skip invalid regex
  }
  
  // Test if the regex matches
  const matches = regexMatchesValue(regex, sceneValue);
  
  // Get display name for the type
  const typeLabel = filter.type.charAt(0).toUpperCase() + filter.type.slice(1);
  
  if (filter.mode === 'blocklist') {
    // Blocklist: FAIL if regex matches
    if (matches) {
      return { 
        pass: false, 
        reason: `Blocked ${typeLabel}: /${filter.value}/` 
      };
    }
  } else {
    // Allowlist: FAIL if regex doesn't match
    if (!matches) {
      return { 
        pass: false, 
        reason: `${typeLabel} doesn't match: /${filter.value}/` 
      };
    }
  }
  
  return { pass: true, reason: null };
}

/**
 * Check if a scene should be added based on all filters
 * @param {Object} sceneData - Scene data (scraped metadata or Whisparr lookup)
 * @returns {Object} { shouldAdd: boolean, reason: string|null, filterId: string|null }
 */
function shouldAddScene(sceneData) {
  const metadata = normalizeSceneMetadata(sceneData);
  
  console.log("[StashDB-Whisparr] Evaluating filters for scene:", metadata.title || sceneData.stashId);
  console.log("[StashDB-Whisparr] Scene metadata:", metadata);
  console.log("[StashDB-Whisparr] Active filters:", filtersCache.length);
  
  // If no filters, allow everything
  if (!filtersCache || filtersCache.length === 0) {
    console.log("[StashDB-Whisparr] No filters configured, allowing scene");
    return { shouldAdd: true, reason: null, filterId: null };
  }
  
  // Evaluate each filter in order
  for (const filter of filtersCache) {
    const result = evaluateFilter(filter, metadata);
    if (!result.pass) {
      console.log("[StashDB-Whisparr] Scene blocked by filter:", filter.id, result.reason);
      return { shouldAdd: false, reason: result.reason, filterId: filter.id };
    }
  }
  
  console.log("[StashDB-Whisparr] Scene passed all filters");
  return { shouldAdd: true, reason: null, filterId: null };
}

// ============================================
// Context Menu Setup
// ============================================

// Create context menu item when extension is installed
browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: "add-to-whisparr",
    title: "Add to Whisparr",
    contexts: ["page", "link"],
    documentUrlPatterns: [
      "*://stashdb.org/*"
    ]
  });
});

// Handle context menu click
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  console.log("[StashDB-Whisparr] Context menu clicked:", info.menuItemId);
  console.log("[StashDB-Whisparr] Click info:", { linkUrl: info.linkUrl, pageUrl: tab.url });
  
  if (info.menuItemId === "add-to-whisparr") {
    try {
      // Case 1: Right-clicked on a scene link
      if (info.linkUrl && info.linkUrl.includes("/scenes/")) {
        const stashId = extractStashId(info.linkUrl);
        if (stashId) {
          console.log("[StashDB-Whisparr] Adding scene from clicked link:", stashId);
          // Get metadata from the clicked element specifically
          const metadataResponse = await browser.tabs.sendMessage(tab.id, { 
            action: "getClickedSceneMetadata", 
            stashId 
          });
          const sceneMetadata = metadataResponse?.metadata || { stashId };
          console.log("[StashDB-Whisparr] Got metadata for clicked scene:", sceneMetadata);
          await addSingleSceneWithMetadata(stashId, sceneMetadata, tab.id);
          return;
        }
      }
      
      // Case 2: On a scene detail page - add the current scene
      if (tab.url.match(/stashdb\.org\/scenes\/[a-f0-9-]+/i)) {
        const stashId = extractStashId(tab.url);
        if (stashId) {
          console.log("[StashDB-Whisparr] Adding scene from page URL:", stashId);
          // Get metadata from the current scene detail page
          const metadataResponse = await browser.tabs.sendMessage(tab.id, { action: "getCurrentSceneMetadata" });
          const sceneMetadata = metadataResponse?.metadata || { stashId };
          await addSingleSceneWithMetadata(stashId, sceneMetadata, tab.id);
          return;
        }
      }
      
      // Case 3: On another page (performers, studios, tags, etc.) - get all scenes with metadata
      console.log("[StashDB-Whisparr] Querying content script for all scenes with metadata...");
      const response = await browser.tabs.sendMessage(tab.id, { action: "getAllScenesWithMetadata" });
      
      if (!response || !response.scenes || response.scenes.length === 0) {
        showNotification("No Scenes", "No scene links found on this page");
        return;
      }
      
      const scenes = response.scenes;
      console.log("[StashDB-Whisparr] Found", scenes.length, "scenes with metadata");
      
      // Show confirmation popup
      const confirmed = await showConfirmationPopup(scenes.length, tab.id);
      if (!confirmed) {
        console.log("[StashDB-Whisparr] User cancelled bulk add");
        return;
      }
      
      // Add all scenes with their metadata (filtering happens before API calls)
      await addMultipleScenesWithMetadata(scenes);
      
    } catch (error) {
      console.error("[StashDB-Whisparr] Error:", error);
      showNotification("Error", error.message);
    }
  }
});

// Add a single scene to Whisparr with pre-filtering (no Whisparr API call if filtered)
async function addSingleSceneWithMetadata(stashId, metadata, tabId) {
  // Create a batch with single scene for tracking
  const batch = createBatch([stashId]);
  
  // Get title from metadata for display
  const scrapedTitle = metadata?.title || null;
  
  // PRE-FILTER: Check filters BEFORE any Whisparr API call
  const filterResult = shouldAddScene(metadata);
  if (!filterResult.shouldAdd) {
    console.log("[StashDB-Whisparr] Scene pre-filtered (no API call):", filterResult.reason);
    updateSceneStatus(batch.id, stashId, { status: 'filtered', title: scrapedTitle, error: filterResult.reason });
    showNotification("Filtered", `Scene skipped: ${filterResult.reason}`);
    return;
  }
  
  // Update status to adding (scene passed filters)
  updateSceneStatus(batch.id, stashId, { status: 'adding', title: scrapedTitle });
  
  try {
    const result = await addSceneToWhisparr(stashId);
    const title = result?.title || result?.movie?.title || scrapedTitle;
    console.log("[StashDB-Whisparr] Result:", result);
    
    if (result && result.searched) {
      updateSceneStatus(batch.id, stashId, { status: 'searched', title, error: null });
      showNotification("Searching", `Scene already in Whisparr - search triggered`);
    } else if (result && result.exists) {
      updateSceneStatus(batch.id, stashId, { status: 'exists', title, error: null });
      showNotification("Exists", `Scene already exists with file`);
    } else {
      updateSceneStatus(batch.id, stashId, { status: 'added', title, error: null });
      showNotification("Success", `Scene added to Whisparr`);
    }
  } catch (error) {
    console.error("[StashDB-Whisparr] Error:", error);
    if (error.message.includes("already exists") || error.message.includes("File already exists")) {
      updateSceneStatus(batch.id, stashId, { status: 'exists', title: error.sceneTitle || scrapedTitle, error: null });
      showNotification("Exists", `Scene already exists with file`);
    } else {
      updateSceneStatus(batch.id, stashId, { status: 'error', title: error.sceneTitle || scrapedTitle, error: error.message });
      showNotification("Error", error.message);
    }
  }
}

// Add multiple scenes with pre-filtering (no Whisparr API calls for filtered scenes)
async function addMultipleScenesWithMetadata(scenes) {
  const total = scenes.length;
  let added = 0;
  let searched = 0;
  let failed = 0;
  let alreadyExists = 0;
  let filtered = 0;
  
  // PRE-FILTER: Check all scenes BEFORE any Whisparr API calls
  const scenesToProcess = [];
  const filteredScenes = [];
  
  for (const scene of scenes) {
    const filterResult = shouldAddScene(scene);
    if (filterResult.shouldAdd) {
      scenesToProcess.push(scene);
    } else {
      filteredScenes.push({ scene, reason: filterResult.reason });
      filtered++;
    }
  }
  
  console.log(`[StashDB-Whisparr] Pre-filter: ${scenesToProcess.length} to process, ${filtered} filtered out`);
  
  // Create batch for tracking (all scenes, including filtered ones)
  const allStashIds = scenes.map(s => s.stashId);
  const batch = createBatch(allStashIds);
  
  // Immediately mark filtered scenes as filtered (no API call needed)
  for (const { scene, reason } of filteredScenes) {
    updateSceneStatus(batch.id, scene.stashId, { 
      status: 'filtered', 
      title: scene.title || null, 
      error: reason 
    });
  }
  
  // Only process scenes that passed filters
  const toProcessCount = scenesToProcess.length;
  
  if (toProcessCount === 0) {
    // All scenes were filtered, show summary immediately
    await showProgressNotification("whisparr-bulk-progress", "Complete", `${filtered} scenes filtered`);
    console.log("[StashDB-Whisparr] Bulk add complete: all scenes filtered");
    return;
  }
  
  // Create initial progress notification
  const notificationId = "whisparr-bulk-progress";
  await showProgressNotification(notificationId, "Adding Scenes", `Adding scene 1 of ${toProcessCount}...`);
  
  let cancelled = 0;
  
  for (let i = 0; i < scenesToProcess.length; i++) {
    const scene = scenesToProcess[i];
    const stashId = scene.stashId;
    const scrapedTitle = scene.title || null;
    
    // Check if batch was cancelled
    if (cancelledBatchIds.has(batch.id)) {
      // Mark remaining scenes as cancelled
      for (let j = i; j < scenesToProcess.length; j++) {
        const remainingScene = scenesToProcess[j];
        updateSceneStatus(batch.id, remainingScene.stashId, { 
          status: 'cancelled', 
          title: remainingScene.title || null, 
          error: 'Cancelled by user' 
        });
        cancelled++;
      }
      cancelledBatchIds.delete(batch.id);
      break;
    }
    
    // Update scene status to 'adding'
    updateSceneStatus(batch.id, stashId, { status: 'adding', title: scrapedTitle });
    
    // Update progress notification
    await showProgressNotification(notificationId, "Adding Scenes", `Adding scene ${i + 1} of ${toProcessCount}...`);
    
    try {
      const result = await addSceneToWhisparr(stashId);
      const title = result?.title || result?.movie?.title || scrapedTitle;
      
      if (result && result.searched) {
        searched++;
        updateSceneStatus(batch.id, stashId, { status: 'searched', title, error: null, whisparrId: result.movie?.id });
      } else if (result && result.exists) {
        alreadyExists++;
        updateSceneStatus(batch.id, stashId, { status: 'exists', title, error: null });
      } else {
        added++;
        updateSceneStatus(batch.id, stashId, { status: 'added', title, error: null, whisparrId: result?.id });
      }
    } catch (error) {
      console.error(`[StashDB-Whisparr] Failed to add scene ${stashId}:`, error);
      if (error.message.includes("already exists") || error.message.includes("File already exists")) {
        alreadyExists++;
        updateSceneStatus(batch.id, stashId, { status: 'exists', title: error.sceneTitle || scrapedTitle, error: null });
      } else {
        failed++;
        updateSceneStatus(batch.id, stashId, { status: 'error', title: error.sceneTitle || scrapedTitle, error: error.message });
      }
    }
    
    // Small delay to avoid overwhelming the server
    if (i < scenesToProcess.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Show final summary
  const parts = [];
  if (added > 0) parts.push(`${added} added`);
  if (searched > 0) parts.push(`${searched} search triggered`);
  if (alreadyExists > 0) parts.push(`${alreadyExists} already exist`);
  if (filtered > 0) parts.push(`${filtered} filtered`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  if (failed > 0) parts.push(`${failed} failed`);
  
  const summary = parts.length > 0 ? parts.join(", ") : "No changes";
  
  await showProgressNotification(notificationId, cancelled > 0 ? "Cancelled" : "Complete", summary);
  
  console.log("[StashDB-Whisparr] Bulk add complete:", summary);
}

// Show or update a progress notification (clears and recreates since update() isn't available)
async function showProgressNotification(notificationId, title, message) {
  // Check if notifications are enabled
  const data = await browser.storage.local.get({ notificationsEnabled: true });
  if (!data.notificationsEnabled) {
    console.log("[StashDB-Whisparr] Progress notification suppressed (disabled):", title, "-", message);
    return;
  }
  
  // Clear any existing notification with this ID
  await browser.notifications.clear(notificationId).catch(() => {});
  
  // Create the notification
  await browser.notifications.create(notificationId, {
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.svg"),
    title: title,
    message: message
  });
}

// Show confirmation popup and return whether user confirmed
async function showConfirmationPopup(sceneCount, tabId) {
  return new Promise((resolve) => {
    const popupUrl = browser.runtime.getURL(`confirm.html?count=${sceneCount}`);
    
    browser.windows.create({
      url: popupUrl,
      type: "popup",
      width: 400,
      height: 200
    }).then((popupWindow) => {
      // Listen for the popup response
      const messageListener = (message, sender) => {
        if (message.action === "confirmBulkAdd") {
          browser.runtime.onMessage.removeListener(messageListener);
          browser.windows.remove(popupWindow.id).catch(() => {});
          resolve(message.confirmed);
        }
      };
      
      browser.runtime.onMessage.addListener(messageListener);
      
      // Also handle window close without confirming
      const windowListener = (windowId) => {
        if (windowId === popupWindow.id) {
          browser.windows.onRemoved.removeListener(windowListener);
          browser.runtime.onMessage.removeListener(messageListener);
          resolve(false);
        }
      };
      
      browser.windows.onRemoved.addListener(windowListener);
    });
  });
}

// Extract StashID (UUID) from URL
function extractStashId(url) {
  const match = url.match(/\/scenes\/([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

// Get settings from storage
async function getSettings() {
  const defaults = {
    whisparrUrl: "",
    apiKey: "",
    rootFolderPath: "",
    qualityProfileId: 1,
    searchForMovie: true,
    monitored: true
  };
  
  const stored = await browser.storage.sync.get(defaults);
  return stored;
}

// Add scene to Whisparr
async function addSceneToWhisparr(stashId) {
  const settings = await getSettings();
  
  if (!settings.whisparrUrl || !settings.apiKey) {
    throw new Error("Please configure Whisparr settings in extension options");
  }

  // Normalize the URL (remove trailing slash)
  const baseUrl = settings.whisparrUrl.replace(/\/$/, "");
  
  // First, lookup the scene from StashDB via Whisparr's lookup endpoint
  const lookupEndpoint = `${baseUrl}/api/v3/lookup/scene?term=${stashId}`;
  
  console.log("[StashDB-Whisparr] Looking up scene:", lookupEndpoint);
  
  const lookupResponse = await fetch(lookupEndpoint, {
    method: "GET",
    headers: {
      "X-Api-Key": settings.apiKey,
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  if (!lookupResponse.ok) {
    const errorText = await lookupResponse.text();
    console.error("[StashDB-Whisparr] Lookup failed:", lookupResponse.status, errorText);
    throw new Error(`Lookup failed: ${lookupResponse.status} - ${errorText}`);
  }

  const lookupResults = await lookupResponse.json();
  console.log("[StashDB-Whisparr] Lookup results:", lookupResults);

  if (!lookupResults || lookupResults.length === 0) {
    throw new Error("Scene not found on StashDB");
  }

  // Get the first result - the scene data is in the 'movie' property
  const lookupResult = lookupResults[0];
  const sceneData = lookupResult.movie || lookupResult;
  
  console.log("[StashDB-Whisparr] Scene data:", sceneData);
  
  // Note: Filtering now happens BEFORE this function is called (using scraped metadata)
  // This avoids unnecessary Whisparr API calls for filtered scenes
  
  // Add required fields for the POST
  sceneData.monitored = settings.monitored;
  sceneData.qualityProfileId = parseInt(settings.qualityProfileId, 10);
  sceneData.rootFolderPath = settings.rootFolderPath;
  sceneData.addOptions = {
    monitor: "movieOnly",
    searchForMovie: settings.searchForMovie
  };

  // Now add the scene
  const addEndpoint = `${baseUrl}/api/v3/movie`;
  console.log("[StashDB-Whisparr] Adding scene:", addEndpoint, sceneData);

  const response = await fetch(addEndpoint, {
    method: "POST",
    headers: {
      "X-Api-Key": settings.apiKey,
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify(sceneData)
  });

  if (!response.ok) {
    // Check if it's a 400 error (scene already exists)
    if (response.status === 400) {
      console.log("[StashDB-Whisparr] Scene already exists, checking for file...");
      // Pass the lookup result which may contain the movie ID
      return await handleExistingScene(baseUrl, settings.apiKey, stashId, settings.searchForMovie, lookupResult);
    }
    
    const errorText = await response.text();
    console.error("[StashDB-Whisparr] Add failed:", response.status, errorText);
    throw new Error(`Add failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log("[StashDB-Whisparr] Scene added:", result);
  // Include title in result for batch tracking
  result.title = sceneData.title;
  return result;
}

// Handle existing scene - check for file and optionally search
async function handleExistingScene(baseUrl, apiKey, stashId, searchForMovie, lookupResult) {
  let existingMovie = null;
  
  // Try to get the movie directly by ID from lookup result (fastest)
  if (lookupResult && lookupResult.movie && lookupResult.movie.id) {
    const movieId = lookupResult.movie.id;
    console.log("[StashDB-Whisparr] Fetching movie by ID:", movieId);
    
    const movieResponse = await fetch(`${baseUrl}/api/v3/movie/${movieId}`, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    
    if (movieResponse.ok) {
      existingMovie = await movieResponse.json();
      console.log("[StashDB-Whisparr] Found movie by ID:", existingMovie.title);
    }
  }
  
  // Fallback: try querying by foreignId
  if (!existingMovie) {
    console.log("[StashDB-Whisparr] Trying to fetch by foreignId:", stashId);
    
    const movieResponse = await fetch(`${baseUrl}/api/v3/movie?foreignId=${stashId}`, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    
    if (movieResponse.ok) {
      const movies = await movieResponse.json();
      if (Array.isArray(movies) && movies.length > 0) {
        existingMovie = movies[0];
        console.log("[StashDB-Whisparr] Found movie by foreignId:", existingMovie.title);
      }
    }
  }

  if (!existingMovie) {
    throw new Error("Scene exists in Whisparr but could not be found");
  }

  console.log("[StashDB-Whisparr] hasFile:", existingMovie.hasFile);

  // Check if the movie has a file
  if (existingMovie.hasFile) {
    const error = new Error("File already exists");
    error.sceneTitle = existingMovie.title;
    throw error;
  }

  // No file exists - trigger a search if enabled
  if (searchForMovie) {
    console.log("[StashDB-Whisparr] No file found, triggering search...");
    await triggerMovieSearch(baseUrl, apiKey, existingMovie.id);
    return { searched: true, movie: existingMovie, title: existingMovie.title };
  }

  const error = new Error("Scene already in Whisparr but no file downloaded");
  error.sceneTitle = existingMovie.title;
  throw error;
}

// Trigger a search for a specific movie
async function triggerMovieSearch(baseUrl, apiKey, movieId) {
  const commandEndpoint = `${baseUrl}/api/v3/command`;
  
  const response = await fetch(commandEndpoint, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify({
      name: "MoviesSearch",
      movieIds: [movieId]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[StashDB-Whisparr] Search command failed:", response.status, errorText);
    throw new Error(`Search command failed: ${response.status}`);
  }

  const result = await response.json();
  console.log("[StashDB-Whisparr] Search triggered:", result);
  return result;
}

// Show browser notification (respects user preference)
async function showNotification(title, message) {
  // Check if notifications are enabled
  const data = await browser.storage.local.get({ notificationsEnabled: true });
  if (!data.notificationsEnabled) {
    console.log("[StashDB-Whisparr] Notification suppressed (disabled):", title, "-", message);
    return;
  }
  
  console.log("[StashDB-Whisparr] Showing notification:", title, "-", message);
  browser.notifications.create({
    type: "basic",
    iconUrl: browser.runtime.getURL("icons/icon-48.svg"),
    title: title,
    message: message
  }).then(() => {
    console.log("[StashDB-Whisparr] Notification created successfully");
  }).catch((err) => {
    console.error("[StashDB-Whisparr] Notification failed:", err);
  });
}

// ============================================
// Message Handlers for Popup
// ============================================

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle popup requests
  if (message.action === 'getBatchStatus') {
    sendResponse({ batches: batchesCache });
    return true;
  }
  
  if (message.action === 'retryScene') {
    retryScene(message.batchId, message.sceneId).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message.action === 'retryAllFailed') {
    retryAllFailed().then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message.action === 'clearBatches') {
    batchesCache = [];
    saveBatches();
    sendResponse({ success: true });
    return true;
  }
  
  if (message.action === 'cancelBatch') {
    try {
      cancelBatch(message.batchId);
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true;
  }
  
  if (message.action === 'undoScene') {
    undoScene(message.batchId, message.sceneId).then(() => {
      sendResponse({ success: true });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  // Filter-related message handlers (new array-based system)
  if (message.action === 'getFilters') {
    sendResponse({ filters: filtersCache });
    return true;
  }
  
  if (message.action === 'addFilter') {
    // Create and add a new filter
    const newFilter = createNewFilter();
    filtersCache.push(newFilter);
    saveFilters().then(() => {
      sendResponse({ success: true, filters: filtersCache, newFilter });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message.action === 'updateFilter') {
    // Update a specific filter by ID
    const { filterId, updates } = message;
    const filterIndex = filtersCache.findIndex(f => f.id === filterId);
    if (filterIndex !== -1) {
      filtersCache[filterIndex] = { ...filtersCache[filterIndex], ...updates };
      saveFilters().then(() => {
        sendResponse({ success: true, filters: filtersCache });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: false, error: 'Filter not found' });
    }
    return true;
  }
  
  if (message.action === 'deleteFilter') {
    // Delete a filter by ID
    const { filterId } = message;
    filtersCache = filtersCache.filter(f => f.id !== filterId);
    saveFilters().then(() => {
      sendResponse({ success: true, filters: filtersCache });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message.action === 'toggleFilter') {
    // Toggle a filter's enabled state
    const { filterId } = message;
    const filter = filtersCache.find(f => f.id === filterId);
    if (filter) {
      filter.enabled = !filter.enabled;
      saveFilters().then(() => {
        sendResponse({ success: true, filters: filtersCache });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: false, error: 'Filter not found' });
    }
    return true;
  }
  
  if (message.action === 'resetFilters') {
    // Clear all filters
    filtersCache = [];
    saveFilters().then(() => {
      sendResponse({ success: true, filters: filtersCache });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  return false;
});

// Retry a single failed scene
async function retryScene(batchId, stashId) {
  const batch = batchesCache.find(b => b.id === batchId);
  if (!batch) {
    throw new Error('Batch not found');
  }
  
  const scene = batch.scenes.find(s => s.stashId === stashId);
  if (!scene) {
    throw new Error('Scene not found');
  }
  
  // Update status to adding
  updateSceneStatus(batchId, stashId, { status: 'adding', error: null });
  
  try {
    const result = await addSceneToWhisparr(stashId);
    const title = result?.title || result?.movie?.title || scene.title;
    
    if (result && result.searched) {
      updateSceneStatus(batchId, stashId, { status: 'searched', title, error: null });
    } else if (result && result.exists) {
      updateSceneStatus(batchId, stashId, { status: 'exists', title, error: null });
    } else {
      updateSceneStatus(batchId, stashId, { status: 'added', title, error: null });
    }
  } catch (error) {
    console.error(`[StashDB-Whisparr] Retry failed for scene ${stashId}:`, error);
    if (error.message.includes("already exists") || error.message.includes("File already exists")) {
      updateSceneStatus(batchId, stashId, { status: 'exists', title: error.sceneTitle || scene.title, error: null });
    } else {
      updateSceneStatus(batchId, stashId, { status: 'error', error: error.message });
    }
  }
}

// Retry all failed scenes across all batches
async function retryAllFailed() {
  const failedScenes = [];
  
  // Collect all failed scenes
  for (const batch of batchesCache) {
    for (const scene of batch.scenes) {
      if (scene.status === 'error') {
        failedScenes.push({ batchId: batch.id, stashId: scene.stashId });
      }
    }
  }
  
  // Retry each failed scene
  for (const { batchId, stashId } of failedScenes) {
    await retryScene(batchId, stashId);
    // Small delay between retries
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// Cancel an in-progress batch
function cancelBatch(batchId) {
  const batch = batchesCache.find(b => b.id === batchId);
  if (!batch) {
    throw new Error('Batch not found');
  }
  
  // Check if batch has any pending scenes
  const hasPending = batch.scenes.some(s => s.status === 'waiting' || s.status === 'adding');
  if (!hasPending) {
    throw new Error('No pending scenes to cancel');
  }
  
  // Mark batch for cancellation - the processing loop will handle it
  cancelledBatchIds.add(batchId);
  console.log("[StashDB-Whisparr] Batch marked for cancellation:", batchId);
}

// Undo (delete from Whisparr) a single scene
async function undoScene(batchId, stashId) {
  const batch = batchesCache.find(b => b.id === batchId);
  if (!batch) {
    throw new Error('Batch not found');
  }
  
  const scene = batch.scenes.find(s => s.stashId === stashId);
  if (!scene) {
    throw new Error('Scene not found');
  }
  
  // Only allow undo for added or searched scenes
  if (!['added', 'searched'].includes(scene.status)) {
    throw new Error('Scene cannot be undone - not in added state');
  }
  
  // Update status to removing
  updateSceneStatus(batchId, stashId, { status: 'removing', error: null });
  
  try {
    await deleteSceneFromWhisparr(stashId, scene.whisparrId);
    updateSceneStatus(batchId, stashId, { status: 'removed', error: null, whisparrId: null });
    showNotification("Removed", `Scene removed from Whisparr`);
  } catch (error) {
    console.error(`[StashDB-Whisparr] Undo failed for scene ${stashId}:`, error);
    // Restore previous status on failure
    updateSceneStatus(batchId, stashId, { status: scene.status === 'removing' ? 'added' : scene.status, error: error.message });
    throw error;
  }
}

// Delete scene from Whisparr
async function deleteSceneFromWhisparr(stashId, whisparrId) {
  const settings = await getSettings();
  
  if (!settings.whisparrUrl || !settings.apiKey) {
    throw new Error("Please configure Whisparr settings in extension options");
  }

  const baseUrl = settings.whisparrUrl.replace(/\/$/, "");
  
  // If we have a whisparrId, use it directly
  let movieId = whisparrId;
  
  // If no whisparrId, look up the movie by stashId
  if (!movieId) {
    console.log("[StashDB-Whisparr] Looking up movie by foreignId:", stashId);
    
    const movieResponse = await fetch(`${baseUrl}/api/v3/movie?foreignId=${stashId}`, {
      method: "GET",
      headers: {
        "X-Api-Key": settings.apiKey,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    
    if (!movieResponse.ok) {
      throw new Error(`Failed to lookup movie: ${movieResponse.status}`);
    }
    
    const movies = await movieResponse.json();
    if (!Array.isArray(movies) || movies.length === 0) {
      throw new Error("Movie not found in Whisparr");
    }
    
    movieId = movies[0].id;
  }
  
  // Delete the movie
  console.log("[StashDB-Whisparr] Deleting movie:", movieId);
  
  const deleteResponse = await fetch(`${baseUrl}/api/v3/movie/${movieId}?deleteFiles=false&addImportExclusion=false`, {
    method: "DELETE",
    headers: {
      "X-Api-Key": settings.apiKey,
      "X-Requested-With": "XMLHttpRequest"
    }
  });
  
  if (!deleteResponse.ok) {
    const errorText = await deleteResponse.text();
    console.error("[StashDB-Whisparr] Delete failed:", deleteResponse.status, errorText);
    throw new Error(`Delete failed: ${deleteResponse.status}`);
  }
  
  console.log("[StashDB-Whisparr] Movie deleted successfully");
  return { deleted: true };
}
