#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";

const SERVER_INFO = { name: "server-web-extract", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-11-25";
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_MAX_ATTEMPTS = 2;

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function extractRequestId(request) {
  return String(request?.id ?? "unknown");
}

function decodeEntities(input) {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
}

function stripHtmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gis, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gis, " ")
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gis, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function getTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeEntities(match[1].trim()) : null;
}

function getMetaContent(html, nameOrProperty) {
  const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const match = html.match(regex);
  return match ? decodeEntities(match[1].trim()) : null;
}

function parseLinks(html, sourceUrl, sameDomainOnly = false) {
  const origin = new URL(sourceUrl);
  const links = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const inner = stripHtmlToText(match[2] ?? "");
    const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;

    let href;
    try {
      href = new URL(hrefMatch[1], sourceUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/.test(href.protocol)) continue;
    if (sameDomainOnly && href.hostname !== origin.hostname) continue;

    const relMatch = attrs.match(/rel\s*=\s*["']([^"']+)["']/i);
    const rel = (relMatch?.[1] ?? "").toLowerCase();

    links.push({
      text: inner || null,
      href: href.toString(),
      rel_nofollow: rel.includes("nofollow"),
      rel_sponsored: rel.includes("sponsored")
    });
  }

  return links;
}

function parseTables(html, maxTables = 5) {
  const tables = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null && tables.length < maxTables) {
    const tableHtml = tableMatch[1] ?? "";
    const captionMatch = tableHtml.match(/<caption[^>]*>([\s\S]*?)<\/caption>/i);
    const caption = captionMatch ? stripHtmlToText(captionMatch[1]) : null;

    const headers = [];
    const thRegex = /<th\b[^>]*>([\s\S]*?)<\/th>/gi;
    let thMatch;
    while ((thMatch = thRegex.exec(tableHtml)) !== null) {
      headers.push(stripHtmlToText(thMatch[1] ?? ""));
    }

    const rows = [];
    const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(tableHtml)) !== null) {
      const rowCells = [];
      const cellRegex = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(trMatch[1] ?? "")) !== null) {
        rowCells.push(stripHtmlToText(cellMatch[1] ?? ""));
      }
      if (rowCells.length > 0) rows.push(rowCells);
    }

    tables.push({ caption, headers, rows });
  }

  return tables;
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/\.local$/.test(h)) return true;
  return false;
}

function extractErrorCode(error) {
  if (error && typeof error === "object") {
    const code =
      (error.code && String(error.code)) ||
      (error.cause && typeof error.cause === "object" && error.cause.code
        ? String(error.cause.code)
        : "");
    return code || null;
  }
  return null;
}

function formatFetchError(error) {
  if (error?.name === "AbortError") {
    return "timeout: upstream fetch timed out";
  }

  const base = error instanceof Error ? error.message : String(error ?? "unknown_error");
  const code = extractErrorCode(error);

  return code ? `upstream_error: ${base} (${code})` : `upstream_error: ${base}`;
}

function isRetryableFetchError(error) {
  if (error?.name === "AbortError") return false;
  const code = extractErrorCode(error);
  if (code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "ECONNREFUSED"].includes(code)) {
    return true;
  }

  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("connection reset")
  );
}

async function fetchHtml(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("invalid_input: only https URLs are allowed");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error("invalid_input: private or local hostnames are not allowed");
  }

  let lastError = null;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "dock0-web-extract/0.1"
        }
      });

      if (!response.ok) {
        throw new Error(`upstream_error: HTTP ${response.status}`);
      }

      const arr = await response.arrayBuffer();
      if (arr.byteLength > MAX_BODY_BYTES) {
        throw new Error(`invalid_input: body too large (> ${MAX_BODY_BYTES} bytes)`);
      }

      const html = new TextDecoder("utf-8").decode(arr);
      return { html, finalUrl: response.url };
    } catch (error) {
      lastError = error;
      if (attempt < FETCH_MAX_ATTEMPTS && isRetryableFetchError(error)) {
        await delay(250);
        continue;
      }
      throw new Error(formatFetchError(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(formatFetchError(lastError));
}

function listToolsResult() {
  return {
    tools: [
      {
        name: "extract_page",
        description: "Extract title and clean readable text from a public HTTPS URL.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "Public HTTPS URL" },
            include_html: { type: "boolean", default: false },
            max_chars: { type: "number", default: 12000 }
          },
          required: ["url"]
        }
      },
      {
        name: "extract_links",
        description: "Extract links from a public page.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "Public HTTPS URL" },
            same_domain_only: { type: "boolean", default: false }
          },
          required: ["url"]
        }
      },
      {
        name: "extract_tables",
        description: "Extract HTML tables from a public page.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: { type: "string", description: "Public HTTPS URL" },
            max_tables: { type: "number", default: 5 }
          },
          required: ["url"]
        }
      }
    ]
  };
}

async function handleExtractPage(args, requestId) {
  if (typeof args?.url !== "string") {
    throw new Error("invalid_input: 'url' must be a string");
  }

  const maxChars = Math.max(100, Math.min(40_000, Number(args?.max_chars ?? 12_000)));
  const includeHtml = Boolean(args?.include_html);

  const { html, finalUrl } = await fetchHtml(args.url);
  const text = stripHtmlToText(html).slice(0, maxChars);

  return {
    request_id: requestId,
    title: getTitle(html),
    byline: getMetaContent(html, "author"),
    excerpt: getMetaContent(html, "description"),
    text,
    canonical_url: getMetaContent(html, "og:url") ?? finalUrl,
    published_at: getMetaContent(html, "article:published_time"),
    language: getMetaContent(html, "og:locale"),
    html: includeHtml ? html.slice(0, maxChars) : undefined
  };
}

async function handleExtractLinks(args, requestId) {
  if (typeof args?.url !== "string") {
    throw new Error("invalid_input: 'url' must be a string");
  }
  const sameDomainOnly = Boolean(args?.same_domain_only);
  const { html, finalUrl } = await fetchHtml(args.url);
  const links = parseLinks(html, finalUrl, sameDomainOnly);

  return {
    request_id: requestId,
    url: finalUrl,
    total: links.length,
    links
  };
}

async function handleExtractTables(args, requestId) {
  if (typeof args?.url !== "string") {
    throw new Error("invalid_input: 'url' must be a string");
  }
  const maxTables = Math.max(1, Math.min(20, Number(args?.max_tables ?? 5)));
  const { html, finalUrl } = await fetchHtml(args.url);
  const tables = parseTables(html, maxTables);

  return {
    request_id: requestId,
    url: finalUrl,
    total: tables.length,
    tables
  };
}

async function callToolResult(params, requestId) {
  const name = params?.name;
  const args = params?.arguments ?? {};

  if (name === "extract_page") return handleExtractPage(args, requestId);
  if (name === "extract_links") return handleExtractLinks(args, requestId);
  if (name === "extract_tables") return handleExtractTables(args, requestId);

  throw new Error(`invalid_input: unknown tool '${String(name ?? "")}'`);
}

function initializeResult(request) {
  const requestedVersion = request?.params?.protocolVersion;
  return {
    protocolVersion: typeof requestedVersion === "string" ? requestedVersion : DEFAULT_PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO
  };
}

async function handleRequest(request) {
  const id = request?.id ?? null;
  const method = request?.method;

  if (method === "initialize") return jsonRpcResult(id, initializeResult(request));
  if (method === "notifications/initialized") return jsonRpcResult(id, {});
  if (method === "ping") return jsonRpcResult(id, {});
  if (method === "tools/list") return jsonRpcResult(id, listToolsResult());

  if (method === "tools/call") {
    const requestId = extractRequestId(request);
    try {
      const structured = await callToolResult(request?.params, requestId);
      return jsonRpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: false
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal_error";
      return jsonRpcError(id, -32602, message);
    }
  }

  return jsonRpcError(id, -32601, `Method not found: ${String(method ?? "")}`);
}

async function main() {
  process.stdin.setEncoding("utf8");

  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      let request;
      try {
        request = JSON.parse(line);
      } catch {
        process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
        continue;
      }

      const response = await handleRequest(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const request = JSON.parse(tail);
      const response = await handleRequest(request);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32700, "Parse error"))}\n`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "internal_error";
  process.stdout.write(`${JSON.stringify(jsonRpcError(null, -32000, message))}\n`);
  process.exitCode = 1;
});
