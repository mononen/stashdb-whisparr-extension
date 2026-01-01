// Load saved settings when page opens
document.addEventListener("DOMContentLoaded", loadSettings);

// Save settings when form is submitted
document.getElementById("settings-form").addEventListener("submit", saveSettings);

// Test connection button
document.getElementById("testConnection").addEventListener("click", testConnection);

async function loadSettings() {
  const defaults = {
    whisparrUrl: "",
    apiKey: "",
    rootFolderPath: "",
    qualityProfileId: "",
    searchForMovie: true,
    monitored: true
  };

  const settings = await browser.storage.sync.get(defaults);

  document.getElementById("whisparrUrl").value = settings.whisparrUrl;
  document.getElementById("apiKey").value = settings.apiKey;
  document.getElementById("searchForMovie").checked = settings.searchForMovie;
  document.getElementById("monitored").checked = settings.monitored;

  // If we have saved settings, try to load the dropdowns
  if (settings.whisparrUrl && settings.apiKey) {
    await testConnection(null, settings.rootFolderPath, settings.qualityProfileId);
  }
}

async function testConnection(e, savedRootFolder = null, savedQualityProfile = null) {
  const whisparrUrl = document.getElementById("whisparrUrl").value.trim();
  const apiKey = document.getElementById("apiKey").value.trim();
  const connectionStatus = document.getElementById("connectionStatus");
  const testBtn = document.getElementById("testConnection");

  if (!whisparrUrl || !apiKey) {
    showConnectionStatus("Please enter server URL and API key first", "error");
    return;
  }

  // Show loading state
  testBtn.disabled = true;
  testBtn.textContent = "Testing...";
  showConnectionStatus("Connecting to Whisparr...", "loading");

  const baseUrl = whisparrUrl.replace(/\/$/, "");

  try {
    // Fetch quality profiles and root folders in parallel
    const [profilesRes, foldersRes] = await Promise.all([
      fetch(`${baseUrl}/api/v3/qualityprofile`, {
        headers: { "X-Api-Key": apiKey }
      }),
      fetch(`${baseUrl}/api/v3/rootfolder`, {
        headers: { "X-Api-Key": apiKey }
      })
    ]);

    if (!profilesRes.ok || !foldersRes.ok) {
      throw new Error(`API returned ${profilesRes.status || foldersRes.status}`);
    }

    const profiles = await profilesRes.json();
    const folders = await foldersRes.json();

    // Populate quality profiles dropdown
    const profileSelect = document.getElementById("qualityProfileId");
    profileSelect.replaceChildren();
    profileSelect.disabled = false;

    profiles.forEach(profile => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      profileSelect.appendChild(option);
    });

    // Restore saved selection or select first
    if (savedQualityProfile && profiles.some(p => p.id == savedQualityProfile)) {
      profileSelect.value = savedQualityProfile;
    }

    // Populate root folders dropdown
    const folderSelect = document.getElementById("rootFolderPath");
    folderSelect.replaceChildren();
    folderSelect.disabled = false;

    folders.forEach(folder => {
      const option = document.createElement("option");
      option.value = folder.path;
      option.textContent = `${folder.path} (${formatBytes(folder.freeSpace)} free)`;
      folderSelect.appendChild(option);
    });

    // Restore saved selection or select first
    if (savedRootFolder && folders.some(f => f.path === savedRootFolder)) {
      folderSelect.value = savedRootFolder;
    }

    showConnectionStatus(`Connected! Found ${profiles.length} quality profiles and ${folders.length} root folders.`, "success");

  } catch (error) {
    showConnectionStatus(`Connection failed: ${error.message}`, "error");
    
    // Reset dropdowns
    const qualitySelect = document.getElementById("qualityProfileId");
    qualitySelect.replaceChildren();
    const qualityOption = document.createElement("option");
    qualityOption.value = "";
    qualityOption.textContent = "Test connection first...";
    qualitySelect.appendChild(qualityOption);
    qualitySelect.disabled = true;

    const rootSelect = document.getElementById("rootFolderPath");
    rootSelect.replaceChildren();
    const rootOption = document.createElement("option");
    rootOption.value = "";
    rootOption.textContent = "Test connection first...";
    rootSelect.appendChild(rootOption);
    rootSelect.disabled = true;
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = "Test Connection";
  }
}

function showConnectionStatus(message, type) {
  const statusEl = document.getElementById("connectionStatus");
  statusEl.textContent = message;
  statusEl.className = `connection-status ${type} show`;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function saveSettings(e) {
  e.preventDefault();

  const qualityProfileId = document.getElementById("qualityProfileId").value;
  const rootFolderPath = document.getElementById("rootFolderPath").value;

  if (!qualityProfileId || !rootFolderPath) {
    showStatus("Please test connection and select quality profile and root folder", "error");
    return;
  }

  const settings = {
    whisparrUrl: document.getElementById("whisparrUrl").value.trim(),
    apiKey: document.getElementById("apiKey").value.trim(),
    rootFolderPath: rootFolderPath,
    qualityProfileId: parseInt(qualityProfileId, 10),
    searchForMovie: document.getElementById("searchForMovie").checked,
    monitored: document.getElementById("monitored").checked
  };

  try {
    await browser.storage.sync.set(settings);
    showStatus("Settings saved successfully!", "success");
  } catch (error) {
    showStatus("Failed to save settings: " + error.message, "error");
  }
}

function showStatus(message, type) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.className = `status ${type} show`;

  setTimeout(() => {
    statusEl.classList.remove("show");
  }, 3000);
}
