// Get scene count from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const sceneCount = urlParams.get('count') || 0;

// Display the count
document.getElementById('sceneCount').textContent = sceneCount;

// Handle confirm button
document.getElementById('confirmBtn').addEventListener('click', () => {
  browser.runtime.sendMessage({
    action: 'confirmBulkAdd',
    confirmed: true
  });
});

// Handle cancel button
document.getElementById('cancelBtn').addEventListener('click', () => {
  browser.runtime.sendMessage({
    action: 'confirmBulkAdd',
    confirmed: false
  });
});

// Allow Enter key to confirm, Escape to cancel
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('confirmBtn').click();
  } else if (e.key === 'Escape') {
    document.getElementById('cancelBtn').click();
  }
});

