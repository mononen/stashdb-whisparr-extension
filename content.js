// Content script for StashDB pages
// Handles detection of scene links and extraction of all scene URLs

// Store the last right-clicked element
let lastClickedElement = null;

// Track the last right-clicked element
document.addEventListener("contextmenu", (e) => {
  lastClickedElement = e.target;
}, true);

// Listen for messages from background script
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getClickedSceneUrl") {
    // Check if the clicked element or its ancestors is a scene link
    const sceneUrl = findSceneLinkFromElement(lastClickedElement);
    sendResponse({ sceneUrl });
    return true;
  }
  
  if (message.action === "getAllSceneUrls") {
    // Find all unique scene URLs on the page
    const sceneUrls = extractAllSceneUrls();
    sendResponse({ sceneUrls });
    return true;
  }
});

// Find a scene link from an element or its ancestors
function findSceneLinkFromElement(element) {
  if (!element) return null;
  
  // Traverse up the DOM tree looking for a scene link
  let current = element;
  while (current && current !== document.body) {
    if (current.tagName === "A" && current.href) {
      const stashId = extractStashIdFromUrl(current.href);
      if (stashId) {
        return current.href;
      }
    }
    current = current.parentElement;
  }
  
  return null;
}

// Extract all unique scene URLs from the page
function extractAllSceneUrls() {
  const sceneLinks = document.querySelectorAll('a[href*="/scenes/"]');
  const uniqueUrls = new Set();
  
  sceneLinks.forEach(link => {
    const stashId = extractStashIdFromUrl(link.href);
    if (stashId) {
      // Normalize the URL to avoid duplicates
      uniqueUrls.add(`https://stashdb.org/scenes/${stashId}`);
    }
  });
  
  return Array.from(uniqueUrls);
}

// Extract StashID (UUID) from a URL
function extractStashIdFromUrl(url) {
  const match = url.match(/\/scenes\/([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}

