'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG = Object.freeze({
    server: {
        host: '127.0.0.1',
        port: 8382,
    },
    routing: {
        allow_full_url_targets: true,
        openai_base_url: 'https://api.openai.com',
        openrouter_base_url: 'https://openrouter.ai/api',
        openai_compatible_base_url: 'https://api.openai.com',
        anthropic_base_url: 'https://api.anthropic.com',
        google_base_url: 'https://generativelanguage.googleapis.com',
    },
    structured_prefill: {
        enabled: true,
        min_chars_after_prefix: 80,
        newline_token: '\\n',
        hide_prefill_in_display: true,
        anti_slop_ban_list: '',
        continue: {
            mode: 'off',
            overlap_chars: 14,
        },
        prefill_generator: {
            enabled: false,
            provider: 'auto',
            target_url: '',
            api_key: '',
            api_key_header: '',
            api_key_prefix: '',
            extra_headers: '',
            model: '',
            max_tokens: 15,
            timeout_ms: 120000,
            stop: '',
            keep_matched_stop_string: false,
            extra_prompt: '',
            extra_prompt_role: 'system',
        },
    },
});

const DEFAULT_CONFIG_YAML = `# StructuredPrefill proxy config
#
# Easy bases:
#   OpenRouter: http://localhost:8382/openrouter
#   OpenAI:     http://localhost:8382/openai
# Bare http://localhost:8382 still uses openai_compatible_base_url below.

server:
  host: "127.0.0.1"
  port: 8382

routing:
  allow_full_url_targets: true
  openai_base_url: "https://api.openai.com"
  openrouter_base_url: "https://openrouter.ai/api"
  openai_compatible_base_url: "https://api.openai.com"
  anthropic_base_url: "https://api.anthropic.com"
  google_base_url: "https://generativelanguage.googleapis.com"

structured_prefill:
  enabled: true
  min_chars_after_prefix: 80
  newline_token: '\n'
  hide_prefill_in_display: true
  anti_slop_ban_list: ""
  continue:
    mode: "off"
    overlap_chars: 14
  prefill_generator:
    enabled: false
    provider: "auto"
    target_url: ""
    api_key: ""
    api_key_header: ""
    api_key_prefix: ""
    extra_headers: ""
    model: ""
    max_tokens: 15
    timeout_ms: 120000
    stop: ""
    keep_matched_stop_string: false
    extra_prompt: ""
    extra_prompt_role: "system"
`;

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    return Math.min(max, Math.max(min, int));
}

function parseLineList(raw) {
    return String(raw ?? '')
        .split(/\r?\n/g)
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean);
}

function normalizePrefillGeneratorExtraPromptRole(raw) {
    const role = String(raw ?? 'system').trim().toLowerCase();
    if (role === 'user' || role === 'assistant') return role;
    return 'system';
}

function normalizePrefillGeneratorProvider(raw) {
    const provider = String(raw ?? 'auto').trim().toLowerCase();
    if ([
        'auto',
        'openai-chat',
        'openai-responses',
        'anthropic-messages',
        'gemini-generate-content',
    ].includes(provider)) {
        return provider;
    }
    return 'auto';
}

function deepClone(value) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, overrides) {
    if (!overrides || typeof overrides !== 'object') return deepClone(base);

    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(overrides)) {
        const baseValue = out[key];
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            baseValue &&
            typeof baseValue === 'object' &&
            !Array.isArray(baseValue)
        ) {
            out[key] = deepMerge(baseValue, value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function stripInlineComment(line) {
    let out = '';
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];

        if (escaped) {
            out += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\' && inDouble) {
            out += ch;
            escaped = true;
            continue;
        }

        if (ch === '\'' && !inDouble) {
            inSingle = !inSingle;
            out += ch;
            continue;
        }

        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            out += ch;
            continue;
        }

        if (ch === '#' && !inSingle && !inDouble) {
            break;
        }

        out += ch;
    }

    return out.trimEnd();
}

function parseScalar(raw) {
    const value = String(raw ?? '').trim();
    if (value === '') return '';
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (/^null$/i.test(value)) return null;
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);

    if (value.startsWith('"') && value.endsWith('"')) {
        return JSON.parse(value);
    }

    if (value.startsWith('\'') && value.endsWith('\'')) {
        return value.slice(1, -1).replace(/''/g, '\'');
    }

    return value;
}

function parseBlockScalar(lines, startIndex, parentIndent, mode) {
    const chunks = [];
    let index = startIndex;
    let blockIndent = -1;

    while (index < lines.length) {
        const line = lines[index];
        if (line.indent <= parentIndent) break;

        if (blockIndent === -1) blockIndent = line.indent;
        if (line.indent < blockIndent) break;

        chunks.push(line.content);
        index++;
    }

    let value = chunks.join(mode === '>' ? ' ' : '\n');
    if (mode !== '|-') value += chunks.length > 0 ? '\n' : '';
    return [value, index];
}

function preprocessYamlLines(text) {
    const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\t/g, '  ');
    const lines = [];

    for (const rawLine of source.split(/\r?\n/g)) {
        const stripped = stripInlineComment(rawLine);
        if (!stripped.trim()) continue;

        const indentMatch = /^ */.exec(stripped);
        const indent = indentMatch ? indentMatch[0].length : 0;
        const content = stripped.slice(indent);
        lines.push({ indent, content });
    }

    return lines;
}

function parseYamlMapping(lines, startIndex, indent) {
    const out = {};
    let index = startIndex;

    while (index < lines.length) {
        const line = lines[index];
        if (line.indent < indent) break;
        if (line.indent > indent) {
            throw new Error(`Invalid indentation near "${line.content}"`);
        }
        if (line.content.startsWith('- ')) {
            throw new Error('Lists are not supported in this config format.');
        }

        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.content);
        if (!match) {
            throw new Error(`Invalid config line: "${line.content}"`);
        }

        const key = match[1];
        const rest = match[2];
        if (rest === '|' || rest === '|-' || rest === '>') {
            const [blockValue, nextIndex] = parseBlockScalar(lines, index + 1, indent, rest);
            out[key] = blockValue;
            index = nextIndex;
            continue;
        }
        if (rest === '') {
            const next = lines[index + 1];
            if (next && next.indent > indent) {
                const [child, nextIndex] = parseYamlMapping(lines, index + 1, next.indent);
                out[key] = child;
                index = nextIndex;
                continue;
            }
            out[key] = {};
            index++;
            continue;
        }

        out[key] = parseScalar(rest);
        index++;
    }

    return [out, index];
}

function parseSimpleYaml(text) {
    const lines = preprocessYamlLines(text);
    if (lines.length === 0) return {};
    const [result] = parseYamlMapping(lines, 0, lines[0].indent);
    return result;
}

function ensureTrailingBaseUrlSlash(urlString) {
    const url = new URL(String(urlString ?? ''));
    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`.replace(/\/{2,}/g, '/');
    }
    return url.toString();
}

function normalizeRuntimeConfig(rawConfig) {
    const merged = deepMerge(DEFAULT_CONFIG, rawConfig);
    const continueModeRaw = String(merged.structured_prefill?.continue?.mode ?? DEFAULT_CONFIG.structured_prefill.continue.mode).toLowerCase();
    const continueMode = ['off', 'auto', 'force'].includes(continueModeRaw) ? continueModeRaw : DEFAULT_CONFIG.structured_prefill.continue.mode;
    return {
        server: {
            host: String(merged.server?.host ?? DEFAULT_CONFIG.server.host),
            port: clampInt(merged.server?.port, 1, 65535, DEFAULT_CONFIG.server.port),
        },
        routing: {
            allowFullUrlTargets: Boolean(merged.routing?.allow_full_url_targets),
            openAiBaseUrl: ensureTrailingBaseUrlSlash(merged.routing?.openai_base_url ?? DEFAULT_CONFIG.routing.openai_base_url),
            openRouterBaseUrl: ensureTrailingBaseUrlSlash(merged.routing?.openrouter_base_url ?? DEFAULT_CONFIG.routing.openrouter_base_url),
            openAiCompatibleBaseUrl: ensureTrailingBaseUrlSlash(merged.routing?.openai_compatible_base_url ?? DEFAULT_CONFIG.routing.openai_compatible_base_url),
            anthropicBaseUrl: ensureTrailingBaseUrlSlash(merged.routing?.anthropic_base_url ?? DEFAULT_CONFIG.routing.anthropic_base_url),
            googleBaseUrl: ensureTrailingBaseUrlSlash(merged.routing?.google_base_url ?? DEFAULT_CONFIG.routing.google_base_url),
        },
        structuredPrefill: {
            enabled: Boolean(merged.structured_prefill?.enabled),
            minCharsAfterPrefix: clampInt(
                merged.structured_prefill?.min_chars_after_prefix,
                1,
                10000,
                DEFAULT_CONFIG.structured_prefill.min_chars_after_prefix,
            ),
            newlineToken: /[\r\n]/.test(String(merged.structured_prefill?.newline_token ?? ''))
                ? DEFAULT_CONFIG.structured_prefill.newline_token
                : String(merged.structured_prefill?.newline_token ?? DEFAULT_CONFIG.structured_prefill.newline_token),
            hidePrefillInDisplay: Boolean(merged.structured_prefill?.hide_prefill_in_display),
            antiSlopBanList: String(merged.structured_prefill?.anti_slop_ban_list ?? DEFAULT_CONFIG.structured_prefill.anti_slop_ban_list),
            continueMode,
            continueOverlapChars: clampInt(
                merged.structured_prefill?.continue?.overlap_chars,
                0,
                240,
                DEFAULT_CONFIG.structured_prefill.continue.overlap_chars,
            ),
            prefillGenerator: {
                enabled: Boolean(merged.structured_prefill?.prefill_generator?.enabled),
                provider: normalizePrefillGeneratorProvider(merged.structured_prefill?.prefill_generator?.provider),
                targetUrl: String(merged.structured_prefill?.prefill_generator?.target_url ?? '').trim(),
                apiKey: String(merged.structured_prefill?.prefill_generator?.api_key ?? '').trim(),
                apiKeyHeader: String(merged.structured_prefill?.prefill_generator?.api_key_header ?? '').trim(),
                apiKeyPrefix: String(merged.structured_prefill?.prefill_generator?.api_key_prefix ?? ''),
                extraHeaders: String(merged.structured_prefill?.prefill_generator?.extra_headers ?? ''),
                model: String(merged.structured_prefill?.prefill_generator?.model ?? '').trim(),
                maxTokens: clampInt(
                    merged.structured_prefill?.prefill_generator?.max_tokens,
                    1,
                    1000000,
                    DEFAULT_CONFIG.structured_prefill.prefill_generator.max_tokens,
                ),
                timeoutMs: clampInt(
                    merged.structured_prefill?.prefill_generator?.timeout_ms,
                    500,
                    120000,
                    DEFAULT_CONFIG.structured_prefill.prefill_generator.timeout_ms,
                ),
                stopStrings: parseLineList(merged.structured_prefill?.prefill_generator?.stop),
                keepMatchedStopString: Boolean(merged.structured_prefill?.prefill_generator?.keep_matched_stop_string),
                extraPrompt: String(merged.structured_prefill?.prefill_generator?.extra_prompt ?? ''),
                extraPromptRole: normalizePrefillGeneratorExtraPromptRole(
                    merged.structured_prefill?.prefill_generator?.extra_prompt_role,
                ),
            },
        },
    };
}

function yamlSingleQuoted(value) {
    return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function yamlDoubleQuoted(value) {
    return JSON.stringify(String(value ?? ''));
}

function yamlString(value, indent) {
    const text = String(value ?? '');
    if (text === '') return '""';
    if (!/[\n\r]/.test(text)) return yamlDoubleQuoted(text);
    const lines = text.split(/\r?\n/g);
    while (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }
    if (lines.length === 0) return '""';
    const padding = ' '.repeat(Math.max(0, Number(indent) || 0));
    return `|-\n${lines.map((line) => `${padding}${line}`).join('\n')}`;
}

function renderRuntimeConfigYaml(runtimeConfig) {
    const cfg = (
        runtimeConfig &&
        typeof runtimeConfig === 'object' &&
        runtimeConfig.server &&
        runtimeConfig.routing &&
        runtimeConfig.structuredPrefill &&
        Object.prototype.hasOwnProperty.call(runtimeConfig.routing, 'openAiBaseUrl')
    ) ? runtimeConfig : normalizeRuntimeConfig(runtimeConfig ?? {});
    const pg = cfg.structuredPrefill.prefillGenerator;
    const antiSlop = String(cfg.structuredPrefill.antiSlopBanList ?? '');
    const stopStrings = Array.isArray(pg.stopStrings) ? pg.stopStrings.join('\n') : '';

    return [
        '# StructuredPrefill proxy config',
        '#',
        '# Easy bases:',
        `#   OpenRouter: http://localhost:${cfg.server.port}/openrouter`,
        `#   OpenAI:     http://localhost:${cfg.server.port}/openai`,
        `#   Anthropic:  http://localhost:${cfg.server.port}/anthropic`,
        `#   Gemini:     http://localhost:${cfg.server.port}/google`,
        '',
        'server:',
        `  host: ${yamlDoubleQuoted(cfg.server.host)}`,
        `  port: ${cfg.server.port}`,
        '',
        'routing:',
        `  allow_full_url_targets: ${cfg.routing.allowFullUrlTargets ? 'true' : 'false'}`,
        `  openai_base_url: ${yamlDoubleQuoted(cfg.routing.openAiBaseUrl.replace(/\/$/, ''))}`,
        `  openrouter_base_url: ${yamlDoubleQuoted(cfg.routing.openRouterBaseUrl.replace(/\/$/, ''))}`,
        `  openai_compatible_base_url: ${yamlDoubleQuoted(cfg.routing.openAiCompatibleBaseUrl.replace(/\/$/, ''))}`,
        `  anthropic_base_url: ${yamlDoubleQuoted(cfg.routing.anthropicBaseUrl.replace(/\/$/, ''))}`,
        `  google_base_url: ${yamlDoubleQuoted(cfg.routing.googleBaseUrl.replace(/\/$/, ''))}`,
        '',
        'structured_prefill:',
        `  enabled: ${cfg.structuredPrefill.enabled ? 'true' : 'false'}`,
        `  min_chars_after_prefix: ${cfg.structuredPrefill.minCharsAfterPrefix}`,
        `  newline_token: ${yamlSingleQuoted(cfg.structuredPrefill.newlineToken)}`,
        `  hide_prefill_in_display: ${cfg.structuredPrefill.hidePrefillInDisplay ? 'true' : 'false'}`,
        `  anti_slop_ban_list: ${yamlString(antiSlop, 4)}`,
        '  continue:',
        `    mode: ${yamlDoubleQuoted(cfg.structuredPrefill.continueMode)}`,
        `    overlap_chars: ${cfg.structuredPrefill.continueOverlapChars}`,
        '  prefill_generator:',
        `    enabled: ${pg.enabled ? 'true' : 'false'}`,
        `    provider: ${yamlDoubleQuoted(pg.provider)}`,
        `    target_url: ${yamlDoubleQuoted(pg.targetUrl)}`,
        `    api_key: ${yamlDoubleQuoted(pg.apiKey)}`,
        `    api_key_header: ${yamlDoubleQuoted(pg.apiKeyHeader)}`,
        `    api_key_prefix: ${yamlDoubleQuoted(pg.apiKeyPrefix)}`,
        `    extra_headers: ${yamlString(pg.extraHeaders, 6)}`,
        `    model: ${yamlDoubleQuoted(pg.model)}`,
        `    max_tokens: ${pg.maxTokens}`,
        `    timeout_ms: ${pg.timeoutMs}`,
        `    stop: ${yamlString(stopStrings, 6)}`,
        `    keep_matched_stop_string: ${pg.keepMatchedStopString ? 'true' : 'false'}`,
        `    extra_prompt: ${yamlString(pg.extraPrompt, 6)}`,
        `    extra_prompt_role: ${yamlDoubleQuoted(pg.extraPromptRole)}`,
        '',
    ].join('\n');
}

function ensureConfigFile(proxyDir) {
    const configPath = path.join(proxyDir, 'config.yaml');
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, DEFAULT_CONFIG_YAML, 'utf8');
    }
    return configPath;
}

function loadProxyConfig(proxyDir) {
    const configPath = ensureConfigFile(proxyDir);
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = parseSimpleYaml(raw);
    return {
        path: configPath,
        config: normalizeRuntimeConfig(parsed),
    };
}

function getFileMtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function createLiveConfigStore(proxyDir) {
    const loaded = loadProxyConfig(proxyDir);
    return {
        proxyDir,
        path: loaded.path,
        config: loaded.config,
        loadedMtimeMs: getFileMtimeMs(loaded.path),
        failedMtimeMs: -1,
    };
}

function refreshLiveConfigStore(store, logger = console) {
    if (!store || typeof store !== 'object') {
        throw new Error('Live config store is required.');
    }

    const currentMtimeMs = getFileMtimeMs(store.path);
    if (!currentMtimeMs) return store;
    if (currentMtimeMs === store.loadedMtimeMs || currentMtimeMs === store.failedMtimeMs) {
        return store;
    }

    try {
        const loaded = loadProxyConfig(store.proxyDir);
        store.path = loaded.path;
        store.config = loaded.config;
        store.loadedMtimeMs = getFileMtimeMs(loaded.path);
        store.failedMtimeMs = -1;
        if (typeof logger?.log === 'function') {
            logger.log('[structured-prefill-proxy] reloaded config');
        }
    } catch (error) {
        store.failedMtimeMs = currentMtimeMs;
        if (typeof logger?.warn === 'function') {
            logger.warn(`[structured-prefill-proxy] failed to reload config: ${String(error?.message ?? error)}`);
        }
    }

    return store;
}

function joinBaseUrlAndRequestPath(baseUrl, requestUrl) {
    const base = new URL(String(baseUrl ?? ''));
    const incoming = new URL(`http://proxy.local${String(requestUrl ?? '')}`);
    const basePath = base.pathname.replace(/\/+$/, '');
    const requestPath = incoming.pathname.startsWith('/') ? incoming.pathname : `/${incoming.pathname}`;
    base.pathname = `${basePath}${requestPath}`.replace(/\/{2,}/g, '/');
    base.search = incoming.search;
    return base;
}

function looksLikeFullTarget(rawUrl, hostHeader) {
    let candidate = String(rawUrl ?? '');
    if (!candidate || candidate === '/') return '';

    if (candidate.startsWith('/')) candidate = candidate.slice(1);
    if (!candidate) return '';

    if (candidate.startsWith('?')) {
        const wrapper = new URL(`http://${hostHeader}${rawUrl}`);
        candidate = wrapper.searchParams.get('url') ?? '';
    }

    if (!candidate) return '';

    if (/^https?:\/\//i.test(candidate)) return candidate;

    try {
        const decoded = decodeURIComponent(candidate);
        if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
        // ignore decode errors
    }

    return '';
}

function extractAliasedRequestPath(requestUrl) {
    const pathname = String(requestUrl?.pathname ?? '');
    const aliases = [
        ['openrouter', 'openRouterBaseUrl'],
        ['openai', 'openAiBaseUrl'],
        ['anthropic', 'anthropicBaseUrl'],
        ['google', 'googleBaseUrl'],
        ['gemini', 'googleBaseUrl'],
    ];

    for (const [alias, configKey] of aliases) {
        const prefix = `/${alias}`;
        if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
            const strippedPath = pathname.slice(prefix.length) || '/';
            return {
                configKey,
                requestPath: `${strippedPath}${requestUrl.search}`,
            };
        }
    }

    return null;
}

function resolveUpstreamTargetUrl({ rawUrl, hostHeader, config }) {
    const explicitTarget = looksLikeFullTarget(rawUrl, hostHeader);
    if (explicitTarget) {
        if (!config.routing.allowFullUrlTargets) {
            throw new Error('Full URL targeting is disabled in config.yaml.');
        }
        return new URL(explicitTarget);
    }

    const requestUrl = new URL(`http://${hostHeader}${String(rawUrl ?? '')}`);
    const pathname = requestUrl.pathname.toLowerCase();
    const aliased = extractAliasedRequestPath(requestUrl);

    if (aliased) {
        return joinBaseUrlAndRequestPath(config.routing[aliased.configKey], aliased.requestPath);
    }

    if (
        pathname.includes(':generatecontent') ||
        pathname.includes(':streamgeneratecontent') ||
        pathname.startsWith('/v1beta/models/') ||
        pathname.startsWith('/v1/models/')
    ) {
        return joinBaseUrlAndRequestPath(config.routing.googleBaseUrl, requestUrl.pathname + requestUrl.search);
    }

    if (pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')) {
        return joinBaseUrlAndRequestPath(config.routing.anthropicBaseUrl, requestUrl.pathname + requestUrl.search);
    }

    if (pathname.startsWith('/v1/')) {
        return joinBaseUrlAndRequestPath(config.routing.openAiCompatibleBaseUrl, requestUrl.pathname + requestUrl.search);
    }

    return null;
}

module.exports = {
    createLiveConfigStore,
    DEFAULT_CONFIG,
    DEFAULT_CONFIG_YAML,
    refreshLiveConfigStore,
    loadProxyConfig,
    normalizeRuntimeConfig,
    parseSimpleYaml,
    renderRuntimeConfigYaml,
    resolveUpstreamTargetUrl,
};
