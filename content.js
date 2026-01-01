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
  
  if (message.action === "getClickedSceneMetadata") {
    // Extract metadata for the scene that was right-clicked
    const metadata = extractClickedSceneMetadata(message.stashId);
    sendResponse({ metadata });
    return true;
  }
});

/**
 * Extract metadata specifically for the clicked scene element
 * Falls back to various methods to get the title
 */
function extractClickedSceneMetadata(targetStashId) {
  console.log("[StashDB-Whisparr] Extracting metadata for clicked scene:", targetStashId);
  
  // First, try to get from the last clicked element
  if (lastClickedElement) {
    const metadata = extractMetadataFromClickedElement(lastClickedElement, targetStashId);
    if (metadata && metadata.title) {
      console.log("[StashDB-Whisparr] Got metadata from clicked element:", metadata);
      return metadata;
    }
  }
  
  // Second, try to find in the page's scene list
  const allScenes = extractAllScenesWithMetadata();
  const foundScene = allScenes.find(s => s.stashId === targetStashId);
  if (foundScene && foundScene.title) {
    console.log("[StashDB-Whisparr] Got metadata from scene list:", foundScene);
    return foundScene;
  }
  
  // Third, if we're on a scene detail page for this scene, use that
  if (window.location.href.includes(targetStashId)) {
    const pageMetadata = extractCurrentSceneMetadata();
    if (pageMetadata && pageMetadata.title) {
      console.log("[StashDB-Whisparr] Got metadata from current page:", pageMetadata);
      return pageMetadata;
    }
  }
  
  // Last resort: return minimal metadata
  console.log("[StashDB-Whisparr] Could not extract rich metadata, returning stashId only");
  return { stashId: targetStashId, title: '', studio: '', performers: [], tags: [] };
}

/**
 * Extract metadata from the clicked element and its context
 */
function extractMetadataFromClickedElement(element, targetStashId) {
  const metadata = {
    stashId: targetStashId,
    title: '',
    studio: '',
    performers: [],
    tags: []
  };
  
  // Walk up from clicked element to find scene link
  let current = element;
  let sceneLink = null;
  
  while (current && current !== document.body) {
    if (current.tagName === 'A' && current.href && current.href.includes('/scenes/')) {
      const id = extractStashIdFromUrl(current.href);
      if (id === targetStashId) {
        sceneLink = current;
        break;
      }
    }
    current = current.parentElement;
  }
  
  // If we found the scene link, try to get title from it
  if (sceneLink) {
    const linkText = sceneLink.textContent?.trim();
    if (linkText && linkText.length > 3 && !linkText.match(/^[a-f0-9-]{36}$/i)) {
      metadata.title = linkText;
      console.log("[StashDB-Whisparr] Got title from clicked link:", linkText);
    }
    
    // Also try title attribute
    if (!metadata.title && sceneLink.title) {
      metadata.title = sceneLink.title;
    }
    
    // Find the container and extract more metadata
    const container = findSceneContainer(sceneLink);
    if (container) {
      if (!metadata.title) {
        metadata.title = extractTitle(container, sceneLink);
      }
      metadata.studio = extractStudio(container);
      metadata.performers = extractPerformers(container);
      metadata.tags = extractTags(container);
    }
    
    // If studio still not found, try broader search from the clicked element
    if (!metadata.studio) {
      let searchEl = element;
      for (let i = 0; i < 8 && searchEl && searchEl !== document.body; i++) {
        const studioLink = searchEl.querySelector('a[href*="/studios/"]');
        if (studioLink) {
          const text = studioLink.textContent?.trim();
          if (text && text.length > 0) {
            metadata.studio = text;
            console.log("[StashDB-Whisparr] Found studio via broader search:", text);
            break;
          }
        }
        searchEl = searchEl.parentElement;
      }
    }
  }
  
  return metadata;
}

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
  let bestContainer = null;
  
  // Walk up to find a card-like container
  // StashDB typically uses Bootstrap-like card classes or specific scene card components
  while (current && current !== document.body) {
    // Check for common card/container patterns
    const classes = current.className || '';
    
    // Check if this container has a studio link (key indicator of a full scene card)
    const hasStudioLink = current.querySelectorAll('a[href*="/studios/"]').length > 0;
    const hasSceneLink = current.querySelectorAll('a[href*="/scenes/"]').length > 0;
    const hasPerformerLink = current.querySelectorAll('a[href*="/performers/"]').length > 0;
    
    // If container has studio link, it's likely the full card
    if (hasStudioLink && hasSceneLink) {
      return current;
    }
    
    // Check for class-based patterns
    if (
      classes.includes('card') ||
      classes.includes('scene') ||
      classes.includes('SceneCard') ||
      classes.includes('row') ||
      current.getAttribute('data-scene')
    ) {
      // If it has a studio link, return immediately
      if (hasStudioLink) {
        return current;
      }
      // Otherwise save as best candidate and keep looking up
      if (!bestContainer) {
        bestContainer = current;
      }
    }
    
    // Also check if this element contains multiple links (scene + performer or studio)
    if ((hasPerformerLink || hasStudioLink) && hasSceneLink) {
      if (!bestContainer) {
        bestContainer = current;
      }
    }
    
    current = current.parentElement;
  }
  
  // Return best container found, or walk up a few levels from the link
  if (bestContainer) {
    return bestContainer;
  }
  
  // Fallback: walk up 4-5 levels to find a reasonable container
  current = link;
  for (let i = 0; i < 5 && current && current !== document.body; i++) {
    current = current.parentElement;
    if (current && current.querySelectorAll('a[href*="/studios/"]').length > 0) {
      return current;
    }
  }
  
  // Last resort: return grandparent or parent
  return link.parentElement?.parentElement?.parentElement || 
         link.parentElement?.parentElement || 
         link.parentElement || 
         link;
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
  // First try: the scene link text itself (most common on StashDB)
  // The link to /scenes/UUID typically contains the title as its text
  const linkText = sceneLink.textContent?.trim();
  if (linkText && linkText.length > 0 && !linkText.match(/^[a-f0-9-]{36}$/i)) {
    console.log("[StashDB-Whisparr] Found title from scene link:", linkText);
    return linkText;
  }
  
  // Second try: look for scene link with title text in the container
  const allSceneLinks = container.querySelectorAll('a[href*="/scenes/"]');
  for (const link of allSceneLinks) {
    const text = link.textContent?.trim();
    // Exclude UUIDs, empty strings, and very short text (likely icons)
    if (text && text.length > 3 && !text.match(/^[a-f0-9-]{36}$/i)) {
      console.log("[StashDB-Whisparr] Found title from container scene link:", text);
      return text;
    }
  }
  
  // Third try: find a title element or heading
  const titleSelectors = [
    '.scene-title',
    '.title',
    '[class*="Title"]',
    '[class*="title"]',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    '.card-title',
    '.SceneCard-title',
    // StashDB specific patterns
    '[class*="SceneCard"] a',
    '.card-body a'
  ];
  
  for (const selector of titleSelectors) {
    try {
      const titleEl = container.querySelector(selector);
      if (titleEl) {
        const text = titleEl.textContent?.trim();
        // Make sure it's a reasonable title (not just a date or short text)
        if (text && text.length > 3 && !text.match(/^\d{4}-\d{2}-\d{2}$/) && !text.match(/^[a-f0-9-]{36}$/i)) {
          console.log("[StashDB-Whisparr] Found title from selector", selector, ":", text);
          return text;
        }
      }
    } catch (e) {
      // Invalid selector, skip
    }
  }
  
  // Fourth try: look at the link's title or alt attributes
  if (sceneLink.title && sceneLink.title.length > 0) {
    console.log("[StashDB-Whisparr] Found title from link title attr:", sceneLink.title);
    return sceneLink.title;
  }
  
  // Fifth try: check for image alt text in the container (scene thumbnails often have alt text)
  const img = container.querySelector('img[alt]');
  if (img && img.alt && img.alt.length > 3 && !img.alt.match(/^[a-f0-9-]{36}$/i)) {
    console.log("[StashDB-Whisparr] Found title from img alt:", img.alt);
    return img.alt;
  }
  
  console.log("[StashDB-Whisparr] Could not extract title for container");
  return '';
}

/**
 * Extract studio name from container
 */
function extractStudio(container) {
  // Look for links to /studios/ within the container
  const studioLinks = container.querySelectorAll('a[href*="/studios/"]');
  for (const link of studioLinks) {
    const text = link.textContent?.trim();
    if (text && text.length > 0) {
      console.log("[StashDB-Whisparr] Found studio in container:", text);
      return text;
    }
  }
  
  // If not found, try looking in parent elements (up to 5 levels)
  let current = container.parentElement;
  for (let i = 0; i < 5 && current && current !== document.body; i++) {
    const parentStudioLinks = current.querySelectorAll('a[href*="/studios/"]');
    for (const link of parentStudioLinks) {
      const text = link.textContent?.trim();
      if (text && text.length > 0) {
        console.log("[StashDB-Whisparr] Found studio in parent:", text);
        return text;
      }
    }
    current = current.parentElement;
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
        console.log("[StashDB-Whisparr] Found studio by class:", text);
        return text;
      }
    }
  }
  
  console.log("[StashDB-Whisparr] Could not extract studio");
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
    'h3',
    '.scene-title',
    '[class*="Title"]',
    '[class*="title"]',
    '.title'
  ];
  
  for (const selector of titleSelectors) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent?.trim();
        // Make sure it's not navigation or other UI text, and not a date
        if (text && text.length > 3 && text.length < 300 && !text.match(/^\d{4}-\d{2}-\d{2}$/)) {
          console.log("[StashDB-Whisparr] Found page title from selector", selector, ":", text);
          metadata.title = text;
          break;
        }
      }
    } catch (e) {
      // Invalid selector, skip
    }
  }
  
  // Fallback to page title
  if (!metadata.title) {
    const pageTitle = document.title;
    // Usually in format "Scene Title | StashDB" or "Scene Title - StashDB" 
    const separators = ['|', ' - ', ' – ', ' — '];
    for (const sep of separators) {
      if (pageTitle.includes(sep)) {
        const parts = pageTitle.split(sep);
        if (parts.length > 0 && parts[0].trim().length > 0) {
          console.log("[StashDB-Whisparr] Found title from page title:", parts[0].trim());
          metadata.title = parts[0].trim();
          break;
        }
      }
    }
    // If no separator found, use the whole page title if reasonable
    if (!metadata.title && pageTitle.length > 0 && pageTitle.length < 200) {
      metadata.title = pageTitle;
    }
  }
  
  // Studio
  const studioLinks = document.querySelectorAll('a[href*="/studios/"]');
  for (const link of studioLinks) {
    const text = link.textContent?.trim();
    if (text && text.length > 0) {
      metadata.studio = text;
      console.log("[StashDB-Whisparr] Found studio:", text);
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
  if (metadata.performers.length > 0) {
    console.log("[StashDB-Whisparr] Found performers:", metadata.performers);
  }
  
  // Tags
  const tagLinks = document.querySelectorAll('a[href*="/tags/"]');
  tagLinks.forEach(link => {
    const text = link.textContent?.trim();
    if (text && text.length > 0 && !metadata.tags.includes(text)) {
      metadata.tags.push(text);
    }
  });
  if (metadata.tags.length > 0) {
    console.log("[StashDB-Whisparr] Found tags:", metadata.tags);
  }
  
  console.log("[StashDB-Whisparr] Extracted current scene metadata:", metadata);
  return metadata;
}

