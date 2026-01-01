// Content script for StashDB pages
// Handles detection of scene links and extraction of scene metadata

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
    // Find all unique scene URLs on the page (legacy - still needed for count)
    const sceneUrls = extractAllSceneUrls();
    sendResponse({ sceneUrls });
    return true;
  }
  
  if (message.action === "getAllScenesWithMetadata") {
    // Find all scenes with their metadata for filtering
    const scenes = extractAllScenesWithMetadata();
    sendResponse({ scenes });
    return true;
  }
  
  if (message.action === "getCurrentSceneMetadata") {
    // Extract metadata from current scene detail page
    const metadata = extractCurrentSceneMetadata();
    sendResponse({ metadata });
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

// ============================================
// Metadata Extraction
// ============================================

/**
 * Extract metadata for all scenes visible on list pages (performers, studios, etc.)
 * Returns array of { stashId, title, studio, performers, tags }
 */
function extractAllScenesWithMetadata() {
  const scenes = [];
  const processedIds = new Set();
  
  // Try multiple strategies to find scene cards/rows
  
  // Strategy 1: Find scene cards by looking for links to /scenes/
  const sceneLinks = document.querySelectorAll('a[href*="/scenes/"]');
  
  sceneLinks.forEach(link => {
    const stashId = extractStashIdFromUrl(link.href);
    if (!stashId || processedIds.has(stashId)) return;
    processedIds.add(stashId);
    
    // Try to find the scene card/container
    const container = findSceneContainer(link);
    const metadata = extractMetadataFromContainer(container, link, stashId);
    
    scenes.push(metadata);
  });
  
  console.log("[StashDB-Whisparr] Extracted metadata for", scenes.length, "scenes");
  return scenes;
}

/**
 * Find the containing card/row element for a scene link
 */
function findSceneContainer(link) {
  let current = link;
  
  // Walk up to find a card-like container
  // StashDB typically uses Bootstrap-like card classes or specific scene card components
  while (current && current !== document.body) {
    // Check for common card/container patterns
    const classes = current.className || '';
    if (
      classes.includes('card') ||
      classes.includes('scene') ||
      classes.includes('SceneCard') ||
      classes.includes('row') ||
      current.getAttribute('data-scene') ||
      // Check if this element contains multiple distinct sections (title, performers, etc.)
      (current.querySelectorAll('a[href*="/performers/"]').length > 0 && 
       current.querySelectorAll('a[href*="/scenes/"]').length > 0)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  
  // Fallback: return the parent of the link
  return link.parentElement?.parentElement || link.parentElement || link;
}

/**
 * Extract metadata from a scene container element
 */
function extractMetadataFromContainer(container, sceneLink, stashId) {
  const metadata = {
    stashId,
    title: '',
    studio: '',
    performers: [],
    tags: []
  };
  
  // Extract title - usually the scene link text or a heading within
  metadata.title = extractTitle(container, sceneLink);
  
  // Extract studio - look for links to /studios/
  metadata.studio = extractStudio(container);
  
  // Extract performers - look for links to /performers/
  metadata.performers = extractPerformers(container);
  
  // Extract tags - look for links to /tags/ or badge-like elements
  metadata.tags = extractTags(container);
  
  return metadata;
}

/**
 * Extract scene title from container
 */
function extractTitle(container, sceneLink) {
  // First try: the scene link text itself (most common)
  const linkText = sceneLink.textContent?.trim();
  if (linkText && linkText.length > 0 && !linkText.match(/^[a-f0-9-]{36}$/i)) {
    return linkText;
  }
  
  // Second try: find a title element or heading
  const titleSelectors = [
    '.scene-title',
    '.title',
    '[class*="title"]',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '.card-title',
    '.SceneCard-title'
  ];
  
  for (const selector of titleSelectors) {
    const titleEl = container.querySelector(selector);
    if (titleEl) {
      const text = titleEl.textContent?.trim();
      if (text && text.length > 0) {
        return text;
      }
    }
  }
  
  // Third try: find any scene link with text
  const allSceneLinks = container.querySelectorAll('a[href*="/scenes/"]');
  for (const link of allSceneLinks) {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !text.match(/^[a-f0-9-]{36}$/i)) {
      return text;
    }
  }
  
  return '';
}

/**
 * Extract studio name from container
 */
function extractStudio(container) {
  // Look for links to /studios/
  const studioLinks = container.querySelectorAll('a[href*="/studios/"]');
  for (const link of studioLinks) {
    const text = link.textContent?.trim();
    if (text && text.length > 0) {
      return text;
    }
  }
  
  // Try to find studio by class patterns
  const studioSelectors = [
    '.studio',
    '[class*="studio"]',
    '.scene-studio'
  ];
  
  for (const selector of studioSelectors) {
    const studioEl = container.querySelector(selector);
    if (studioEl) {
      const text = studioEl.textContent?.trim();
      if (text && text.length > 0) {
        return text;
      }
    }
  }
  
  return '';
}

/**
 * Extract performer names from container
 */
function extractPerformers(container) {
  const performers = [];
  
  // Look for links to /performers/
  const performerLinks = container.querySelectorAll('a[href*="/performers/"]');
  performerLinks.forEach(link => {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !performers.includes(text)) {
      performers.push(text);
    }
  });
  
  return performers;
}

/**
 * Extract tags from container
 */
function extractTags(container) {
  const tags = [];
  
  // Look for links to /tags/
  const tagLinks = container.querySelectorAll('a[href*="/tags/"]');
  tagLinks.forEach(link => {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !tags.includes(text)) {
      tags.push(text);
    }
  });
  
  // Also look for badge-like elements that might contain tags
  const badgeSelectors = [
    '.badge',
    '.tag',
    '[class*="tag"]',
    '.label'
  ];
  
  for (const selector of badgeSelectors) {
    container.querySelectorAll(selector).forEach(el => {
      // Skip if it's already a tag link (already processed)
      if (el.closest('a[href*="/tags/"]')) return;
      
      const text = el.textContent?.trim();
      if (text && text.length > 0 && text.length < 50 && !tags.includes(text)) {
        // Avoid adding things that look like titles or descriptions
        if (!text.includes(' - ') && !text.match(/^\d{4}/)) {
          tags.push(text);
        }
      }
    });
  }
  
  return tags;
}

/**
 * Extract metadata from current scene detail page
 * Used when user right-clicks directly on a scene page
 */
function extractCurrentSceneMetadata() {
  const url = window.location.href;
  const stashId = extractStashIdFromUrl(url);
  
  if (!stashId) {
    return null;
  }
  
  const metadata = {
    stashId,
    title: '',
    studio: '',
    performers: [],
    tags: []
  };
  
  // On a scene detail page, metadata is usually in the main content area
  
  // Title: Usually in the main heading (h1, h2, etc.) or page title
  const titleSelectors = [
    'h1',
    'h2',
    '.scene-title',
    '[class*="Title"]',
    '.title'
  ];
  
  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = el.textContent?.trim();
      // Make sure it's not navigation or other UI text
      if (text && text.length > 0 && text.length < 300) {
        metadata.title = text;
        break;
      }
    }
  }
  
  // Fallback to page title
  if (!metadata.title) {
    const pageTitle = document.title;
    // Usually in format "Scene Title | StashDB" or similar
    const parts = pageTitle.split('|');
    if (parts.length > 0) {
      metadata.title = parts[0].trim();
    }
  }
  
  // Studio
  const studioLinks = document.querySelectorAll('a[href*="/studios/"]');
  for (const link of studioLinks) {
    const text = link.textContent?.trim();
    if (text && text.length > 0) {
      metadata.studio = text;
      break;
    }
  }
  
  // Performers
  const performerLinks = document.querySelectorAll('a[href*="/performers/"]');
  performerLinks.forEach(link => {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !metadata.performers.includes(text)) {
      metadata.performers.push(text);
    }
  });
  
  // Tags
  const tagLinks = document.querySelectorAll('a[href*="/tags/"]');
  tagLinks.forEach(link => {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !metadata.tags.includes(text)) {
      metadata.tags.push(text);
    }
  });
  
  console.log("[StashDB-Whisparr] Extracted current scene metadata:", metadata);
  return metadata;
}
