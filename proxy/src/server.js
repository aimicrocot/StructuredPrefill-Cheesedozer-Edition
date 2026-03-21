'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const {
    DEFAULT_PROXY_CONFIG,
    createUsageText,
    rewriteProxyJsonRequest,
    rewriteProxyJsonResponse,
    tryUnwrapStructuredOutput,
} = require('./structured-prefill-core');
const {
    applyPrefillGeneratorToRequest,
} = require('./prefill-generator');
const {
    createLiveConfigStore,
    normalizeRuntimeConfig,
    refreshLiveConfigStore,
    renderRuntimeConfigYaml,
    resolveUpstreamTargetUrl,
} = require('./proxy-config');

const REQUEST_CONTROL_HEADER_PREFIX = 'x-structured-prefill-';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-length',
]);

function isTrustedOriginHost(hostname) {
    const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;

    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!ipv4Match) return false;
    const octets = ipv4Match.slice(1).map(Number);
    if (octets.some((value) => value < 0 || value > 255)) return false;

    if (octets[0] === 10 || octets[0] === 127) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    return false;
}

function getAllowedCorsOrigin(req) {
    const origin = String(req?.headers?.origin ?? '').trim();
    if (!origin) return '';

    try {
        const url = new URL(origin);
        if (!/^https?:$/i.test(url.protocol)) return '';
        return isTrustedOriginHost(url.hostname) ? origin : '';
    } catch {
        return '';
    }
}

function setCorsHeaders(res, corsOrigin = '') {
    if (!corsOrigin) return;
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
}

function isJsonContentType(contentType) {
    return /\bapplication\/(?:json|[a-z0-9.+-]+\+json)\b/i.test(String(contentType ?? ''));
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function buildProxyHeaders(rawHeaders, contentTypeOverride) {
    const headers = new Headers();

    for (const [key, value] of Object.entries(rawHeaders ?? {})) {
        const lower = String(key).toLowerCase();
        if (!value) continue;
        if (HOP_BY_HOP_HEADERS.has(lower)) continue;
        if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'accept-encoding') continue;
        if (lower.startsWith('sec-')) continue;
        if (lower.startsWith(REQUEST_CONTROL_HEADER_PREFIX)) continue;

        if (Array.isArray(value)) {
            for (const entry of value) headers.append(key, String(entry));
            continue;
        }

        headers.set(key, String(value));
    }

    if (contentTypeOverride) {
        headers.set('content-type', contentTypeOverride);
    }

    return headers;
}

function applyResponseHeaders(res, upstreamHeaders, extraHeaders = {}, contentLength) {
    for (const [key, value] of upstreamHeaders.entries()) {
        const lower = key.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower)) continue;
        if (lower === 'content-length') continue;
        if (lower === 'content-encoding') continue;
        res.setHeader(key, value);
    }

    for (const [key, value] of Object.entries(extraHeaders)) {
        if (value == null) continue;
        res.setHeader(key, value);
    }

    if (Number.isFinite(contentLength)) {
        res.setHeader('Content-Length', String(contentLength));
    }
}

function writeJson(res, statusCode, payload, corsOrigin = '') {
    const buffer = Buffer.from(JSON.stringify(payload));
    res.statusCode = statusCode;
    setCorsHeaders(res, corsOrigin);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
}

function writeText(res, statusCode, text, corsOrigin = '') {
    const buffer = Buffer.from(String(text ?? ''), 'utf8');
    res.statusCode = statusCode;
    setCorsHeaders(res, corsOrigin);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
}

function writeHtml(res, statusCode, html, corsOrigin = '') {
    const buffer = Buffer.from(String(html ?? ''), 'utf8');
    res.statusCode = statusCode;
    setCorsHeaders(res, corsOrigin);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function boolFromInput(value) {
    return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function intFromInput(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.trunc(num);
}

function readConfigFileText(configPath) {
    try {
        return fs.readFileSync(configPath, 'utf8');
    } catch {
        return '';
    }
}

function buildEditorRawConfig(payload, currentConfig) {
    const current = currentConfig ?? normalizeRuntimeConfig({});
    return {
        server: {
            host: String(payload?.server?.host ?? current.server.host),
            port: intFromInput(payload?.server?.port, current.server.port),
        },
        routing: {
            allow_full_url_targets: boolFromInput(payload?.routing?.allow_full_url_targets),
            openai_base_url: String(payload?.routing?.openai_base_url ?? current.routing.openAiBaseUrl),
            openrouter_base_url: String(payload?.routing?.openrouter_base_url ?? current.routing.openRouterBaseUrl),
            openai_compatible_base_url: String(payload?.routing?.openai_compatible_base_url ?? current.routing.openAiCompatibleBaseUrl),
            anthropic_base_url: String(payload?.routing?.anthropic_base_url ?? current.routing.anthropicBaseUrl),
            google_base_url: String(payload?.routing?.google_base_url ?? current.routing.googleBaseUrl),
        },
        structured_prefill: {
            enabled: boolFromInput(payload?.structured_prefill?.enabled),
            min_chars_after_prefix: intFromInput(payload?.structured_prefill?.min_chars_after_prefix, current.structuredPrefill.minCharsAfterPrefix),
            newline_token: String(payload?.structured_prefill?.newline_token ?? current.structuredPrefill.newlineToken),
            hide_prefill_in_display: boolFromInput(payload?.structured_prefill?.hide_prefill_in_display),
            anti_slop_ban_list: String(payload?.structured_prefill?.anti_slop_ban_list ?? current.structuredPrefill.antiSlopBanList),
            continue: {
                mode: String(payload?.structured_prefill?.continue?.mode ?? current.structuredPrefill.continueMode),
                overlap_chars: intFromInput(payload?.structured_prefill?.continue?.overlap_chars, current.structuredPrefill.continueOverlapChars),
            },
            prefill_generator: {
                enabled: boolFromInput(payload?.structured_prefill?.prefill_generator?.enabled),
                provider: String(payload?.structured_prefill?.prefill_generator?.provider ?? current.structuredPrefill.prefillGenerator.provider),
                target_url: String(payload?.structured_prefill?.prefill_generator?.target_url ?? current.structuredPrefill.prefillGenerator.targetUrl),
                api_key: String(payload?.structured_prefill?.prefill_generator?.api_key ?? current.structuredPrefill.prefillGenerator.apiKey),
                api_key_header: String(payload?.structured_prefill?.prefill_generator?.api_key_header ?? current.structuredPrefill.prefillGenerator.apiKeyHeader),
                api_key_prefix: String(payload?.structured_prefill?.prefill_generator?.api_key_prefix ?? current.structuredPrefill.prefillGenerator.apiKeyPrefix),
                extra_headers: String(payload?.structured_prefill?.prefill_generator?.extra_headers ?? current.structuredPrefill.prefillGenerator.extraHeaders),
                model: String(payload?.structured_prefill?.prefill_generator?.model ?? current.structuredPrefill.prefillGenerator.model),
                max_tokens: intFromInput(payload?.structured_prefill?.prefill_generator?.max_tokens, current.structuredPrefill.prefillGenerator.maxTokens),
                timeout_ms: intFromInput(payload?.structured_prefill?.prefill_generator?.timeout_ms, current.structuredPrefill.prefillGenerator.timeoutMs),
                stop: String(payload?.structured_prefill?.prefill_generator?.stop ?? (Array.isArray(current.structuredPrefill.prefillGenerator.stopStrings) ? current.structuredPrefill.prefillGenerator.stopStrings.join('\n') : '')),
                keep_matched_stop_string: boolFromInput(payload?.structured_prefill?.prefill_generator?.keep_matched_stop_string),
                extra_prompt: String(payload?.structured_prefill?.prefill_generator?.extra_prompt ?? current.structuredPrefill.prefillGenerator.extraPrompt),
                extra_prompt_role: String(payload?.structured_prefill?.prefill_generator?.extra_prompt_role ?? current.structuredPrefill.prefillGenerator.extraPromptRole),
            },
        },
    };
}

function renderConfigEditorHtml({ listenPort, runtimeConfig, rawConfigText }) {
    const cfg = runtimeConfig ?? normalizeRuntimeConfig({});
    const pg = cfg.structuredPrefill.prefillGenerator;
    const stopStrings = Array.isArray(pg.stopStrings) ? pg.stopStrings.join('\n') : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StructuredPrefill Proxy</title>
<style>
:root{color-scheme:light;--bg:#f2eee5;--paper:#fffdf8;--line:#d4cbbb;--ink:#191713;--muted:#62594c;--accent:#174f48;--danger:#8a3124}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 "Segoe UI",Tahoma,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:24px}
.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:18px}
h1{margin:0;font:600 22px/1.1 Georgia,"Times New Roman",serif;letter-spacing:.01em}
.meta{color:var(--muted);font-size:12px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.card{background:var(--paper);border:1px solid var(--line);padding:14px}
.card.wide{grid-column:1/-1}
h2{margin:0 0 12px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 12px}
.field{display:flex;flex-direction:column;gap:5px}
.field.full{grid-column:1/-1}
label{font-size:12px;color:var(--muted)}
input,select,textarea,button{font:inherit}
input,select,textarea{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:0;background:#fff;color:var(--ink)}
textarea{min-height:108px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}
.yaml{min-height:240px}
.checks{display:flex;flex-wrap:wrap;gap:14px}
.check{display:flex;align-items:center;gap:8px}
.check input{width:auto}
.actions{display:flex;align-items:center;gap:12px;margin:16px 0 10px}
button{border:1px solid var(--ink);background:var(--ink);color:#fff;padding:10px 16px;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.status{font-size:12px;color:var(--muted);min-height:18px}
.status.ok{color:var(--accent)}
.status.error{color:var(--danger)}
.bases{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:12px;color:var(--muted);margin:10px 0 0}
details{margin-top:14px;background:var(--paper);border:1px solid var(--line);padding:12px}
summary{cursor:pointer;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.hint{margin:0 0 10px;color:var(--muted);font-size:12px}
@media (max-width:900px){.grid,.fields{grid-template-columns:1fr}.top{display:block}.top>div:last-child{margin-top:8px}}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>StructuredPrefill Proxy</h1>
      <div class="bases">
        <span>OpenRouter: <code>http://localhost:${listenPort}/openrouter</code></span>
        <span>OpenAI: <code>http://localhost:${listenPort}/openai</code></span>
        <span>Anthropic: <code>http://localhost:${listenPort}/anthropic</code></span>
        <span>Gemini: <code>http://localhost:${listenPort}/google</code></span>
      </div>
    </div>
    <div class="meta">
      <div>Editing <code>config.yaml</code></div>
      <div>Host and port still need a restart.</div>
    </div>
  </div>

  <form id="config-form">
    <div class="grid">
      <section class="card">
        <h2>Server</h2>
        <div class="fields">
          <div class="field">
            <label for="server-host">Host</label>
            <input id="server-host" value="${escapeHtml(cfg.server.host)}">
          </div>
          <div class="field">
            <label for="server-port">Port</label>
            <input id="server-port" type="number" min="1" max="65535" value="${cfg.server.port}">
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Routes</h2>
        <div class="checks">
          <label class="check"><input id="routing-allow-full" type="checkbox" ${cfg.routing.allowFullUrlTargets ? 'checked' : ''}>Allow full URL targets</label>
        </div>
        <div class="fields" style="margin-top:10px">
          <div class="field full">
            <label for="route-openai-compatible">Default OpenAI-compatible base</label>
            <input id="route-openai-compatible" value="${escapeHtml(cfg.routing.openAiCompatibleBaseUrl.replace(/\/$/, ''))}">
          </div>
          <div class="field full">
            <label for="route-openrouter">OpenRouter base</label>
            <input id="route-openrouter" value="${escapeHtml(cfg.routing.openRouterBaseUrl.replace(/\/$/, ''))}">
          </div>
          <div class="field full">
            <label for="route-openai">OpenAI base</label>
            <input id="route-openai" value="${escapeHtml(cfg.routing.openAiBaseUrl.replace(/\/$/, ''))}">
          </div>
          <div class="field full">
            <label for="route-anthropic">Anthropic base</label>
            <input id="route-anthropic" value="${escapeHtml(cfg.routing.anthropicBaseUrl.replace(/\/$/, ''))}">
          </div>
          <div class="field full">
            <label for="route-google">Google base</label>
            <input id="route-google" value="${escapeHtml(cfg.routing.googleBaseUrl.replace(/\/$/, ''))}">
          </div>
        </div>
      </section>

      <section class="card wide">
        <h2>Structured Prefill</h2>
        <div class="checks">
          <label class="check"><input id="sp-enabled" type="checkbox" ${cfg.structuredPrefill.enabled ? 'checked' : ''}>Enabled</label>
          <label class="check"><input id="sp-hide-prefill" type="checkbox" ${cfg.structuredPrefill.hidePrefillInDisplay ? 'checked' : ''}>Hide prefill in display</label>
        </div>
        <div class="fields" style="margin-top:10px">
          <div class="field">
            <label for="sp-min-chars">Min chars after prefix</label>
            <input id="sp-min-chars" type="number" min="1" max="10000" value="${cfg.structuredPrefill.minCharsAfterPrefix}">
          </div>
          <div class="field">
            <label for="sp-newline-token">Newline token</label>
            <input id="sp-newline-token" value="${escapeHtml(cfg.structuredPrefill.newlineToken)}">
          </div>
          <div class="field">
            <label for="sp-continue-mode">Continue mode</label>
            <select id="sp-continue-mode">
              <option value="off" ${cfg.structuredPrefill.continueMode === 'off' ? 'selected' : ''}>off</option>
              <option value="auto" ${cfg.structuredPrefill.continueMode === 'auto' ? 'selected' : ''}>auto</option>
              <option value="force" ${cfg.structuredPrefill.continueMode === 'force' ? 'selected' : ''}>force</option>
            </select>
          </div>
          <div class="field">
            <label for="sp-overlap">Continue overlap chars</label>
            <input id="sp-overlap" type="number" min="0" max="240" value="${cfg.structuredPrefill.continueOverlapChars}">
          </div>
          <div class="field full">
            <label for="sp-anti-slop">Anti-slop ban list</label>
            <textarea id="sp-anti-slop">${escapeHtml(cfg.structuredPrefill.antiSlopBanList)}</textarea>
          </div>
        </div>
      </section>

      <section class="card wide">
        <h2>Prefill Generator</h2>
        <p class="hint">Leave target URL empty to use the same backend as the main request. Set a full endpoint URL plus provider and key if you want \`[[pg]]\` to use a different API entirely.</p>
        <div class="checks">
          <label class="check"><input id="pg-enabled" type="checkbox" ${pg.enabled ? 'checked' : ''}>Enabled</label>
          <label class="check"><input id="pg-keep-stop" type="checkbox" ${pg.keepMatchedStopString ? 'checked' : ''}>Keep matched stop string</label>
        </div>
        <div class="fields" style="margin-top:10px">
          <div class="field">
            <label for="pg-provider">Provider</label>
            <select id="pg-provider">
              <option value="auto" ${pg.provider === 'auto' ? 'selected' : ''}>auto</option>
              <option value="openai-chat" ${pg.provider === 'openai-chat' ? 'selected' : ''}>openai-chat</option>
              <option value="openai-responses" ${pg.provider === 'openai-responses' ? 'selected' : ''}>openai-responses</option>
              <option value="anthropic-messages" ${pg.provider === 'anthropic-messages' ? 'selected' : ''}>anthropic-messages</option>
              <option value="gemini-generate-content" ${pg.provider === 'gemini-generate-content' ? 'selected' : ''}>gemini-generate-content</option>
            </select>
          </div>
          <div class="field">
            <label for="pg-model">Model override</label>
            <input id="pg-model" value="${escapeHtml(pg.model)}" placeholder="optional">
          </div>
          <div class="field full">
            <label for="pg-target-url">Full generator endpoint URL</label>
            <input id="pg-target-url" value="${escapeHtml(pg.targetUrl)}" placeholder="https://.../v1/chat/completions">
          </div>
          <div class="field">
            <label for="pg-api-key">API key</label>
            <input id="pg-api-key" type="password" value="${escapeHtml(pg.apiKey)}" placeholder="optional" autocomplete="off" spellcheck="false">
          </div>
          <div class="field">
            <label for="pg-api-key-header">API key header</label>
            <input id="pg-api-key-header" value="${escapeHtml(pg.apiKeyHeader)}" placeholder="authorization / x-api-key / x-goog-api-key">
          </div>
          <div class="field">
            <label for="pg-api-key-prefix">API key prefix</label>
            <input id="pg-api-key-prefix" value="${escapeHtml(pg.apiKeyPrefix)}" placeholder="Bearer ">
          </div>
          <div class="field">
            <label for="pg-max-tokens">Max tokens</label>
            <input id="pg-max-tokens" type="number" min="1" max="1000000" value="${pg.maxTokens}">
          </div>
          <div class="field">
            <label for="pg-timeout">Timeout ms</label>
            <input id="pg-timeout" type="number" min="500" max="120000" value="${pg.timeoutMs}">
          </div>
          <div class="field">
            <label for="pg-extra-prompt-role">Extra prompt role</label>
            <select id="pg-extra-prompt-role">
              <option value="system" ${pg.extraPromptRole === 'system' ? 'selected' : ''}>system</option>
              <option value="user" ${pg.extraPromptRole === 'user' ? 'selected' : ''}>user</option>
              <option value="assistant" ${pg.extraPromptRole === 'assistant' ? 'selected' : ''}>assistant</option>
            </select>
          </div>
          <div class="field full">
            <label for="pg-extra-headers">Extra headers</label>
            <textarea id="pg-extra-headers" placeholder="Header-Name: value">${escapeHtml(pg.extraHeaders)}</textarea>
          </div>
          <div class="field full">
            <label for="pg-stop">Stop strings</label>
            <textarea id="pg-stop">${escapeHtml(stopStrings)}</textarea>
          </div>
          <div class="field full">
            <label for="pg-extra-prompt">Extra prompt</label>
            <textarea id="pg-extra-prompt">${escapeHtml(pg.extraPrompt)}</textarea>
          </div>
        </div>
      </section>
    </div>

    <div class="actions">
      <button id="save-button" type="submit">Save</button>
      <a href="/config.yaml" target="_blank" rel="noreferrer">Raw YAML</a>
      <span id="status" class="status"></span>
    </div>
  </form>

  <details>
    <summary>Raw config.yaml</summary>
    <textarea id="yaml-preview" class="yaml" readonly>${escapeHtml(rawConfigText)}</textarea>
  </details>
</div>
<script>
const form = document.getElementById('config-form');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save-button');
const yamlPreview = document.getElementById('yaml-preview');

function payload() {
  return {
    server: {
      host: document.getElementById('server-host').value,
      port: document.getElementById('server-port').value,
    },
    routing: {
      allow_full_url_targets: document.getElementById('routing-allow-full').checked,
      openai_base_url: document.getElementById('route-openai').value,
      openrouter_base_url: document.getElementById('route-openrouter').value,
      openai_compatible_base_url: document.getElementById('route-openai-compatible').value,
      anthropic_base_url: document.getElementById('route-anthropic').value,
      google_base_url: document.getElementById('route-google').value,
    },
    structured_prefill: {
      enabled: document.getElementById('sp-enabled').checked,
      min_chars_after_prefix: document.getElementById('sp-min-chars').value,
      newline_token: document.getElementById('sp-newline-token').value,
      hide_prefill_in_display: document.getElementById('sp-hide-prefill').checked,
      anti_slop_ban_list: document.getElementById('sp-anti-slop').value,
      continue: {
        mode: document.getElementById('sp-continue-mode').value,
        overlap_chars: document.getElementById('sp-overlap').value,
      },
      prefill_generator: {
        enabled: document.getElementById('pg-enabled').checked,
        provider: document.getElementById('pg-provider').value,
        target_url: document.getElementById('pg-target-url').value,
        api_key: document.getElementById('pg-api-key').value,
        api_key_header: document.getElementById('pg-api-key-header').value,
        api_key_prefix: document.getElementById('pg-api-key-prefix').value,
        extra_headers: document.getElementById('pg-extra-headers').value,
        model: document.getElementById('pg-model').value,
        max_tokens: document.getElementById('pg-max-tokens').value,
        timeout_ms: document.getElementById('pg-timeout').value,
        stop: document.getElementById('pg-stop').value,
        keep_matched_stop_string: document.getElementById('pg-keep-stop').checked,
        extra_prompt: document.getElementById('pg-extra-prompt').value,
        extra_prompt_role: document.getElementById('pg-extra-prompt-role').value,
      },
    },
  };
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  statusEl.className = 'status';
  statusEl.textContent = 'Saving...';

  try {
    const response = await fetch('/__config', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload()),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.message || 'Failed to save config.');
    }
    yamlPreview.value = data.yaml || '';
    statusEl.className = 'status ok';
    statusEl.textContent = data.message || 'Saved.';
  } catch (error) {
    statusEl.className = 'status error';
    statusEl.textContent = error && error.message ? error.message : 'Failed to save config.';
  } finally {
    saveButton.disabled = false;
  }
});
</script>
</body>
</html>`;
}

function buildBaseConfig(runtimeConfig) {
    return {
        ...DEFAULT_PROXY_CONFIG,
        enabled: runtimeConfig.structuredPrefill.enabled,
        minCharsAfterPrefix: runtimeConfig.structuredPrefill.minCharsAfterPrefix,
        newlineToken: runtimeConfig.structuredPrefill.newlineToken,
        hidePrefillInDisplay: runtimeConfig.structuredPrefill.hidePrefillInDisplay,
        antiSlopBanList: runtimeConfig.structuredPrefill.antiSlopBanList,
        continueMode: runtimeConfig.structuredPrefill.continueMode,
        continueOverlapChars: runtimeConfig.structuredPrefill.continueOverlapChars,
    };
}

function extractOpenAiSseText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    let out = '';
    for (const item of content) {
        if (typeof item === 'string') {
            out += item;
            continue;
        }
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') {
            out += item.text;
            continue;
        }
        if (typeof item.input_text === 'string') {
            out += item.input_text;
        }
    }

    return out;
}

function buildOpenAiChatSseBody(jsonBody) {
    const response = jsonBody && typeof jsonBody === 'object' ? jsonBody : {};
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const id = String(response.id ?? `chatcmpl-proxy-${crypto.randomUUID()}`);
    const created = Number.isFinite(response.created) ? Number(response.created) : Math.floor(Date.now() / 1000);
    const model = String(response.model ?? '');
    const systemFingerprint = response.system_fingerprint ?? null;
    const lines = [];

    for (let index = 0; index < choices.length; index++) {
        const choice = choices[index] ?? {};
        const choiceIndex = Number.isInteger(choice.index) ? choice.index : index;
        const content = extractOpenAiSseText(choice?.message?.content);

        if (content) {
            lines.push(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                system_fingerprint: systemFingerprint,
                choices: [{
                    index: choiceIndex,
                    delta: {
                        role: 'assistant',
                        content,
                    },
                    logprobs: choice.logprobs ?? null,
                    finish_reason: null,
                }],
            })}\n\n`);
        }

        lines.push(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            system_fingerprint: systemFingerprint,
            choices: [{
                index: choiceIndex,
                delta: {},
                logprobs: choice.logprobs ?? null,
                finish_reason: choice.finish_reason ?? choice.native_finish_reason ?? 'stop',
            }],
        })}\n\n`);
    }

    lines.push('data: [DONE]\n\n');
    return lines.join('');
}

function shouldReturnOpenAiChatSse(requestContext) {
    return Boolean(requestContext?.clientRequestedStream) && requestContext?.provider === 'openai-chat';
}

function isErrorPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (payload.error != null) return true;
    if (payload.detail != null && !Array.isArray(payload.choices)) return true;
    if (typeof payload.message === 'string' && !Array.isArray(payload.choices)) return true;
    return false;
}

function extractJsonPayloadFromSseText(sseText) {
    const text = String(sseText ?? '');
    const eventBlocks = text.split(/\r?\n\r?\n/g);
    let fallbackPayload = null;

    for (const eventBlock of eventBlocks) {
        const dataLines = [];
        for (const line of String(eventBlock ?? '').split(/\r?\n/g)) {
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        if (dataLines.length === 0) continue;
        const data = dataLines.join('\n');
        if (data === '[DONE]') continue;

        try {
            const parsed = JSON.parse(data);
            if (isErrorPayload(parsed)) return parsed;
            fallbackPayload = parsed;
        } catch {
            continue;
        }
    }

    return isErrorPayload(fallbackPayload) ? fallbackPayload : null;
}

function buildVisibleErrorPayload(upstreamResponse, text) {
    const message = String(text ?? '').trim() || upstreamResponse.statusText || `Upstream request failed with status ${upstreamResponse.status}`;
    return {
        error: {
            message,
            status: upstreamResponse.status,
            status_text: upstreamResponse.statusText || '',
        },
    };
}

function normalizeUpstreamError(upstreamResponse, upstreamText, upstreamContentType) {
    const rawText = String(upstreamText ?? '');
    const trimmed = rawText.trim();
    const contentType = String(upstreamContentType ?? '');

    if (isJsonContentType(contentType) && trimmed) {
        try {
            return {
                contentType: 'application/json; charset=utf-8',
                bodyText: JSON.stringify(JSON.parse(trimmed)),
            };
        } catch {
            return {
                contentType: 'application/json; charset=utf-8',
                bodyText: JSON.stringify(buildVisibleErrorPayload(upstreamResponse, trimmed)),
            };
        }
    }

    if (/text\/event-stream/i.test(contentType)) {
        const extracted = extractJsonPayloadFromSseText(trimmed);
        if (extracted) {
            return {
                contentType: 'application/json; charset=utf-8',
                bodyText: JSON.stringify(extracted),
            };
        }
    }

    return {
        contentType: 'application/json; charset=utf-8',
        bodyText: JSON.stringify(buildVisibleErrorPayload(upstreamResponse, trimmed)),
    };
}

function getStructuredStreamVisibleText(rawText, context, previousVisible = '') {
    const raw = String(rawText ?? '');
    const visible = tryUnwrapStructuredOutput(raw, context);
    if (typeof visible === 'string') return visible;
    if (raw.trimStart().startsWith('{')) return String(previousVisible ?? '');
    return String(previousVisible ?? '');
}

function transformOpenAiChatStreamChunk(chunk, context, streamState) {
    if (!chunk || typeof chunk !== 'object' || !Array.isArray(chunk.choices)) {
        return null;
    }

    const nextChoices = [];
    for (let i = 0; i < chunk.choices.length; i++) {
        const choice = chunk.choices[i] ?? {};
        const choiceIndex = Number.isInteger(choice.index) ? choice.index : i;
        const delta = choice?.delta && typeof choice.delta === 'object' ? { ...choice.delta } : {};
        const rawDeltaContent = extractOpenAiSseText(delta.content);
        const previousRaw = streamState.rawByChoice.get(choiceIndex) ?? '';
        const previousVisible = streamState.visibleByChoice.get(choiceIndex) ?? '';

        let visibleAppend = '';
        if (rawDeltaContent) {
            const nextRaw = previousRaw + rawDeltaContent;
            streamState.rawByChoice.set(choiceIndex, nextRaw);

            const nextVisible = getStructuredStreamVisibleText(nextRaw, context, previousVisible);
            if (nextVisible.startsWith(previousVisible)) {
                visibleAppend = nextVisible.slice(previousVisible.length);
            } else if (!previousVisible && nextVisible) {
                visibleAppend = nextVisible;
            }

            streamState.visibleByChoice.set(choiceIndex, nextVisible);
        }

        const keepRoleOnly = typeof delta.role === 'string' && !rawDeltaContent;
        const finishReason = choice.finish_reason ?? null;

        if (visibleAppend) {
            delta.content = visibleAppend;
        } else {
            delete delta.content;
        }

        if (!visibleAppend && !keepRoleOnly && finishReason == null) {
            continue;
        }

        nextChoices.push({
            ...choice,
            delta,
        });
    }

    if (nextChoices.length === 0) return null;
    return {
        ...chunk,
        choices: nextChoices,
    };
}

async function forwardStructuredOpenAiChatStream(upstreamResponse, res, requestContext, extraHeaders = {}, corsOrigin = '') {
    res.statusCode = upstreamResponse.status;
    applyResponseHeaders(res, upstreamResponse.headers, {
        ...extraHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    setCorsHeaders(res, corsOrigin);

    if (!upstreamResponse.body) {
        res.end();
        return;
    }

    const streamState = {
        rawByChoice: new Map(),
        visibleByChoice: new Map(),
    };
    let buffer = '';
    let sawDone = false;

    const processEventBlock = (eventBlock) => {
        const dataLines = [];
        for (const line of String(eventBlock ?? '').split(/\r?\n/g)) {
            if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        if (dataLines.length === 0) return;
        const data = dataLines.join('\n');

        if (data === '[DONE]') {
            sawDone = true;
            res.write('data: [DONE]\n\n');
            return;
        }

        let parsed;
        try {
            parsed = JSON.parse(data);
        } catch {
            return;
        }

        if (isErrorPayload(parsed)) {
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
            return;
        }

        const transformed = transformOpenAiChatStreamChunk(parsed, requestContext, streamState);
        if (transformed) {
            res.write(`data: ${JSON.stringify(transformed)}\n\n`);
        }
    };

    for await (const chunk of Readable.fromWeb(upstreamResponse.body)) {
        buffer += Buffer.from(chunk).toString('utf8');

        while (true) {
            const match = /\r?\n\r?\n/.exec(buffer);
            if (!match || match.index == null) break;
            const endIndex = match.index;
            const eventBlock = buffer.slice(0, endIndex);
            buffer = buffer.slice(endIndex + match[0].length);
            processEventBlock(eventBlock);
        }
    }

    if (buffer.trim()) {
        processEventBlock(buffer);
    }

    if (!sawDone) {
        res.write('data: [DONE]\n\n');
    }
    res.end();
}

async function forwardUpstreamErrorResponse(upstreamResponse, res, extraHeaders = {}, corsOrigin = '') {
    const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
    const upstreamText = await upstreamResponse.text();
    const normalized = normalizeUpstreamError(upstreamResponse, upstreamText, upstreamContentType);
    const buffer = Buffer.from(normalized.bodyText, 'utf8');

    res.statusCode = upstreamResponse.status;
    applyResponseHeaders(res, upstreamResponse.headers, {
        ...extraHeaders,
        'Content-Type': normalized.contentType,
    }, buffer.length);
    setCorsHeaders(res, corsOrigin);
    res.end(buffer);
}

async function handleProxyRequest(req, res, serverState) {
    const liveConfigStore = refreshLiveConfigStore(serverState.liveConfigStore, serverState.logger);
    const runtimeConfig = liveConfigStore.config;
    const baseConfig = buildBaseConfig(runtimeConfig);
    const listenPort = serverState.listenPort;
    const listenHost = serverState.listenHost;
    const requestPath = String(req.url ?? '').split('?')[0];
    const isConfigRoute = requestPath === '/' || requestPath === '' || requestPath === '/config.yaml' || requestPath === '/__config';
    const corsOrigin = isConfigRoute ? '' : getAllowedCorsOrigin(req);

    if (req.method === 'OPTIONS') {
        setCorsHeaders(res, corsOrigin);
        res.statusCode = 204;
        res.end();
        return;
    }

    if ((req.url === '/' || req.url === '') && req.method === 'GET') {
        writeHtml(res, 200, renderConfigEditorHtml({
            listenPort,
            runtimeConfig,
            rawConfigText: readConfigFileText(liveConfigStore.path),
        }));
        return;
    }

    if (req.url === '/healthz') {
        writeJson(res, 200, {
            ok: true,
            port: listenPort,
            proxy: 'structured-prefill',
        }, corsOrigin);
        return;
    }

    if (req.url === '/config.yaml' && req.method === 'GET') {
        const configText = readConfigFileText(liveConfigStore.path);
        const buffer = Buffer.from(configText, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        res.setHeader('Content-Length', String(buffer.length));
        res.end(buffer);
        return;
    }

    if (req.url === '/__config' && req.method === 'POST') {
        try {
            const body = await readRequestBody(req);
            const parsed = JSON.parse(body.toString('utf8'));
            const rawConfig = buildEditorRawConfig(parsed, runtimeConfig);
            const nextRuntimeConfig = normalizeRuntimeConfig(rawConfig);
            const pgTargetUrl = String(rawConfig?.structured_prefill?.prefill_generator?.target_url ?? '').trim();
            if (pgTargetUrl) {
                new URL(pgTargetUrl);
            }

            const yaml = renderRuntimeConfigYaml(nextRuntimeConfig);
            fs.writeFileSync(liveConfigStore.path, yaml, 'utf8');
            refreshLiveConfigStore(liveConfigStore, serverState.logger);

            const requiresRestart = (
                nextRuntimeConfig.server.host !== runtimeConfig.server.host ||
                nextRuntimeConfig.server.port !== runtimeConfig.server.port
            );

            writeJson(res, 200, {
                ok: true,
                yaml,
                message: requiresRestart
                    ? 'Saved. Host and port changes still need a restart.'
                    : 'Saved. Changes apply on the next request.',
            }, '');
            return;
        } catch (error) {
            writeJson(res, 400, {
                ok: false,
                message: String(error?.message ?? error),
            }, '');
            return;
        }
    }

    let targetUrl;
    try {
        targetUrl = resolveUpstreamTargetUrl({
            rawUrl: req.url,
            hostHeader: req.headers.host ?? `${listenHost}:${listenPort}`,
            config: runtimeConfig,
        });
    } catch (error) {
        writeJson(res, 400, {
            error: 'invalid_target_url',
            message: String(error?.message ?? error),
        }, corsOrigin);
        return;
    }

    if (!targetUrl) {
        writeText(res, 400, createUsageText(listenPort), corsOrigin);
        return;
    }

    const bodyBuffer = await readRequestBody(req);
    const originalContentType = req.headers['content-type'] ?? '';
    let requestBodyBuffer = bodyBuffer;
    let requestContext = null;
    let upstreamTargetUrl = targetUrl;
    let rewrittenContentType = isJsonContentType(originalContentType) ? 'application/json; charset=utf-8' : '';

    if (bodyBuffer.length > 0 && isJsonContentType(originalContentType)) {
        try {
            const parsed = JSON.parse(bodyBuffer.toString('utf8'));
            const clientRequestedStream = parsed?.stream === true;
            const initialRewrite = rewriteProxyJsonRequest({
                targetUrl,
                jsonBody: parsed,
                baseConfig,
            });
            const pgProcessed = await applyPrefillGeneratorToRequest({
                targetUrl,
                jsonBody: parsed,
                upstreamHeaders: buildProxyHeaders(req.headers, 'application/json; charset=utf-8'),
                config: runtimeConfig.structuredPrefill.prefillGenerator,
                skip: initialRewrite?.context?.continue?.active === true,
            });
            const effectiveParsed = pgProcessed.applied ? pgProcessed.jsonBody : parsed;
            if (pgProcessed.applied) {
                requestBodyBuffer = Buffer.from(JSON.stringify(effectiveParsed));
                console.log(`[structured-prefill-proxy] prefill-generator provider=${pgProcessed.provider} target=${targetUrl.origin}${targetUrl.pathname}`);
            }

            const rewritten = pgProcessed.applied ? rewriteProxyJsonRequest({
                targetUrl,
                jsonBody: effectiveParsed,
                baseConfig,
            }) : initialRewrite;

            if (rewritten) {
                upstreamTargetUrl = rewritten.targetUrl;
                requestContext = {
                    ...rewritten.context,
                    clientRequestedStream,
                };
                requestBodyBuffer = Buffer.from(JSON.stringify(rewritten.jsonBody));
                console.log(`[structured-prefill-proxy] activated provider=${requestContext.provider} target=${upstreamTargetUrl.origin}${upstreamTargetUrl.pathname}`);
            }
        } catch {
            rewrittenContentType = '';
        }
    } else {
        rewrittenContentType = '';
    }

    const upstreamHeaders = buildProxyHeaders(req.headers, rewrittenContentType || originalContentType);
    const hasBody = !['GET', 'HEAD'].includes(String(req.method ?? '').toUpperCase()) && requestBodyBuffer.length > 0;

    let upstreamResponse;
    try {
        upstreamResponse = await fetch(upstreamTargetUrl, {
            method: req.method,
            headers: upstreamHeaders,
            body: hasBody ? requestBodyBuffer : undefined,
            redirect: 'manual',
        });
    } catch (error) {
        writeJson(res, 502, {
            error: 'upstream_fetch_failed',
            message: String(error?.message ?? error),
            target: upstreamTargetUrl.toString(),
        }, corsOrigin);
        return;
    }

    const extraHeaders = requestContext ? {
        'x-structured-prefill': 'activated',
        'x-structured-prefill-provider': requestContext.provider,
    } : {};

    const upstreamContentType = upstreamResponse.headers.get('content-type') ?? '';
    if (!upstreamResponse.ok) {
        await forwardUpstreamErrorResponse(upstreamResponse, res, extraHeaders, corsOrigin);
        return;
    }

    const shouldRewriteJson = !!requestContext && isJsonContentType(upstreamContentType);

    if (shouldReturnOpenAiChatSse(requestContext) && /text\/event-stream/i.test(upstreamContentType)) {
        await forwardStructuredOpenAiChatStream(upstreamResponse, res, requestContext, extraHeaders, corsOrigin);
        return;
    }

    if (shouldRewriteJson) {
        const upstreamText = await upstreamResponse.text();
        try {
            const parsed = JSON.parse(upstreamText);
            if (isErrorPayload(parsed)) {
                const normalizedStatus = upstreamResponse.status >= 400 ? upstreamResponse.status : 502;
                const buffer = Buffer.from(JSON.stringify(parsed), 'utf8');
                res.statusCode = normalizedStatus;
                applyResponseHeaders(res, upstreamResponse.headers, {
                    ...extraHeaders,
                    'Content-Type': 'application/json; charset=utf-8',
                }, buffer.length);
                setCorsHeaders(res, corsOrigin);
                res.end(buffer);
                return;
            }
            const rewrittenResponse = rewriteProxyJsonResponse({
                jsonBody: parsed,
                context: requestContext,
            });
            if (shouldReturnOpenAiChatSse(requestContext)) {
                const body = buildOpenAiChatSseBody(rewrittenResponse);
                const buffer = Buffer.from(body, 'utf8');
                res.statusCode = upstreamResponse.status;
                applyResponseHeaders(res, upstreamResponse.headers, {
                    ...extraHeaders,
                    'Content-Type': 'text/event-stream; charset=utf-8',
                    'Cache-Control': 'no-cache',
                }, buffer.length);
                setCorsHeaders(res, corsOrigin);
                res.end(buffer);
                return;
            }
            const buffer = Buffer.from(JSON.stringify(rewrittenResponse));
            res.statusCode = upstreamResponse.status;
            applyResponseHeaders(res, upstreamResponse.headers, {
                ...extraHeaders,
                'Content-Type': 'application/json; charset=utf-8',
            }, buffer.length);
            setCorsHeaders(res, corsOrigin);
            res.end(buffer);
            return;
        } catch {
            const buffer = Buffer.from(upstreamText, 'utf8');
            res.statusCode = upstreamResponse.status;
            applyResponseHeaders(res, upstreamResponse.headers, extraHeaders, buffer.length);
            setCorsHeaders(res, corsOrigin);
            res.end(buffer);
            return;
        }
    }

    res.statusCode = upstreamResponse.status;
    applyResponseHeaders(res, upstreamResponse.headers, extraHeaders);
    setCorsHeaders(res, corsOrigin);

    if (!upstreamResponse.body) {
        res.end();
        return;
    }

    Readable.fromWeb(upstreamResponse.body).pipe(res);
}

function startServer({ proxyDir = path.resolve(__dirname, '..'), logger = console } = {}) {
    const liveConfigStore = createLiveConfigStore(proxyDir);
    const listenPort = liveConfigStore.config.server.port;
    const listenHost = liveConfigStore.config.server.host;
    const serverState = {
        liveConfigStore,
        listenPort,
        listenHost,
        logger,
    };

    const server = http.createServer((req, res) => {
        const requestPath = String(req?.url ?? '').split('?')[0];
        const isConfigRoute = requestPath === '/' || requestPath === '' || requestPath === '/config.yaml' || requestPath === '/__config';
        const corsOrigin = isConfigRoute ? '' : getAllowedCorsOrigin(req);
        handleProxyRequest(req, res, serverState).catch((error) => {
            writeJson(res, 500, {
                error: 'proxy_failure',
                message: String(error?.stack ?? error?.message ?? error),
            }, corsOrigin);
        });
    });

    server.listen(listenPort, listenHost, () => {
        logger.log(`[structured-prefill-proxy] listening on http://${listenHost}:${listenPort}`);
        logger.log('[structured-prefill-proxy] config: config.yaml');
    });

    return server;
}

module.exports = {
    buildOpenAiChatSseBody,
    extractJsonPayloadFromSseText,
    isErrorPayload,
    normalizeUpstreamError,
    transformOpenAiChatStreamChunk,
    startServer,
};

if (require.main === module) {
    startServer();
}
