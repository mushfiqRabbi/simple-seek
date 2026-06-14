/**
 * Job Extractor
 *
 * Orchestrates the pipeline:
 *   1. Raw HTML → Clean Markdown (via Readability + Turndown)
 *   2. Raw HTML → Metadata extraction (location, deadline, etc.)
 *   3. Combined markdown + metadata → Structured JSON (via Pi RPC agent)
 *
 * Why two paths for extraction?
 * Readability strips job metadata (location, deadline) from the main content
 * because job sites put these in sidebars. So we extract metadata directly
 * from the raw HTML as well.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

// Initialize Turndown once
const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

/**
 * Extract job metadata directly from raw HTML by scanning for known patterns.
 * Job sites vary wildly, so we use multiple strategies per field.
 */
function extractMetadataFromHtml(html) {
  const meta = {};

  // ── Location ──────────────────────────────────────────────────────────
  // Matches: <tag>Job location</tag><tag>Gulshan 2</tag>
  const locationPatterns = [
    /<[^>]*>\s*Job\s*location\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*location\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Workplace\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Work\s*place\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
  ];
  for (const pattern of locationPatterns) {
    const match = html.match(pattern);
    if (match) {
      const val = match[1].trim();
      if (val && val.length > 1 && val.length < 200) {
        meta.location = val;
        break;
      }
    }
  }

  // ── Deadline ──────────────────────────────────────────────────────────
  // Matches: <tag>Application deadline</tag><tag>30 Jun, 2026</tag>
  const deadlinePatterns = [
    /<[^>]*>\s*Application\s*deadline\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*deadline\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Apply\s*by\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Closing\s*date\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
  ];
  for (const pattern of deadlinePatterns) {
    const match = html.match(pattern);
    if (match) {
      const val = match[1].trim();
      if (val && val.length > 1 && val.length < 100) {
        meta.deadline = val;
        break;
      }
    }
  }

  // ── Role Type (Full-time, Contract, etc.) ─────────────────────────────
  // Matches: <tag>Employment type</tag><tag>Full-time</tag>
  const rolePatterns = [
    /<[^>]*>\s*Employment\s*type\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Job\s*type\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
  ];
  for (const pattern of rolePatterns) {
    const match = html.match(pattern);
    if (match) {
      const val = match[1].trim();
      // "Type" is too generic — filter out non-role values
      const roleKeywords = /full.?time|part.?time|contract|internship|temporary|permanent|freelance|remote|on.?site|hybrid/i;
      if (val && val.length < 50 && roleKeywords.test(val)) {
        meta.role_type = val;
        break;
      }
    }
  }

  // ── Job ID / Requisition ID ──────────────────────────────────────────
  // Matches: <tag>Job ID</tag><tag>JATRI-123</tag>
  const idPatterns = [
    /<[^>]*>\s*Requisition\s*I[dD]\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Job\s*I[dD]\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
    /<[^>]*>\s*Vacancy\s*[cC]ode\s*<\/[^>]*>\s*<[^>]*>\s*([^<]+)\s*</i,
  ];
  for (const pattern of idPatterns) {
    const match = html.match(pattern);
    if (match) {
      const val = match[1].trim();
      if (val && val.length > 1 && val.length < 100 && !val.includes(" ")) {
        meta.job_id = val;
        break;
      }
    }
  }

  return meta;
}

/**
 * Convert raw HTML to Markdown.
 * Uses Readability for the main content, but also preserves metadata
 * extracted directly from the raw HTML (since Readability strips it).
 */
export function htmlToMarkdown(html, url) {
  let sourceDomain = null;
  try {
    sourceDomain = new URL(url).hostname;
  } catch { /* ignore invalid URLs */ }

  // Extract metadata from raw HTML first (before Readability eats it)
  const metadata = extractMetadataFromHtml(html);

  const dom = new JSDOM(html, { url });

  // Try Readability first to extract main content
  let article = null;
  try {
    article = new Readability(dom.window.document).parse();
  } catch { /* readability may fail on some pages */ }

  let markdown;
  if (article && article.content) {
    markdown = turndown.turndown(article.content);
    if (article.title) {
      markdown = `# ${article.title}\n\n${markdown}`;
    }
  } else {
    // Fallback: convert entire body
    const body = dom.window.document.body;
    markdown = body ? turndown.turndown(body.innerHTML) : "";
  }

  // Prepend metadata block to the markdown so Pi has it explicitly
  const metaLines = [];
  if (metadata.location) metaLines.push(`**Location:** ${metadata.location}`);
  if (metadata.deadline) metaLines.push(`**Deadline:** ${metadata.deadline}`);
  if (metadata.role_type) metaLines.push(`**Role Type:** ${metadata.role_type}`);
  if (metadata.job_id) metaLines.push(`**Job ID:** ${metadata.job_id}`);

  if (metaLines.length > 0) {
    markdown = `---\n${metaLines.join("\n")}\n---\n\n${markdown}`;
  }

  return { markdown, sourceDomain, metadata };
}

/**
 * Extract structured job information from raw HTML using Pi RPC.
 */
export async function extractJobInfo(html, url, piClient) {
  // Step 1: Convert HTML to Markdown (with metadata prepended)
  const { markdown, sourceDomain, metadata } = htmlToMarkdown(html, url);

  console.log(`[extractor] HTML metadata extracted:`, JSON.stringify(metadata));

  // Step 2: Send to Pi for extraction (it gets the full markdown + metadata)
  let extracted = {};
  try {
    extracted = await piClient.extractJobInfo(markdown);
  } catch (err) {
    console.error(`[extractor] Pi extraction failed:`, err.message);
    extracted = {};
  }

  // Step 3: Merge Pi-extracted data with direct HTML metadata
  // Direct HTML extraction is more reliable for location/deadline,
  // so fill in any nulls from HTML metadata
  if (!extracted.location && metadata.location) extracted.location = metadata.location;
  if (!extracted.deadline && metadata.deadline) extracted.deadline = metadata.deadline;
  if (!extracted.role_type && metadata.role_type) extracted.role_type = metadata.role_type;
  if (!extracted.job_id && metadata.job_id) extracted.job_id = metadata.job_id;
  if (!extracted.company && metadata.company) extracted.company = metadata.company;

  return { extracted, markdown, sourceDomain };
}
