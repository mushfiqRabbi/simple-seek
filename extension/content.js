/**
 * SimpleSeek Content Script
 *
 * Extracted by the background service worker when the user clicks
 * "Check" or "Apply" in the context menu.
 *
 * Reads the full page HTML and sends it to the background script
 * along with the action type (check vs apply).
 */

(function (action) {
  const html = document.documentElement.outerHTML;
  const url = window.location.href;

  chrome.runtime.sendMessage({
    type: "check-job",
    html,
    url,
    action: action || "apply",
  });
})(typeof action !== "undefined" ? action : "apply");
