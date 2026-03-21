'use strict';

const DEFAULT_PROXY_CONFIG = Object.freeze({
    enabled: true,
    minCharsAfterPrefix: 80,
    newlineToken: '\\n',
    hidePrefillInDisplay: true,
    antiSlopBanList: '',
    continueMode: 'off',
    continueOverlapChars: 14,
});

const GEMINI_SAFETY_SETTINGS = Object.freeze([
    Object.freeze({ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }),
    Object.freeze({ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' }),
    Object.freeze({ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' }),
    Object.freeze({ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }),
    Object.freeze({ category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' }),
]);

function cloneJson(value) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    const int = Math.trunc(num);
    return Math.min(max, Math.max(min, int));
}

function normalizeNewlines(text) {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function prefixHasSlots(prefix) {
    return /\[\[[^\]]+?\]\]/.test(String(prefix ?? ''));
}

function escapeRegExp(str) {
    return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapePrefixLiteral(str) {
    return escapeRegExp(str ?? '').replace(/"/g, '(?:\\\\)*"');
}

function chooseNewlineToken(prefix, preferredToken) {
    let token = String(preferredToken ?? '').trim();
    if (!token || /[\r\n]/.test(token)) token = '\\n';

    const normalized = normalizeNewlines(prefix);
    if (!normalized.includes(token)) return token;

    for (let i = 2; i <= 25; i++) {
        const candidate = `<NL${i}>`;
        if (!normalized.includes(candidate)) return candidate;
    }

    const unicodeFallback = '\u2424';
    if (!normalized.includes(unicodeFallback)) return unicodeFallback;
    return token;
}

function encodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return normalizeNewlines(text).replace(/\n/g, token);
}

function decodeNewlines(text, newlineToken) {
    const token = String(newlineToken ?? '');
    if (!token) return String(text ?? '');
    return String(text ?? '').split(token).join('\n');
}

function sanitizeUserRegex(raw) {
    let value = String(raw ?? '').trim();
    if (!value || /[\r\n]/.test(value)) return '';

    if (value.startsWith('/') && value.lastIndexOf('/') > 0) {
        const lastSlash = value.lastIndexOf('/');
        const inner = value.slice(1, lastSlash);
        if (inner) value = inner;
    }

    value = value.replace(/^\^+/, '').replace(/\$+$/, '');
    return value.trim();
}

function parseOptionsList(raw) {
    const parts = String(raw ?? '')
        .split(/[|,]/g)
        .map((part) => part.trim())
        .filter(Boolean);
    return Array.from(new Set(parts)).slice(0, 50);
}

function anyCharIncludingNewlineExpr() {
    return '(?:.|\\n)';
}

function splitHintSuffix(placeholderBody) {
    const body = String(placeholderBody ?? '');
    const index = body.toLowerCase().lastIndexOf('|hint:');
    if (index === -1) return { spec: body.trim(), hint: '' };
    return {
        spec: body.slice(0, index).trim(),
        hint: body.slice(index + 6).trim(),
    };
}

function buildWordCountPatternNoRanges(minWords, maxWords, { wordToken, wordSep }) {
    const min = clampInt(minWords, 1, 2000, 1);
    const max = clampInt(maxWords, 1, 2000, min);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    const cap = 40;
    const cappedHi = Math.min(hi, cap);

    let out = '';
    for (let i = 0; i < lo; i++) {
        out += i === 0 ? wordToken : `${wordSep}${wordToken}`;
    }
    for (let i = lo; i < cappedHi; i++) {
        out += `(?:${wordSep}${wordToken})?`;
    }
    if (hi > cap) {
        out += `(?:${wordSep}${wordToken})*`;
    }
    return out;
}

function buildPlaceholderRegex(placeholderBody, context) {
    const { spec: body } = splitHintSuffix(placeholderBody);
    const escapeForCharClass = (ch) => String(ch ?? '').replace(/[-\\\]^]/g, '\\$&');
    const newlineToken = String(context.newlineToken ?? '');
    const newlineTokSingle = newlineToken.length === 1 ? escapeForCharClass(newlineToken) : '';
    const wordTokenCore = newlineTokSingle ? `[^\\s,<>${newlineTokSingle}]+` : '[^\\s,<>]+';
    const wordToken = `${wordTokenCore}[,\\.!\\?;:'"\\)\\]\\}~-]*`;
    const wordSep = '[\\t ]+';
    if (!body) return wordToken;

    const lower = body.toLowerCase();
    let match = /^(w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(lower);
    if (match) {
        const first = clampInt(match[2], 1, 2000, 1);
        const second = match[3] != null ? clampInt(match[3], 1, 2000, first) : first;
        const min = Math.min(first, second);
        const max = Math.max(first, second);
        if (context.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(min, max, { wordToken, wordSep });
        }

        const minTail = Math.max(0, min - 1);
        const maxTail = Math.max(0, max - 1);
        return `${wordToken}(?:${wordSep}${wordToken}){${minTail},${maxTail}}`;
    }

    match = /^(opt|options)\s*:\s*(.+?)\s*$/.exec(body);
    if (match) {
        const options = parseOptionsList(match[2]);
        return options.length > 0 ? `(?:${options.map(escapeRegExp).join('|')})` : wordToken;
    }

    match = /^(re|regex)\s*:\s*(.+?)\s*$/.exec(body);
    if (match) {
        const userRegex = sanitizeUserRegex(match[2]);
        if (userRegex) {
            if (context.patternMode === 'anthropic' && (/[{}]/.test(userRegex) || /\\S/.test(userRegex))) {
                return `${anyCharIncludingNewlineExpr()}*`;
            }
            return `(?:${userRegex})`;
        }
        return `${anyCharIncludingNewlineExpr()}*`;
    }

    if (/^free\s*$/i.test(body)) return `${anyCharIncludingNewlineExpr()}+`;
    if (/^(keep|end|stop|eos)\s*$/i.test(body)) return '(?:)';

    if (/^(emotion|mood)\s*$/i.test(body)) {
        return '(?:happy|sad|angry|nervous|excited|scared|confused|amused|annoyed|anxious|bored|calm|curious|desperate|disgusted|embarrassed|frustrated|grateful|guilty|hopeful|hurt|jealous|lonely|nostalgic|panicked|playful|proud|relieved|shy|smug|surprised|suspicious|tender|terrified|thoughtful|tired|uncomfortable|worried|flustered|melancholic|determined|fearful|content|bitter|affectionate|giddy|resigned|defiant|wistful|somber)';
    }

    match = /^(line|lines)\s*(?::\s*(\d+)(?:\s*-\s*(\d+))?)?\s*$/i.exec(body);
    if (match) {
        const lineExpr = '.+';
        const nlExpr = newlineToken ? `(?:${escapeRegExp(newlineToken)}|\\n)` : '\\n';
        if (!match[2]) return lineExpr;

        const first = clampInt(match[2], 1, 50, 1);
        const second = match[3] != null ? clampInt(match[3], 1, 50, first) : first;
        const lo = Math.min(first, second);
        const hi = Math.max(first, second);
        if (context.patternMode === 'anthropic') {
            let out = lineExpr;
            for (let i = 1; i < lo; i++) out += `${nlExpr}${lineExpr}`;
            for (let i = lo; i < hi; i++) out += `(?:${nlExpr}${lineExpr})?`;
            return out;
        }
        if (lo === hi) {
            const tailCount = lo - 1;
            return tailCount === 0 ? lineExpr : `${lineExpr}(?:${nlExpr}${lineExpr}){${tailCount}}`;
        }
        return `${lineExpr}(?:${nlExpr}${lineExpr}){${lo - 1},${hi - 1}}`;
    }

    if (/^name\s*$/i.test(body)) {
        const names = Array.isArray(context.knownNames) ? context.knownNames.filter(Boolean) : [];
        if (names.length > 0) return `(?:${names.map(escapeRegExp).join('|')})`;
        if (context.patternMode === 'anthropic') return '[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+)?';
        return '[A-Z][a-z]+(?:[\\t ]+[A-Z][a-z]+){0,2}';
    }

    if (/^action\s*$/i.test(body)) {
        const actionWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : '[^\\s"<>]+';
        const sep = '[\\t ]+';
        if (context.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 6, { wordToken: actionWord, wordSep: sep });
        }
        return `${actionWord}(?:${sep}${actionWord}){0,5}`;
    }

    if (/^thought\s*$/i.test(body)) {
        const thoughtWord = newlineTokSingle ? `[^\\s"<>${newlineTokSingle}]+` : '[^\\s"<>]+';
        const sep = '[\\t ]+';
        if (context.patternMode === 'anthropic') {
            return buildWordCountPatternNoRanges(1, 10, { wordToken: thoughtWord, wordSep: sep });
        }
        return `${thoughtWord}(?:${sep}${thoughtWord}){0,9}`;
    }

    match = /^(num|number)\s*(?::\s*(-?\d+)\s*-\s*(-?\d+))?\s*$/i.exec(body);
    if (match) {
        if (!match[2]) return '-?[0-9]+';

        const lo = parseInt(match[2], 10);
        const hi = parseInt(match[3], 10);
        const minVal = Math.min(lo, hi);
        const maxVal = Math.max(lo, hi);
        if (maxVal - minVal <= 30) {
            const values = [];
            for (let value = minVal; value <= maxVal; value++) values.push(String(value));
            return `(?:${values.join('|')})`;
        }

        const minDigits = String(Math.abs(minVal)).length;
        const maxDigits = String(Math.abs(maxVal)).length;
        const prefix = minVal < 0 ? '-?' : '';
        if (context.patternMode === 'anthropic') {
            const alts = [];
            for (let digits = minDigits; digits <= maxDigits; digits++) {
                alts.push(`[0-9]${'[0-9]'.repeat(digits - 1)}`);
            }
            return `${prefix}(?:${alts.join('|')})`;
        }
        return `${prefix}[0-9]{${minDigits},${maxDigits}}`;
    }

    return wordToken;
}

function buildPrefixRegexFromWireTemplate(wireTemplate, context) {
    const template = String(wireTemplate ?? '');
    const slotRe = /\[\[(.+?)\]\]/g;
    let out = '';
    let last = 0;
    let match;

    while ((match = slotRe.exec(template)) !== null) {
        out += escapePrefixLiteral(template.slice(last, match.index));
        out += buildPlaceholderRegex(match[1], context);
        last = match.index + match[0].length;
    }

    out += escapePrefixLiteral(template.slice(last));
    return out;
}

function splitEndPrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { template: '', hasEndMarker: false };

    const markerRe = /\[\[\s*(end|stop|eos)\s*\]\]/i;
    const match = markerRe.exec(normalized);
    if (!match) return { template: normalized, hasEndMarker: false };

    return {
        template: normalized.slice(0, match.index),
        hasEndMarker: true,
    };
}

function splitHidePrefillTemplate(prefixTemplate) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { hideTemplate: '', hasKeepMarker: false };

    const markerRe = /\[\[\s*keep\s*\]\]/i;
    const match = markerRe.exec(normalized);
    if (!match) return { hideTemplate: normalized, hasKeepMarker: false };

    return {
        hideTemplate: normalized.slice(0, match.index),
        hasKeepMarker: true,
    };
}

function buildHidePrefillState(prefixTemplate, context) {
    const { hideTemplate } = splitHidePrefillTemplate(prefixTemplate);
    if (!hideTemplate) return { literal: '', regex: null };

    if (!prefixHasSlots(hideTemplate)) {
        return { literal: hideTemplate, regex: null };
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(hideTemplate, context);
    try {
        return {
            literal: '',
            regex: new RegExp(`^((?:${prefixRegex}))`),
        };
    } catch {
        return { literal: hideTemplate, regex: null };
    }
}

function curlyQuoteLiteralsOutsideSlots(template) {
    const source = String(template ?? '');
    const slotRe = /\[\[[^\]]+?\]\]/g;
    let out = '';
    let last = 0;
    let match;
    let open = true;

    const transformLiteral = (literal) => String(literal ?? '').replace(/"/g, () => {
        if (open) {
            open = false;
            return '\u201C';
        }
        open = true;
        return '\u201D';
    });

    while ((match = slotRe.exec(source)) !== null) {
        out += transformLiteral(source.slice(last, match.index));
        out += match[0];
        last = match.index + match[0].length;
    }

    out += transformLiteral(source.slice(last));
    return out;
}

function straightenCurlyQuotes(text) {
    return String(text ?? '')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, '\'');
}

function getPatternModeForRequest(provider, modelId, targetUrl) {
    const providerId = String(provider ?? '').toLowerCase();
    const model = String(modelId ?? '').toLowerCase();
    const host = String(targetUrl?.hostname ?? '').toLowerCase();

    if (providerId === 'anthropic-messages') return 'anthropic';
    if (providerId === 'openai-chat' && host.includes('anthropic')) return 'anthropic';
    if (host.includes('openrouter.ai') && (model.startsWith('anthropic/') || model.includes('claude'))) return 'anthropic';
    if (model.includes('claude') || model.includes('anthropic')) return 'anthropic';
    return 'default';
}

function buildAntiSlopContinuation(banListStr) {
    const raw = String(banListStr ?? '');
    if (!raw.trim()) return null;

    const seen = new Set();
    const words = [];
    for (const line of raw.split('\n')) {
        const entry = line.trim();
        if (!entry || seen.has(entry.toLowerCase())) continue;
        seen.add(entry.toLowerCase());
        words.push(entry);
    }
    if (words.length === 0) return null;

    const mkNode = () => ({ ch: new Map(), end: false });
    const root = mkNode();
    for (const word of words) {
        let node = root;
        for (const ch of word) {
            const key = ch.toLowerCase();
            if (!node.ch.has(key)) node.ch.set(key, mkNode());
            node = node.ch.get(key);
        }
        node.end = true;
    }

    const escapeClassChar = (ch) => (ch === ']' || ch === '\\' || ch === '^' || ch === '-') ? `\\${ch}` : ch;

    function toRegex(node) {
        if (node.ch.size === 0) return null;

        const excludes = [];
        const branches = [];
        for (const [key, child] of node.ch) {
            const lower = key.toLowerCase();
            const upper = key.toUpperCase();
            const hasCase = lower !== upper;
            excludes.push(escapeClassChar(lower));
            if (hasCase) excludes.push(escapeClassChar(upper));

            if (child.end) continue;

            const charExpr = hasCase ? `[${upper}${lower}]` : escapeClassChar(key);
            const sub = toRegex(child);
            branches.push(sub ? `${charExpr}(?:$|${sub})` : charExpr);
        }

        return `([^${excludes.join('')}]${branches.length > 0 ? `|${branches.join('|')}` : ''})`;
    }

    const expr = toRegex(root);
    if (!expr) return null;

    try {
        new RegExp(expr);
    } catch {
        return null;
    }

    return expr;
}

function buildPatternResponseSchema(prefix, opts = {}) {
    const mustEndAfterTemplate = !!opts.mustEndAfterTemplate;
    const minChars = mustEndAfterTemplate ? 0 : clampInt(opts.minCharsAfterPrefix, 1, 10000, 1);
    const newlineToken = String(opts.newlineToken ?? '\\n');
    const patternMode = String(opts.patternMode ?? 'default');
    const knownNames = Array.isArray(opts.knownNames) ? opts.knownNames : [];
    const joinSuffixRegex = String(opts.joinSuffixRegex ?? '');
    const wirePrefix = encodeNewlines(prefix, newlineToken);
    const buildContext = { newlineToken, patternMode, knownNames };

    let prefixRegex = buildPrefixRegexFromWireTemplate(wirePrefix, buildContext);
    if (newlineToken) {
        const escapedToken = escapeRegExp(newlineToken);
        prefixRegex = prefixRegex.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
    }

    if (patternMode === 'anthropic') {
        prefixRegex = prefixRegex.replace(/[^\x00-\x7F]/g, '.');
    }

    if (joinSuffixRegex) {
        prefixRegex += joinSuffixRegex;
    }

    const defaultAnyChar = anyCharIncludingNewlineExpr();
    const antiSlopExpr = buildAntiSlopContinuation(opts.antiSlopBanList);
    const anyChar = antiSlopExpr || defaultAnyChar;
    let pattern = '';
    if (mustEndAfterTemplate) {
        let trailing = '[\\t \\r\\n]*';
        if (newlineToken && /^[\x00-\x7F]*$/.test(newlineToken)) {
            const escapedToken = escapeRegExp(newlineToken);
            trailing = `[\\t ]*(?:${escapedToken}|\\n)?(?:[\\t ]*(?:${escapedToken}|\\n)[\\t ]*)*`;
        }
        pattern = `^(?:${prefixRegex})${trailing}$`;
    } else if (patternMode === 'anthropic') {
        pattern = `^(?:${prefixRegex})${anyChar}+$`;
    } else {
        pattern = `^(?:${prefixRegex})${anyChar}{${minChars},}$`;
    }

    try {
        new RegExp(pattern);
    } catch {
        pattern = mustEndAfterTemplate
            ? `^(?:${prefixRegex})[\\t \\r\\n]*$`
            : `^(?:${prefixRegex})${patternMode === 'anthropic' ? anyChar + '+' : `${anyChar}{${minChars},}`}$`;
    }

    return {
        type: 'object',
        properties: {
            response: {
                type: 'string',
                description: '',
                pattern,
            },
        },
        required: ['response'],
        additionalProperties: false,
    };
}

function buildEnumResponseSchema(prefix, opts = {}) {
    if (opts.mustEndAfterTemplate) {
        return {
            type: 'object',
            properties: {
                response: {
                    type: 'string',
                    enum: [String(prefix ?? '')],
                    description: '',
                },
            },
            required: ['response'],
            additionalProperties: false,
        };
    }

    return {
        type: 'object',
        properties: {
            prefix: {
                type: 'string',
                enum: [String(prefix ?? '')],
                description: '',
            },
            response: {
                type: 'string',
                description: '',
            },
        },
        required: ['prefix', 'response'],
        additionalProperties: false,
    };
}

function flattenSchemaForProvider(schema, provider) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    const schemaCopy = cloneJson(schema);
    const isGoogleApi = provider === 'gemini-generate-content';
    const definitions = schemaCopy.$defs || {};
    delete schemaCopy.$defs;

    function resolve(obj, parents = []) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }
        if (Array.isArray(obj)) {
            return obj.map((item) => resolve(item, parents));
        }

        if (obj.$ref?.startsWith('#/$defs/')) {
            const defName = obj.$ref.split('/').pop();
            if (parents.includes(defName)) return {};
            if (definitions[defName]) {
                return resolve(cloneJson(definitions[defName]), [...parents, defName]);
            }
            return {};
        }

        const result = {};
        for (const key in obj) {
            if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
            if (isGoogleApi && ['default', 'additionalProperties', 'exclusiveMinimum', 'propertyNames'].includes(key)) {
                continue;
            }
            result[key] = resolve(obj[key], parents);
        }

        return result;
    }

    const flattenedSchema = resolve(schemaCopy);
    delete flattenedSchema.$schema;
    return flattenedSchema;
}

function decodeStructuredText(text, context) {
    if (context.schemaMode === 'enum_prefix' || context.schemaMode === 'enum_exact') {
        return String(text ?? '');
    }
    return straightenCurlyQuotes(decodeNewlines(text, context.newlineToken));
}

function applyDisplayHiding(text, context) {
    if (!context?.hidePrefillInDisplay) return String(text ?? '');

    const normalized = normalizeNewlines(text);
    const hideState = context.hideState;
    if (!hideState) return normalized;

    if (hideState.regex instanceof RegExp) {
        const match = hideState.regex.exec(normalized);
        if (match && typeof match[1] === 'string') {
            return normalized.slice(match[1].length);
        }
    }

    if (hideState.literal && normalized.startsWith(hideState.literal)) {
        return normalized.slice(hideState.literal.length);
    }

    return normalized;
}

function trimMalformedTrailingGarbage(text, context) {
    const normalized = normalizeNewlines(String(text ?? ''));
    if (!normalized) return normalized;

    const prefillTemplate = String(context?.prefillTemplate ?? '');
    const quoteAware = /["\u201C]/.test(prefillTemplate);
    const quoteChars = quoteAware ? ['\u201D', '"'] : ['"', '\u201D'];

    const isSuspiciousSuffix = (suffix) => (
        /^[\]\[\}\{\)\(\\\/\u3010\u3011]/u.test(suffix) ||
        /^[\]\[\}\{\)\(,"'\\\/\s\u200B-\u200D\uFEFF\u3010\u3011]+$/u.test(suffix) ||
        /^[\]\[\}\{\)\(,"'\\\/\s\u200B-\u200D\uFEFF\u3010\u3011]+.*(?:assistant\b|user\b|system\b|model\b|json(?:_object)?\b|response\b|code\b|final\b|to=)/iu.test(suffix)
    );

    const startIndex = quoteAware ? Math.max(0, Math.min(normalized.length - 1, prefillTemplate.length)) : 0;
    for (const quoteChar of quoteChars) {
        let quoteIndex = normalized.indexOf(quoteChar, startIndex);
        while (quoteIndex >= 0) {
            const suffix = normalized.slice(quoteIndex + 1).trimStart();
            if (suffix && isSuspiciousSuffix(suffix)) {
                return normalized.slice(0, quoteIndex + 1);
            }
            quoteIndex = normalized.indexOf(quoteChar, quoteIndex + 1);
        }
    }

    return normalized;
}

function canonicalizeForContinueMatch(text) {
    const input = normalizeNewlines(String(text ?? ''));
    let out = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        switch (ch) {
            case '\u00A0': out += ' '; break;
            case '\u201C':
            case '\u201D':
                out += '"';
                break;
            case '\u2018':
            case '\u2019':
                out += '\'';
                break;
            case '\u2010':
            case '\u2011':
            case '\u2012':
            case '\u2013':
            case '\u2014':
                out += '-';
                break;
            default:
                out += ch;
                break;
        }
    }
    return out.toLowerCase();
}

function buildStripState(prefixTemplate, context) {
    const normalized = normalizeNewlines(prefixTemplate);
    if (!normalized) return { literal: '', regex: null };

    if (!prefixHasSlots(normalized)) {
        return { literal: normalized, regex: null };
    }

    const prefixRegex = buildPrefixRegexFromWireTemplate(normalized, context);
    try {
        return {
            literal: '',
            regex: new RegExp(`^((?:${prefixRegex}))`),
        };
    } catch {
        return { literal: normalized, regex: null };
    }
}

function buildContinueOverlapStripState(overlapText, context) {
    const normalized = normalizeNewlines(overlapText);
    if (!normalized) return { literal: '', regex: null };

    if (context?.patternMode === 'anthropic' && /[^\x00-\x7F]/.test(normalized)) {
        try {
            const regexSrc = normalized.split('').map((ch) => /[^\x00-\x7F]/.test(ch) ? '.' : escapeRegExp(ch)).join('');
            return {
                literal: normalized,
                regex: new RegExp(`^(${regexSrc})`),
            };
        } catch {
            return { literal: normalized, regex: null };
        }
    }

    return { literal: normalized, regex: null };
}

function stripPrefixWithState(text, state) {
    const normalized = normalizeNewlines(text);
    if (state?.regex instanceof RegExp) {
        const match = state.regex.exec(normalized);
        if (match && typeof match[1] === 'string') {
            return normalized.slice(match[1].length);
        }
    }

    const literal = String(state?.literal ?? '');
    if (literal && normalized.startsWith(literal)) {
        return normalized.slice(literal.length);
    }

    return normalized;
}

function computeContinueOverlapBase(baseText, maxChars = 14) {
    const base = normalizeNewlines(String(baseText ?? ''));
    if (!base) return '';
    const n = clampInt(maxChars, 0, 240, 14);
    if (n <= 0) return '';
    return base.slice(Math.max(0, base.length - n));
}

function buildContinueJoinPlaceholder(baseText) {
    const base = normalizeNewlines(String(baseText ?? ''));
    if (base.length < 2) return '';

    const last = base[base.length - 1];
    const prev = base[base.length - 2];

    const isAsciiLetter = (ch) => /[A-Za-z]/.test(ch);
    const isAsciiUpper = (ch) => /[A-Z]/.test(ch);
    const isAsciiAlphaNum = (ch) => /[A-Za-z0-9]/.test(ch);

    if (isAsciiLetter(last) && /[\s"'“”‘’(\[{<,.;:!?-]/.test(prev)) {
        return "(?:[a-zA-Z\\-\\'])";
    }

    if (isAsciiAlphaNum(last) && isAsciiUpper(last) === false) {
        return '[^A-Z]';
    }

    return '';
}

function stripContinuePrefix(text, context) {
    const normalized = normalizeNewlines(text);
    const continueState = context?.continue;
    if (!continueState?.active) return normalized;

    const strippedByBase = stripPrefixWithState(normalized, continueState.baseStripState);
    if (strippedByBase !== normalized) return strippedByBase;

    const base = String(continueState.baseText ?? '');
    if (!base) return normalized;

    const baseCanon = canonicalizeForContinueMatch(base);
    const textCanon = canonicalizeForContinueMatch(normalized);

    if (baseCanon.length >= 40 && textCanon.startsWith(baseCanon)) {
        return normalized.slice(baseCanon.length);
    }

    const tryTailLen = (tailLen) => {
        const len = Math.min(tailLen, baseCanon.length, textCanon.length);
        if (len < 20) return null;
        const needle = baseCanon.slice(baseCanon.length - len);
        const expected = Math.max(0, baseCanon.length - len);

        let bestPos = -1;
        let bestScore = Number.POSITIVE_INFINITY;
        let start = 0;
        while (true) {
            const pos = textCanon.indexOf(needle, start);
            if (pos === -1) break;
            const score = Math.abs(pos - expected);
            if (score < bestScore) {
                bestScore = score;
                bestPos = pos;
                if (bestScore === 0) break;
            }
            start = pos + 1;
        }

        if (bestPos >= 0) {
            const cut = bestPos + len;
            if (cut >= 0 && cut <= normalized.length) return normalized.slice(cut);
        }

        return null;
    };

    const maxLen = Math.min(520, baseCanon.length, textCanon.length);
    for (let len = maxLen; len >= 40; len -= 20) {
        const candidate = tryTailLen(len);
        if (typeof candidate === 'string') return candidate;
    }

    return (
        tryTailLen(220) ??
        tryTailLen(140) ??
        tryTailLen(90) ??
        tryTailLen(60) ??
        tryTailLen(40) ??
        normalized
    );
}

function stripContinueOverlapPrefix(text, context) {
    const normalized = normalizeNewlines(text);
    const continueState = context?.continue;
    if (!continueState?.active) return normalized;
    return stripPrefixWithState(normalized, continueState.overlapStripState);
}

function applyContinueJoin(text, context) {
    const normalized = normalizeNewlines(String(text ?? ''));
    const continueState = context?.continue;
    if (!continueState?.active) return normalized;

    const base = String(continueState.baseText ?? '');
    if (!base) return normalized;

    const afterOverlap = stripContinueOverlapPrefix(normalized, context);
    if (afterOverlap !== normalized) return base + afterOverlap;

    const delta = stripContinuePrefix(normalized, context);
    if (delta !== normalized) return base + delta;

    const baseCanon = canonicalizeForContinueMatch(base);
    const textCanon = canonicalizeForContinueMatch(normalized);
    const probe = Math.min(120, baseCanon.length, textCanon.length);

    if (normalized.length < base.length && probe >= 20 && baseCanon.startsWith(textCanon.slice(0, probe))) {
        return base;
    }

    if (normalized.length >= base.length && probe >= 40 && textCanon.startsWith(baseCanon.slice(0, probe))) {
        return normalized;
    }

    return base + normalized;
}

function tryExtractJsonStringField(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;
    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    let out = '';
    let escaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';
    const index = match.index + match[0].length;

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            return out.length > 0 ? out : '';
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

function tryExtractJsonStringFieldLoose(rawText, fieldName) {
    if (typeof rawText !== 'string' || rawText.length === 0) return null;
    const safeField = String(fieldName ?? '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!safeField) return null;

    const match = new RegExp(`"${safeField}"\\s*:\\s*"`, 'm').exec(rawText);
    if (!match) return null;

    const findNextNonWhitespace = (from) => {
        for (let i = from; i < rawText.length; i++) {
            const ch = rawText[i];
            if (!/[\s\r\n\t]/.test(ch)) return ch;
        }
        return '';
    };

    let out = '';
    let escaped = false;
    let unicodeRemaining = 0;
    let unicodeBuffer = '';
    const index = match.index + match[0].length;

    for (let i = index; i < rawText.length; i++) {
        const ch = rawText[i];

        if (unicodeRemaining > 0) {
            unicodeBuffer += ch;
            unicodeRemaining--;
            if (unicodeRemaining === 0) {
                if (/^[0-9a-fA-F]{4}$/.test(unicodeBuffer)) {
                    out += String.fromCharCode(parseInt(unicodeBuffer, 16));
                }
                unicodeBuffer = '';
            }
            continue;
        }

        if (escaped) {
            escaped = false;
            switch (ch) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u':
                    unicodeRemaining = 4;
                    unicodeBuffer = '';
                    break;
                default:
                    out += ch;
                    break;
            }
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            const next = findNextNonWhitespace(i + 1);
            if (next === '}' || next === ',') {
                break;
            }
            out += '"';
            continue;
        }

        out += ch;
    }

    return out.length > 0 ? out : '';
}

function tryUnwrapStructuredObject(value, context) {
    if (!value || typeof value !== 'object') return null;

    if (typeof value.prefix === 'string' && typeof value.response === 'string') {
        return decodeStructuredText(value.prefix, context) + decodeStructuredText(value.response, context);
    }

    if (typeof value.prefix === 'string' && typeof value.content === 'string') {
        return decodeStructuredText(value.prefix, context) + decodeStructuredText(value.content, context);
    }

    if (typeof value.response === 'string') {
        return decodeStructuredText(value.response, context);
    }

    if (typeof value.value === 'string') {
        return decodeStructuredText(value.value, context);
    }

    if (typeof value.content === 'string') {
        return decodeStructuredText(value.content, context);
    }

    return null;
}

function tryUnwrapStructuredOutput(text, context) {
    if (typeof text !== 'string' || text.length === 0) return null;

    try {
        const parsed = JSON.parse(text);
        const unwrapped = tryUnwrapStructuredObject(parsed, context);
        if (unwrapped != null) return unwrapped;
    } catch {
        const response = tryExtractJsonStringFieldLoose(text, 'response');
        if (typeof response === 'string') return decodeStructuredText(response, context);

        const value = tryExtractJsonStringFieldLoose(text, 'value');
        if (typeof value === 'string') return decodeStructuredText(value, context);

        const prefix = tryExtractJsonStringFieldLoose(text, 'prefix');
        const content = tryExtractJsonStringFieldLoose(text, 'content');
        if (typeof prefix === 'string' || typeof content === 'string') {
            return decodeStructuredText(prefix ?? '', context) + decodeStructuredText(content ?? '', context);
        }
    }

    const strictResponse = tryExtractJsonStringField(text, 'response');
    if (typeof strictResponse === 'string') return decodeStructuredText(strictResponse, context);

    const strictValue = tryExtractJsonStringField(text, 'value');
    if (typeof strictValue === 'string') return decodeStructuredText(strictValue, context);

    const strictPrefix = tryExtractJsonStringField(text, 'prefix');
    const strictContent = tryExtractJsonStringField(text, 'content');
    if (typeof strictPrefix === 'string' || typeof strictContent === 'string') {
        return decodeStructuredText(strictPrefix ?? '', context) + decodeStructuredText(strictContent ?? '', context);
    }

    return null;
}

function unwrapStructuredResult(value, context) {
    if (typeof value === 'string') {
        const unwrapped = tryUnwrapStructuredOutput(value, context) ?? decodeStructuredText(value, context);
        const trimmed = trimMalformedTrailingGarbage(unwrapped, context);
        return applyDisplayHiding(applyContinueJoin(trimmed, context), context);
    }
    if (value && typeof value === 'object') {
        const unwrapped = tryUnwrapStructuredObject(value, context);
        if (unwrapped == null) return null;
        const trimmed = trimMalformedTrailingGarbage(unwrapped, context);
        return applyDisplayHiding(applyContinueJoin(trimmed, context), context);
    }
    return null;
}

function extractPlainTextFromContent(content) {
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

function collectKnownNamesFromMessages(messages) {
    const names = new Set();
    if (!Array.isArray(messages)) return [];

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const name = String(message.name ?? '').trim();
        if (name) names.add(name);
    }

    return [...names];
}

function collectKnownNamesFromResponsesInput(input) {
    const names = new Set();
    if (!Array.isArray(input)) return [];

    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name ?? '').trim();
        if (name) names.add(name);
    }

    return [...names];
}

function findTrailingAssistantMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || typeof message !== 'object') continue;
        if (message.role !== 'assistant') continue;
        const prefill = extractPlainTextFromContent(message.content);
        if (!prefill) continue;
        const hasLaterNonSystem = messages.slice(index + 1).some((item) => item && typeof item === 'object' && item.role !== 'system');
        return { index, prefill, hasLaterNonSystem };
    }
    return null;
}

function findTrailingAssistantResponsesInput(input) {
    if (!Array.isArray(input) || input.length === 0) return null;
    for (let index = input.length - 1; index >= 0; index--) {
        const item = input[index];
        if (!item || typeof item !== 'object') continue;
        if (item.role !== 'assistant') continue;
        const prefill = extractPlainTextFromContent(item.content);
        if (!prefill) continue;
        const hasLaterNonSystem = input.slice(index + 1).some((entry) => entry && typeof entry === 'object' && entry.role !== 'system');
        return { index, prefill, hasLaterNonSystem };
    }
    return null;
}

function findTrailingGeminiModelContent(contents) {
    if (!Array.isArray(contents) || contents.length === 0) return null;
    for (let index = contents.length - 1; index >= 0; index--) {
        const item = contents[index];
        if (!item || typeof item !== 'object') continue;
        const role = String(item.role ?? '').toLowerCase();
        if (role !== 'model') continue;
        const prefill = extractPlainTextFromContent(item.parts);
        if (!prefill) continue;
        const hasLaterNonSystem = contents.slice(index + 1).some((entry) => entry && typeof entry === 'object' && String(entry.role ?? '').toLowerCase() !== 'system');
        return { index, prefill, hasLaterNonSystem };
    }
    return null;
}

function extractGenericMessageText(item) {
    if (!item || typeof item !== 'object') return '';
    if (Object.prototype.hasOwnProperty.call(item, 'content')) return extractPlainTextFromContent(item.content);
    if (Object.prototype.hasOwnProperty.call(item, 'parts')) return extractPlainTextFromContent(item.parts);
    return '';
}

function looksLikeContinueInstruction(text) {
    const normalized = normalizeNewlines(String(text ?? '')).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.includes('continue your last message')) return true;
    if (normalized.includes('continue your last response')) return true;
    if (normalized.includes('continue without repeating')) return true;
    if (normalized.includes('continue from here')) return true;
    if (normalized.includes('carry on from here')) return true;
    if (/^\[?\s*(continue|go on|carry on|keep going|resume)\b/.test(normalized)) return true;
    return false;
}

function detectContinueRequest({ provider, jsonBody, trailingIndex, config }) {
    const mode = String(config?.continueMode ?? 'off').toLowerCase();
    if (mode === 'off') return false;
    if (mode === 'force') return true;

    const explicitFields = [
        jsonBody?.type,
        jsonBody?.mode,
        jsonBody?.operation,
        jsonBody?.request_type,
        jsonBody?.action,
    ];
    if (explicitFields.some((value) => String(value ?? '').toLowerCase() === 'continue')) {
        return true;
    }
    if (jsonBody?.continue === true) return true;

    let items = [];
    if (provider === 'openai-chat' || provider === 'anthropic-messages') {
        items = Array.isArray(jsonBody?.messages) ? jsonBody.messages : [];
    } else if (provider === 'openai-responses') {
        items = Array.isArray(jsonBody?.input) ? jsonBody.input : [];
    } else if (provider === 'gemini-generate-content') {
        items = Array.isArray(jsonBody?.contents) ? jsonBody.contents : [];
    }

    for (let index = trailingIndex + 1; index < items.length; index++) {
        const text = extractGenericMessageText(items[index]);
        if (looksLikeContinueInstruction(text)) return true;
    }

    return false;
}

function buildStructuredContext({ provider, targetUrl, modelId, prefillTemplate, knownNames, config, continueActive = false }) {
    const effectiveConfig = {
        enabled: Boolean(config?.enabled ?? DEFAULT_PROXY_CONFIG.enabled),
        minCharsAfterPrefix: clampInt(config?.minCharsAfterPrefix, 1, 10000, DEFAULT_PROXY_CONFIG.minCharsAfterPrefix),
        newlineToken: /[\r\n]/.test(String(config?.newlineToken ?? ''))
            ? DEFAULT_PROXY_CONFIG.newlineToken
            : String(config?.newlineToken ?? DEFAULT_PROXY_CONFIG.newlineToken),
        hidePrefillInDisplay: Boolean(config?.hidePrefillInDisplay ?? DEFAULT_PROXY_CONFIG.hidePrefillInDisplay),
        antiSlopBanList: String(config?.antiSlopBanList ?? DEFAULT_PROXY_CONFIG.antiSlopBanList),
        continueOverlapChars: clampInt(config?.continueOverlapChars, 0, 240, DEFAULT_PROXY_CONFIG.continueOverlapChars),
    };

    let cleanedTemplate = normalizeNewlines(
        String(prefillTemplate ?? '')
            .replace(/\[\[\s*sp\s*:[^\]]*\]\]/gi, '')
            .replace(/\[\[\s*pg\s*\]\]/gi, ''),
    );
    const endSplit = splitEndPrefillTemplate(cleanedTemplate);
    cleanedTemplate = endSplit.template;
    if (!cleanedTemplate) return null;

    const mustEndAfterTemplate = endSplit.hasEndMarker;
    const patternMode = getPatternModeForRequest(provider, modelId, targetUrl);
    const continueBaseText = cleanedTemplate;
    const continueOverlapText = continueActive ? computeContinueOverlapBase(continueBaseText, effectiveConfig.continueOverlapChars) : '';
    const continueSchemaPrefix = continueActive ? (continueOverlapText || continueBaseText) : '';
    const continueJoinSuffixRegex = continueActive ? buildContinueJoinPlaceholder(continueBaseText) : '';
    const continueBuildContext = { newlineToken: '', patternMode, knownNames };
    const continueState = continueActive ? {
        active: true,
        baseText: continueBaseText,
        overlapText: continueOverlapText,
        baseStripState: buildStripState(continueBaseText, continueBuildContext),
        overlapStripState: buildContinueOverlapStripState(continueSchemaPrefix, { patternMode }),
    } : {
        active: false,
        baseText: '',
        overlapText: '',
        baseStripState: null,
        overlapStripState: null,
    };

    const rawSchemaPrefix = continueActive ? continueSchemaPrefix : cleanedTemplate;
    const schemaPrefix = curlyQuoteLiteralsOutsideSlots(rawSchemaPrefix);
    const newlineToken = chooseNewlineToken(schemaPrefix, effectiveConfig.newlineToken);
    const hideBuildContext = { newlineToken, patternMode, knownNames };
    return {
        provider,
        schemaMode: 'pattern',
        prefillTemplate: schemaPrefix,
        mustEndAfterTemplate,
        newlineToken,
        patternMode,
        knownNames,
        continue: {
            ...continueState,
            overlapStripState: continueActive ? buildContinueOverlapStripState(continueSchemaPrefix, { patternMode }) : null,
        },
        hidePrefillInDisplay: effectiveConfig.hidePrefillInDisplay,
        hideState: effectiveConfig.hidePrefillInDisplay
            ? buildHidePrefillState(cleanedTemplate, hideBuildContext)
            : null,
        responseSchema: buildPatternResponseSchema(schemaPrefix, {
            minCharsAfterPrefix: continueActive ? 1 : (mustEndAfterTemplate ? 0 : effectiveConfig.minCharsAfterPrefix),
            newlineToken,
            patternMode,
            knownNames,
            mustEndAfterTemplate,
            joinSuffixRegex: continueJoinSuffixRegex,
            antiSlopBanList: effectiveConfig.antiSlopBanList,
        }),
    };
}

function detectProvider(targetUrl, jsonBody) {
    const pathname = String(targetUrl?.pathname ?? '').toLowerCase();

    if (Array.isArray(jsonBody?.contents) && pathname.includes('generatecontent')) {
        return 'gemini-generate-content';
    }
    if (Array.isArray(jsonBody?.messages) && pathname.endsWith('/messages')) {
        return 'anthropic-messages';
    }
    if (Array.isArray(jsonBody?.input) && pathname.includes('/responses')) {
        return 'openai-responses';
    }
    if (Array.isArray(jsonBody?.messages)) {
        return 'openai-chat';
    }
    return '';
}

function normalizeOpenAiChatModelRequest(jsonBody) {
    if (!jsonBody || typeof jsonBody !== 'object') return jsonBody;

    const model = String(jsonBody.model ?? '');
    if (!/(?:^|\/)gpt-5/.test(model)) {
        return jsonBody;
    }

    if (jsonBody.max_completion_tokens == null && jsonBody.max_tokens != null) {
        jsonBody.max_completion_tokens = jsonBody.max_tokens;
    }
    delete jsonBody.max_tokens;
    delete jsonBody.logprobs;
    delete jsonBody.top_logprobs;

    if (/gpt-5-chat-latest/.test(model)) {
        delete jsonBody.tools;
        delete jsonBody.tool_choice;
        return jsonBody;
    }

    if (/gpt-5\.(1|2|3|4)/.test(model)) {
        delete jsonBody.frequency_penalty;
        delete jsonBody.presence_penalty;
        delete jsonBody.logit_bias;
        delete jsonBody.stop;
        return jsonBody;
    }

    delete jsonBody.temperature;
    delete jsonBody.top_p;
    delete jsonBody.frequency_penalty;
    delete jsonBody.presence_penalty;
    delete jsonBody.logit_bias;
    delete jsonBody.stop;
    return jsonBody;
}

function isOpenRouterTarget(targetUrl) {
    const host = String(targetUrl?.hostname ?? '').toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}

function applyOpenRouterStructuredOutputRouting(targetUrl, jsonBody) {
    if (!isOpenRouterTarget(targetUrl) || !jsonBody || typeof jsonBody !== 'object') {
        return jsonBody;
    }

    const provider = (jsonBody.provider && typeof jsonBody.provider === 'object' && !Array.isArray(jsonBody.provider))
        ? { ...jsonBody.provider }
        : {};

    if (provider.require_parameters == null) {
        provider.require_parameters = true;
    }

    jsonBody.provider = provider;
    return jsonBody;
}

function extractGeminiModelId(targetUrl) {
    const pathname = String(targetUrl?.pathname ?? '');
    const match = /\/models\/([^/:?]+)(?::|$)/i.exec(pathname);
    if (match?.[1]) return match[1];

    const fallback = pathname.split('/').pop() ?? '';
    return fallback.split(':')[0] ?? '';
}

function calculateGeminiThinkingBudget(maxTokens, reasoningEffort, modelId) {
    const model = String(modelId ?? '').toLowerCase();
    const effort = String(reasoningEffort ?? '').trim().toLowerCase();
    const max = Math.max(0, clampInt(maxTokens, 0, 1_000_000, 0));

    const getFlashBudget = () => {
        let budgetTokens = 0;
        switch (effort) {
            case 'auto': return -1;
            case 'min': return 0;
            case 'low':
                budgetTokens = Math.floor(max * 0.1);
                break;
            case 'medium':
                budgetTokens = Math.floor(max * 0.25);
                break;
            case 'high':
                budgetTokens = Math.floor(max * 0.5);
                break;
            case 'max':
                budgetTokens = max;
                break;
            default:
                budgetTokens = 0;
                break;
        }

        return Math.min(budgetTokens, 24576);
    };

    const getFlashLiteBudget = () => {
        let budgetTokens = 0;
        switch (effort) {
            case 'auto': return -1;
            case 'min': return 0;
            case 'low':
                budgetTokens = Math.floor(max * 0.1);
                break;
            case 'medium':
                budgetTokens = Math.floor(max * 0.25);
                break;
            case 'high':
                budgetTokens = Math.floor(max * 0.5);
                break;
            case 'max':
                budgetTokens = max;
                break;
            default:
                budgetTokens = 0;
                break;
        }

        return Math.max(Math.min(budgetTokens, 24576), 512);
    };

    const getProBudget = () => {
        let budgetTokens = 0;
        switch (effort) {
            case 'auto': return -1;
            case 'min':
                budgetTokens = 128;
                break;
            case 'low':
                budgetTokens = Math.floor(max * 0.1);
                break;
            case 'medium':
                budgetTokens = Math.floor(max * 0.25);
                break;
            case 'high':
                budgetTokens = Math.floor(max * 0.5);
                break;
            case 'max':
                budgetTokens = max;
                break;
            default:
                budgetTokens = 0;
                break;
        }

        return Math.max(Math.min(budgetTokens, 32768), 128);
    };

    const getGemini3FlashBudget = () => {
        switch (effort) {
            case 'auto': return null;
            case 'min': return 'minimal';
            case 'low': return 'low';
            case 'medium': return 'medium';
            case 'high':
            case 'max':
                return 'high';
            default:
                return null;
        }
    };

    const getGemini3ProBudget = () => {
        switch (effort) {
            case 'auto': return null;
            case 'min':
            case 'low':
            case 'medium':
                return 'low';
            case 'high':
            case 'max':
                return 'high';
            default:
                return null;
        }
    };

    if (/gemini-3[.\d]*-pro/.test(model)) {
        return getGemini3ProBudget();
    }
    if (/gemini-3[.\d]*-flash/.test(model)) {
        return getGemini3FlashBudget();
    }
    if (/flash-lite/.test(model)) {
        return getFlashLiteBudget();
    }
    if (/flash/.test(model)) {
        return getFlashBudget();
    }
    if (/pro/.test(model)) {
        return getProBudget();
    }

    return null;
}

function buildGeminiThinkingConfig(jsonBody, generationConfig, modelId) {
    if (generationConfig?.thinkingConfig && typeof generationConfig.thinkingConfig === 'object') {
        return generationConfig.thinkingConfig;
    }

    const model = String(modelId ?? '').toLowerCase();
    if (!(/^gemini-2\.5-(flash|pro)/.test(model) && !/-image(?:-preview)?$/.test(model)) && !/^gemini-3[.\d]*-(flash|pro)/.test(model)) {
        return null;
    }

    const includeReasoning = Boolean(jsonBody?.includeReasoning ?? jsonBody?.include_reasoning);
    const reasoningEffort = String(jsonBody?.reasoningEffort ?? jsonBody?.reasoning_effort ?? '');
    const maxTokens = generationConfig?.maxOutputTokens
        ?? generationConfig?.max_output_tokens
        ?? jsonBody?.max_tokens
        ?? jsonBody?.maxOutputTokens
        ?? 0;
    const budget = calculateGeminiThinkingBudget(maxTokens, reasoningEffort, modelId);
    const thinkingConfig = { includeThoughts: includeReasoning };

    if (typeof budget === 'number' && Number.isInteger(budget)) {
        thinkingConfig.thinkingBudget = budget;
    } else if (typeof budget === 'string' && budget) {
        thinkingConfig.thinkingLevel = budget;
    }

    return thinkingConfig;
}

function rewriteOpenAiChatRequest(targetUrl, jsonBody, config) {
    if (jsonBody.response_format || (Array.isArray(jsonBody.tools) && jsonBody.tools.length > 0)) return null;

    const rewritten = cloneJson(jsonBody);
    normalizeOpenAiChatModelRequest(rewritten);
    const trailing = findTrailingAssistantMessage(rewritten.messages);
    if (!trailing) return null;
    const continueActive = detectContinueRequest({
        provider: 'openai-chat',
        jsonBody: rewritten,
        trailingIndex: trailing.index,
        config,
    });
    if (!continueActive && trailing.hasLaterNonSystem) return null;

    const context = buildStructuredContext({
        provider: 'openai-chat',
        targetUrl,
        modelId: rewritten.model,
        prefillTemplate: trailing.prefill,
        knownNames: collectKnownNamesFromMessages(rewritten.messages),
        config,
        continueActive,
    });
    if (!context) return null;

    if (!continueActive) {
        rewritten.messages.splice(trailing.index, 1);
    }
    rewritten.stream = jsonBody?.stream === true;
    rewritten.response_format = {
        type: 'json_schema',
        json_schema: {
            name: 'response',
            strict: true,
            schema: context.responseSchema,
        },
    };
    applyOpenRouterStructuredOutputRouting(targetUrl, rewritten);

    return { targetUrl, jsonBody: rewritten, context };
}

function rewriteOpenAiResponsesRequest(targetUrl, jsonBody, config) {
    if (jsonBody?.text?.format || (Array.isArray(jsonBody.tools) && jsonBody.tools.length > 0)) return null;

    const rewritten = cloneJson(jsonBody);
    const trailing = findTrailingAssistantResponsesInput(rewritten.input);
    if (!trailing) return null;
    const continueActive = detectContinueRequest({
        provider: 'openai-responses',
        jsonBody: rewritten,
        trailingIndex: trailing.index,
        config,
    });
    if (!continueActive && trailing.hasLaterNonSystem) return null;

    const context = buildStructuredContext({
        provider: 'openai-responses',
        targetUrl,
        modelId: rewritten.model,
        prefillTemplate: trailing.prefill,
        knownNames: collectKnownNamesFromResponsesInput(rewritten.input),
        config,
        continueActive,
    });
    if (!context) return null;

    if (!continueActive) {
        rewritten.input.splice(trailing.index, 1);
    }
    rewritten.stream = false;
    rewritten.text = {
        ...(rewritten.text && typeof rewritten.text === 'object' ? rewritten.text : {}),
        format: {
            type: 'json_schema',
            name: 'response',
            strict: true,
            schema: context.responseSchema,
        },
    };
    applyOpenRouterStructuredOutputRouting(targetUrl, rewritten);

    return { targetUrl, jsonBody: rewritten, context };
}

function rewriteAnthropicMessagesRequest(targetUrl, jsonBody, config) {
    if ((Array.isArray(jsonBody.tools) && jsonBody.tools.length > 0) || jsonBody.tool_choice || jsonBody.thinking) return null;

    const rewritten = cloneJson(jsonBody);
    const trailing = findTrailingAssistantMessage(rewritten.messages);
    if (!trailing) return null;
    const continueActive = detectContinueRequest({
        provider: 'anthropic-messages',
        jsonBody: rewritten,
        trailingIndex: trailing.index,
        config,
    });
    if (!continueActive && trailing.hasLaterNonSystem) return null;

    const context = buildStructuredContext({
        provider: 'anthropic-messages',
        targetUrl,
        modelId: rewritten.model,
        prefillTemplate: trailing.prefill,
        knownNames: collectKnownNamesFromMessages(rewritten.messages),
        config,
        continueActive,
    });
    if (!context) return null;

    if (!continueActive) {
        rewritten.messages.splice(trailing.index, 1);
    } else {
        const isLastMessage = trailing.index === rewritten.messages.length - 1;
        if (isLastMessage && rewritten.messages[trailing.index]?.role === 'assistant') {
            rewritten.messages[trailing.index].role = 'user';
        }
    }
    rewritten.stream = false;
    rewritten.tools = [
        {
            name: 'response',
            description: 'Well-formed JSON object',
            input_schema: context.responseSchema,
        },
    ];
    rewritten.tool_choice = { type: 'tool', name: 'response' };

    return { targetUrl, jsonBody: rewritten, context };
}

function rewriteGeminiRequest(targetUrl, jsonBody, config) {
    const existingSchema = jsonBody?.generationConfig?.responseJsonSchema ?? jsonBody?.generationConfig?.responseSchema;
    if (existingSchema) return null;

    const rewritten = cloneJson(jsonBody);
    const trailing = findTrailingGeminiModelContent(rewritten.contents);
    if (!trailing) return null;
    const continueActive = detectContinueRequest({
        provider: 'gemini-generate-content',
        jsonBody: rewritten,
        trailingIndex: trailing.index,
        config,
    });
    if (!continueActive && trailing.hasLaterNonSystem) return null;

    const context = buildStructuredContext({
        provider: 'gemini-generate-content',
        targetUrl,
        modelId: extractGeminiModelId(targetUrl),
        prefillTemplate: trailing.prefill,
        knownNames: [],
        config,
        continueActive,
    });
    if (!context) return null;

    if (!continueActive) {
        rewritten.contents.splice(trailing.index, 1);
    }
    const nextGenerationConfig = rewritten.generationConfig && typeof rewritten.generationConfig === 'object'
        ? { ...rewritten.generationConfig }
        : {};
    const thinkingConfig = buildGeminiThinkingConfig(rewritten, nextGenerationConfig, extractGeminiModelId(targetUrl));
    rewritten.generationConfig = {
        ...nextGenerationConfig,
        candidateCount: nextGenerationConfig.candidateCount ?? 1,
        responseMimeType: 'application/json',
        responseSchema: flattenSchemaForProvider(context.responseSchema, 'gemini-generate-content'),
        ...(thinkingConfig ? { thinkingConfig } : {}),
    };
    if (!Array.isArray(rewritten.safetySettings) || rewritten.safetySettings.length === 0) {
        rewritten.safetySettings = cloneJson(GEMINI_SAFETY_SETTINGS);
    }

    const rewrittenUrl = new URL(targetUrl.toString());
    rewrittenUrl.pathname = rewrittenUrl.pathname.replace(/streamGenerateContent/i, 'generateContent');
    if (rewrittenUrl.searchParams.get('alt') === 'sse') {
        rewrittenUrl.searchParams.delete('alt');
    }

    return { targetUrl: rewrittenUrl, jsonBody: rewritten, context };
}

function rewriteProxyJsonRequest({ targetUrl, jsonBody, baseConfig = DEFAULT_PROXY_CONFIG }) {
    const config = {
        enabled: Boolean(baseConfig?.enabled ?? DEFAULT_PROXY_CONFIG.enabled),
        minCharsAfterPrefix: clampInt(baseConfig?.minCharsAfterPrefix, 1, 10000, DEFAULT_PROXY_CONFIG.minCharsAfterPrefix),
        newlineToken: String(baseConfig?.newlineToken ?? DEFAULT_PROXY_CONFIG.newlineToken),
        hidePrefillInDisplay: Boolean(baseConfig?.hidePrefillInDisplay ?? DEFAULT_PROXY_CONFIG.hidePrefillInDisplay),
        antiSlopBanList: String(baseConfig?.antiSlopBanList ?? DEFAULT_PROXY_CONFIG.antiSlopBanList),
        continueMode: String(baseConfig?.continueMode ?? DEFAULT_PROXY_CONFIG.continueMode),
        continueOverlapChars: clampInt(baseConfig?.continueOverlapChars, 0, 240, DEFAULT_PROXY_CONFIG.continueOverlapChars),
    };
    if (!config.enabled) return null;

    const provider = detectProvider(targetUrl, jsonBody);
    if (!provider) return null;

    switch (provider) {
        case 'openai-chat':
            return rewriteOpenAiChatRequest(targetUrl, jsonBody, config);
        case 'openai-responses':
            return rewriteOpenAiResponsesRequest(targetUrl, jsonBody, config);
        case 'anthropic-messages':
            return rewriteAnthropicMessagesRequest(targetUrl, jsonBody, config);
        case 'gemini-generate-content':
            return rewriteGeminiRequest(targetUrl, jsonBody, config);
        default:
            return null;
    }
}

function extractOpenAiMessageText(content) {
    return extractPlainTextFromContent(content);
}

function rewriteOpenAiChatResponse(jsonBody, context) {
    const rewritten = cloneJson(jsonBody);
    if (!Array.isArray(rewritten.choices)) return rewritten;

    for (const choice of rewritten.choices) {
        const content = extractOpenAiMessageText(choice?.message?.content);
        const unwrapped = unwrapStructuredResult(content, context);
        if (unwrapped == null || !choice?.message) continue;
        choice.message.content = unwrapped;
    }

    return rewritten;
}

function rewriteOpenAiResponsesResponse(jsonBody, context) {
    const rewritten = cloneJson(jsonBody);
    if (!Array.isArray(rewritten.output)) return rewritten;

    for (const item of rewritten.output) {
        if (!item || typeof item !== 'object' || item.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const block of item.content) {
            if (!block || typeof block !== 'object' || typeof block.text !== 'string') continue;
            const unwrapped = unwrapStructuredResult(block.text, context);
            if (unwrapped != null) block.text = unwrapped;
        }
    }

    return rewritten;
}

function rewriteAnthropicResponse(jsonBody, context) {
    const rewritten = cloneJson(jsonBody);
    if (!Array.isArray(rewritten.content)) return rewritten;

    let unwrapped = null;
    for (const block of rewritten.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_use' && block.name === 'response') {
            unwrapped = unwrapStructuredResult(block.input, context);
            if (unwrapped != null) break;
        }
        if (block.type === 'text' && typeof block.text === 'string') {
            unwrapped = unwrapStructuredResult(block.text, context);
            if (unwrapped != null) break;
        }
    }

    if (unwrapped == null) return rewritten;

    rewritten.content = [{ type: 'text', text: unwrapped }];
    if (rewritten.stop_reason === 'tool_use') rewritten.stop_reason = 'end_turn';
    rewritten.stop_sequence = null;
    return rewritten;
}

function rewriteGeminiResponse(jsonBody, context) {
    const rewritten = cloneJson(jsonBody);
    if (!Array.isArray(rewritten.candidates)) return rewritten;

    for (const candidate of rewritten.candidates) {
        const parts = candidate?.content?.parts;
        if (!Array.isArray(parts) || parts.length === 0) continue;
        const joinedText = parts.map((part) => String(part?.text ?? '')).join('');
        const unwrapped = unwrapStructuredResult(joinedText, context);
        if (unwrapped == null) continue;
        candidate.content.parts = [{ text: unwrapped }];
    }

    return rewritten;
}

function rewriteProxyJsonResponse({ jsonBody, context }) {
    if (!context || !context.provider) return jsonBody;

    switch (context.provider) {
        case 'openai-chat':
            return rewriteOpenAiChatResponse(jsonBody, context);
        case 'openai-responses':
            return rewriteOpenAiResponsesResponse(jsonBody, context);
        case 'anthropic-messages':
            return rewriteAnthropicResponse(jsonBody, context);
        case 'gemini-generate-content':
            return rewriteGeminiResponse(jsonBody, context);
        default:
            return jsonBody;
    }
}

function createUsageText(port) {
    return [
        'StructuredPrefill proxy',
        '',
        'Start:  npm start',
        `Listen: http://localhost:${port}`,
        '',
        'Usage:',
        `  POST http://localhost:${port}/openrouter/v1/chat/completions`,
        `  POST http://localhost:${port}/openai/v1/chat/completions`,
        `  POST http://localhost:${port}/anthropic/v1/messages`,
        `  POST http://localhost:${port}/google/v1beta/models/gemini-2.5-flash:generateContent`,
        '',
        'Also works:',
        `  POST http://localhost:${port}/v1/chat/completions`,
        `  POST http://localhost:${port}/v1/messages`,
        `  POST http://localhost:${port}/v1beta/models/gemini-2.5-flash:generateContent`,
        '',
        'Full explicit targets:',
        `  POST http://localhost:${port}/https://api.openai.com/v1/chat/completions`,
        `  POST http://localhost:${port}/https://api.anthropic.com/v1/messages`,
        `  POST http://localhost:${port}/https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
        '',
        'Behavior:',
        '  - Passes requests through by default.',
        '  - If the last assistant/model message is plain text, the proxy removes it, injects structured output, and unwraps the provider response back to plain text.',
        '  - Structured-prefill works with streaming and non-streaming requests.',
        '  - Settings live in proxy/config.yaml.',
        '',
        'Notes:',
        '  - Existing tools / structured-output payloads are left alone.',
        '  - Anti-slop, generic continue mode, and `[[pg]]` live in proxy/config.yaml.',
    ].join('\n');
}

module.exports = {
    DEFAULT_PROXY_CONFIG,
    buildPatternResponseSchema,
    createUsageText,
    decodeNewlines,
    encodeNewlines,
    prefixHasSlots,
    rewriteProxyJsonRequest,
    rewriteProxyJsonResponse,
    splitEndPrefillTemplate,
    tryUnwrapStructuredOutput,
    unwrapStructuredResult,
};
