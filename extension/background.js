/**
 * SimpleSeek Background Service Worker
 *
 * - Registers the right-click context menu on install
 * - Injects content script when "Check" or "Apply" is clicked
 * - Makes API calls to the SimpleSeek server
 * - Displays notifications with results
 */

const SERVER_URL = "http://localhost:3001";

// ─── Context Menu Setup ─────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "simpleseek-parent",
    title: "SimpleSeek",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "check",
    title: "Check Duplicate",
    parentId: "simpleseek-parent",
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "apply",
    title: "Check && Save",
    parentId: "simpleseek-parent",
    contexts: ["page"],
  });
});

// ─── Context Menu Click Handler ─────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "check" || info.menuItemId === "apply") {
    // Inject content script with the action parameter
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (action) => {
        const html = document.documentElement.outerHTML;
        const url = window.location.href;
        chrome.runtime.sendMessage({
          type: "check-job",
          html,
          url,
          action,
        });
      },
      args: [info.menuItemId],
    });
  }
});

// ─── Notification Click Handler ───────────────────────────────────────────

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: `${SERVER_URL}/` });
});

// ─── Message Handler (from content script) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "check-job") {
    handleCheckJob(message);
    return true;
  }
});

/**
 * Send the job HTML to the SimpleSeek server and display the result.
 */
async function handleCheckJob({ html, url, action }) {
  // Update badge to show we're processing
  chrome.action.setBadgeText({ text: "..." });
  chrome.action.setBadgeBackgroundColor({ color: "#FFA500" });

  try {
    const response = await fetch(`${SERVER_URL}/api/check-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, url, action }),
    });

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    const data = await response.json();

    if (data.status === "duplicate") {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "⚠️ Already Applied",
        message: data.message,
        contextMessage: `Job: ${data.existingJob?.title || "Unknown"} at ${data.existingJob?.company || "Unknown"}`,
      });
      chrome.action.setBadgeText({ text: "DUP" });
      chrome.action.setBadgeBackgroundColor({ color: "#FFA500" });
    } else if (data.status === "new") {
      if (action === "check") {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "✅ No Duplicate Found",
          message: "This job hasn't been applied to yet.",
          contextMessage: `Job: ${data.job?.title || "Unknown"} at ${data.job?.company || "Unknown"}`,
        });
      } else {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "✅ New Job Saved",
          message: data.message,
          contextMessage: `Job: ${data.job?.title || "Unknown"} at ${data.job?.company || "Unknown"}`,
        });
      }
      chrome.action.setBadgeText({ text: "NEW" });
      chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    } else {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "❓ Unexpected Response",
        message: data.message || "Unknown status from server",
      });
      chrome.action.setBadgeText({ text: "?" });
      chrome.action.setBadgeBackgroundColor({ color: "#F44336" });
    }
  } catch (err) {
    console.error("[SimpleSeek] API call failed:", err);

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "❌ Error",
      message: `Failed to check job: ${err.message}`,
      contextMessage: "Is the SimpleSeek server running?",
    });

    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#F44336" });
  }

  // Clear badge after 6 seconds
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, 6000);
}
