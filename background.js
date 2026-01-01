// ============================================
// Batch State Management
// ============================================

// In-memory cache of batches (also persisted to storage)
let batchesCache = [];

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

// Default filter configuration
const defaultFilters = {
  studios: {
    mode: 'blocklist',
    matchLogic: 'or',
    values: []
  },
  performers: {
    mode: 'blocklist',
    matchLogic: 'or',
    values: []
  },
  names: {
    mode: 'blocklist',
    matchLogic: 'or',
    values: []
  },
  tags: {
    mode: 'blocklist',
    matchLogic: 'or',
    values: []
  }
};

// In-memory cache of filters
let filtersCache = JSON.parse(JSON.stringify(defaultFilters));

// Load filters from storage on startup
async function loadFilters() {
  const data = await browser.storage.local.get({ filters: defaultFilters });
  filtersCache = { ...defaultFilters, ...data.filters };
  // Ensure all categories exist with defaults
  for (const key of Object.keys(defaultFilters)) {
    if (!filtersCache[key]) {
      filtersCache[key] = { ...defaultFilters[key] };
    }
  }
  return filtersCache;
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
// Filter Evaluation Logic
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
 * Check if a value matches any item in the scene's metadata for a category
 * @param {string} filterValue - The filter value to check
 * @param {Array|string} sceneValues - The scene's values for this category
 * @param {boolean} isPartialMatch - Whether to use partial matching (for names)
 * @returns {boolean}
 */
function valueMatches(filterValue, sceneValues, isPartialMatch = false) {
  const normalizedFilter = filterValue.toLowerCase().trim();
  
  if (Array.isArray(sceneValues)) {
    return sceneValues.some(sv => {
      const normalizedScene = (sv || '').toLowerCase().trim();
      return isPartialMatch 
        ? normalizedScene.includes(normalizedFilter) || normalizedFilter.includes(normalizedScene)
        : normalizedScene === normalizedFilter;
    });
  } else {
    const normalizedScene = (sceneValues || '').toLowerCase().trim();
    return isPartialMatch
      ? normalizedScene.includes(normalizedFilter) || normalizedFilter.includes(normalizedScene)
      : normalizedScene === normalizedFilter;
  }
}

/**
 * Evaluate a single filter category against scene metadata
 * @param {Object} filterConfig - The filter configuration for this category
 * @param {Array|string} sceneValues - The scene's values for this category
 * @param {boolean} isPartialMatch - Whether to use partial matching
 * @returns {Object} { pass: boolean, reason: string|null }
 */
function evaluateCategory(filterConfig, sceneValues, isPartialMatch = false) {
  const { mode, matchLogic, values } = filterConfig;
  
  // If no filter values configured, always pass
  if (!values || values.length === 0) {
    return { pass: true, reason: null };
  }
  
  // Count how many filter values match the scene
  const matches = values.filter(v => valueMatches(v, sceneValues, isPartialMatch));
  const allMatch = matches.length === values.length;
  const anyMatch = matches.length > 0;
  
  if (mode === 'blocklist') {
    // Blocklist: FAIL if matches occur according to matchLogic
    if (matchLogic === 'and') {
      // FAIL only if ALL filter values match
      if (allMatch) {
        return { pass: false, reason: `Blocked: all of [${values.join(', ')}]` };
      }
    } else {
      // matchLogic === 'or': FAIL if ANY filter value matches
      if (anyMatch) {
        return { pass: false, reason: `Blocked: ${matches.join(', ')}` };
      }
    }
    return { pass: true, reason: null };
  } else {
    // Allowlist: PASS only if matches occur according to matchLogic
    if (matchLogic === 'and') {
      // PASS only if ALL filter values match
      if (!allMatch) {
        const missing = values.filter(v => !matches.includes(v));
        return { pass: false, reason: `Missing required: ${missing.join(', ')}` };
      }
    } else {
      // matchLogic === 'or': PASS if ANY filter value matches
      if (!anyMatch) {
        return { pass: false, reason: `None of [${values.join(', ')}] found` };
      }
    }
    return { pass: true, reason: null };
  }
}

/**
 * Check if a scene should be added based on all filters
 * @param {Object} sceneData - Scene data (scraped metadata or Whisparr lookup)
 * @returns {Object} { shouldAdd: boolean, reason: string|null, category: string|null }
 */
function shouldAddScene(sceneData) {
  const metadata = normalizeSceneMetadata(sceneData);
  
  console.log("[StashDB-Whisparr] Evaluating filters for scene:", metadata.title || sceneData.stashId);
  console.log("[StashDB-Whisparr] Scene metadata:", metadata);
  console.log("[StashDB-Whisparr] Active filters:", filtersCache);
  
  // Check studios filter
  const studioResult = evaluateCategory(filtersCache.studios, metadata.studio, false);
  if (!studioResult.pass) {
    console.log("[StashDB-Whisparr] Scene filtered by studio:", studioResult.reason);
    return { shouldAdd: false, reason: studioResult.reason, category: 'studios' };
  }
  
  // Check performers filter
  const performerResult = evaluateCategory(filtersCache.performers, metadata.performers, false);
  if (!performerResult.pass) {
    console.log("[StashDB-Whisparr] Scene filtered by performer:", performerResult.reason);
    return { shouldAdd: false, reason: performerResult.reason, category: 'performers' };
  }
  
  // Check names filter (partial match for scene title)
  const nameResult = evaluateCategory(filtersCache.names, metadata.title, true);
  if (!nameResult.pass) {
    console.log("[StashDB-Whisparr] Scene filtered by name:", nameResult.reason);
    return { shouldAdd: false, reason: nameResult.reason, category: 'names' };
  }
  
  // Check tags filter
  const tagResult = evaluateCategory(filtersCache.tags, metadata.tags, false);
  if (!tagResult.pass) {
    console.log("[StashDB-Whisparr] Scene filtered by tag:", tagResult.reason);
    return { shouldAdd: false, reason: tagResult.reason, category: 'tags' };
  }
  
  console.log("[StashDB-Whisparr] Scene passed all filters");
  return { shouldAdd: true, reason: null, category: null };
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
          // Get metadata from page for this scene (try to find in scene list)
          const metadataResponse = await browser.tabs.sendMessage(tab.id, { action: "getAllScenesWithMetadata" });
          const sceneMetadata = metadataResponse?.scenes?.find(s => s.stashId === stashId) || { stashId };
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
  
  for (let i = 0; i < scenesToProcess.length; i++) {
    const scene = scenesToProcess[i];
    const stashId = scene.stashId;
    const scrapedTitle = scene.title || null;
    
    // Update scene status to 'adding'
    updateSceneStatus(batch.id, stashId, { status: 'adding', title: scrapedTitle });
    
    // Update progress notification
    await showProgressNotification(notificationId, "Adding Scenes", `Adding scene ${i + 1} of ${toProcessCount}...`);
    
    try {
      const result = await addSceneToWhisparr(stashId);
      const title = result?.title || result?.movie?.title || scrapedTitle;
      
      if (result && result.searched) {
        searched++;
        updateSceneStatus(batch.id, stashId, { status: 'searched', title, error: null });
      } else if (result && result.exists) {
        alreadyExists++;
        updateSceneStatus(batch.id, stashId, { status: 'exists', title, error: null });
      } else {
        added++;
        updateSceneStatus(batch.id, stashId, { status: 'added', title, error: null });
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
  if (failed > 0) parts.push(`${failed} failed`);
  
  const summary = parts.length > 0 ? parts.join(", ") : "No changes";
  
  await showProgressNotification(notificationId, "Complete", summary);
  
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
  
  // Filter-related message handlers
  if (message.action === 'getFilters') {
    sendResponse({ filters: filtersCache });
    return true;
  }
  
  if (message.action === 'updateFilters') {
    filtersCache = { ...filtersCache, ...message.filters };
    saveFilters().then(() => {
      sendResponse({ success: true, filters: filtersCache });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true;
  }
  
  if (message.action === 'updateFilterCategory') {
    const { category, config } = message;
    if (filtersCache[category]) {
      filtersCache[category] = { ...filtersCache[category], ...config };
      saveFilters().then(() => {
        sendResponse({ success: true, filters: filtersCache });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: false, error: 'Invalid category' });
    }
    return true;
  }
  
  if (message.action === 'addFilterValue') {
    const { category, value } = message;
    if (filtersCache[category] && !filtersCache[category].values.includes(value)) {
      filtersCache[category].values.push(value);
      saveFilters().then(() => {
        sendResponse({ success: true, filters: filtersCache });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: true, filters: filtersCache });
    }
    return true;
  }
  
  if (message.action === 'removeFilterValue') {
    const { category, value } = message;
    if (filtersCache[category]) {
      filtersCache[category].values = filtersCache[category].values.filter(v => v !== value);
      saveFilters().then(() => {
        sendResponse({ success: true, filters: filtersCache });
      }).catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    } else {
      sendResponse({ success: false, error: 'Invalid category' });
    }
    return true;
  }
  
  if (message.action === 'resetFilters') {
    filtersCache = JSON.parse(JSON.stringify(defaultFilters));
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
