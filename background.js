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
          await addSingleScene(stashId);
          return;
        }
      }
      
      // Case 2: On a scene detail page - add the current scene
      if (tab.url.match(/stashdb\.org\/scenes\/[a-f0-9-]+/i)) {
        const stashId = extractStashId(tab.url);
        if (stashId) {
          console.log("[StashDB-Whisparr] Adding scene from page URL:", stashId);
          await addSingleScene(stashId);
          return;
        }
      }
      
      // Case 3: On another page (performers, studios, tags, etc.) - get all scene links
      console.log("[StashDB-Whisparr] Querying content script for all scene links...");
      const response = await browser.tabs.sendMessage(tab.id, { action: "getAllSceneUrls" });
      
      if (!response || !response.sceneUrls || response.sceneUrls.length === 0) {
        showNotification("No Scenes", "No scene links found on this page");
        return;
      }
      
      const sceneUrls = response.sceneUrls;
      console.log("[StashDB-Whisparr] Found", sceneUrls.length, "scene links");
      
      // Show confirmation popup
      const confirmed = await showConfirmationPopup(sceneUrls.length, tab.id);
      if (!confirmed) {
        console.log("[StashDB-Whisparr] User cancelled bulk add");
        return;
      }
      
      // Extract stash IDs and add all scenes
      const stashIds = sceneUrls.map(url => extractStashId(url)).filter(Boolean);
      await addMultipleScenes(stashIds);
      
    } catch (error) {
      console.error("[StashDB-Whisparr] Error:", error);
      showNotification("Error", error.message);
    }
  }
});

// Add a single scene to Whisparr (with batch tracking)
async function addSingleScene(stashId) {
  // Create a batch with single scene for tracking
  const batch = createBatch([stashId]);
  
  // Update status to adding
  updateSceneStatus(batch.id, stashId, { status: 'adding' });
  
  try {
    const result = await addSceneToWhisparr(stashId);
    const title = result?.title || result?.movie?.title || null;
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
      updateSceneStatus(batch.id, stashId, { status: 'exists', title: error.sceneTitle || null, error: null });
      showNotification("Exists", `Scene already exists with file`);
    } else {
      updateSceneStatus(batch.id, stashId, { status: 'error', title: error.sceneTitle || null, error: error.message });
      showNotification("Error", error.message);
    }
  }
}

// Add multiple scenes with progress notifications and batch tracking
async function addMultipleScenes(stashIds) {
  const total = stashIds.length;
  let added = 0;
  let searched = 0;
  let failed = 0;
  let alreadyExists = 0;
  
  // Create batch for tracking
  const batch = createBatch(stashIds);
  
  // Create initial progress notification
  const notificationId = "whisparr-bulk-progress";
  await showProgressNotification(notificationId, "Adding Scenes", `Adding scene 1 of ${total}...`);
  
  for (let i = 0; i < stashIds.length; i++) {
    const stashId = stashIds[i];
    
    // Update scene status to 'adding'
    updateSceneStatus(batch.id, stashId, { status: 'adding' });
    
    // Update progress notification
    await showProgressNotification(notificationId, "Adding Scenes", `Adding scene ${i + 1} of ${total}...`);
    
    try {
      const result = await addSceneToWhisparr(stashId);
      const title = result?.title || result?.movie?.title || null;
      
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
        updateSceneStatus(batch.id, stashId, { status: 'exists', title: error.sceneTitle || null, error: null });
      } else {
        failed++;
        updateSceneStatus(batch.id, stashId, { status: 'error', title: error.sceneTitle || null, error: error.message });
      }
    }
    
    // Small delay to avoid overwhelming the server
    if (i < stashIds.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Show final summary
  const parts = [];
  if (added > 0) parts.push(`${added} added`);
  if (searched > 0) parts.push(`${searched} search triggered`);
  if (alreadyExists > 0) parts.push(`${alreadyExists} already exist`);
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
