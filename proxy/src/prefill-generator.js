'use strict';

const PREFILL_GEN_SLOT_REGEX = /\[\[\s*pg\s*\]\]/gi;

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

function templateHasPrefillGenSlot(template) {
    return /\[\[\s*pg\s*\]\]/i.test(String(template ?? ''));
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

function extractTextCarrierItem(items) {
    if (!Array.isArray(items)) return null;
    for (const item of items) {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string' || typeof item.input_text === 'string') {
            return item;
        }
    }
    return null;
}

function replaceMessageContent(content, nextText) {
    if (!Array.isArray(content)) {
        return String(nextText ?? '');
    }

    const carrier = extractTextCarrierItem(content);
    if (typeof carrier === 'string') {
        return [String(nextText ?? '')];
    }
    if (carrier && typeof carrier === 'object') {
        if (typeof carrier.input_text === 'string') {
            return [{ ...carrier, input_text: String(nextText ?? '') }];
        }
        if (typeof carrier.text === 'string') {
            return [{ ...carrier, text: String(nextText ?? '') }];
        }
    }

    return [{ type: 'text', text: String(nextText ?? '') }];
}

function replaceGeminiParts(parts, nextText) {
    if (!Array.isArray(parts)) {
        return [{ text: String(nextText ?? '') }];
    }

    const carrier = extractTextCarrierItem(parts);
    if (carrier && typeof carrier === 'object' && typeof carrier.text === 'string') {
        return [{ ...carrier, text: String(nextText ?? '') }];
    }

    return [{ text: String(nextText ?? '') }];
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

function findTrailingAssistantMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (!message || typeof message !== 'object') continue;
        if (message.role !== 'assistant') continue;
        const prefill = extractPlainTextFromContent(message.content);
        if (!prefill) continue;
        return { index, prefill };
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
        return { index, prefill };
    }
    return null;
}

function findTrailingGeminiModelContent(contents) {
    if (!Array.isArray(contents) || contents.length === 0) return null;
    for (let index = contents.length - 1; index >= 0; index--) {
        const item = contents[index];
        if (!item || typeof item !== 'object') continue;
        if (String(item.role ?? '').toLowerCase() !== 'model') continue;
        const prefill = extractPlainTextFromContent(item.parts);
        if (!prefill) continue;
        return { index, prefill };
    }
    return null;
}

function findPrefillGeneratorTarget(targetUrl, jsonBody) {
    const provider = detectProvider(targetUrl, jsonBody);
    if (!provider) return null;

    switch (provider) {
        case 'openai-chat': {
            const trailing = findTrailingAssistantMessage(jsonBody?.messages);
            return trailing ? { provider, index: trailing.index, prefill: trailing.prefill } : null;
        }
        case 'openai-responses': {
            const trailing = findTrailingAssistantResponsesInput(jsonBody?.input);
            return trailing ? { provider, index: trailing.index, prefill: trailing.prefill } : null;
        }
        case 'anthropic-messages': {
            const trailing = findTrailingAssistantMessage(jsonBody?.messages);
            return trailing ? { provider, index: trailing.index, prefill: trailing.prefill } : null;
        }
        case 'gemini-generate-content': {
            const trailing = findTrailingGeminiModelContent(jsonBody?.contents);
            return trailing ? { provider, index: trailing.index, prefill: trailing.prefill } : null;
        }
        default:
            return null;
    }
}

function replacePrefillInRequest(jsonBody, target, nextPrefill) {
    const rewritten = cloneJson(jsonBody);
    const replacement = String(nextPrefill ?? '');

    switch (target.provider) {
        case 'openai-chat':
        case 'anthropic-messages':
            rewritten.messages[target.index].content = replaceMessageContent(rewritten.messages[target.index].content, replacement);
            return rewritten;
        case 'openai-responses':
            rewritten.input[target.index].content = replaceMessageContent(rewritten.input[target.index].content, replacement);
            return rewritten;
        case 'gemini-generate-content':
            rewritten.contents[target.index].parts = replaceGeminiParts(rewritten.contents[target.index].parts, replacement);
            return rewritten;
        default:
            return rewritten;
    }
}

function normalizeStopStrings(stopStrings) {
    const merged = [];
    const seen = new Set();
    for (const item of Array.isArray(stopStrings) ? stopStrings : []) {
        const value = String(item ?? '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        merged.push(value);
    }
    return merged;
}

function appendMatchedStopString(text, stopString) {
    const generatedText = String(text ?? '');
    const matchedStopString = String(stopString ?? '');
    if (!matchedStopString || generatedText.endsWith(matchedStopString)) return generatedText;
    return `${generatedText}${matchedStopString}`;
}

function normalizeExtraPromptRole(raw) {
    const role = String(raw ?? 'system').trim().toLowerCase();
    if (role === 'user' || role === 'assistant') return role;
    return 'system';
}

function convertFinalMessageRole(messages, fromRole, toRole) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || typeof last !== 'object') return;
    if (String(last.role ?? '') !== String(fromRole ?? '')) return;
    last.role = toRole;
}

function convertFinalGeminiRole(contents, fromRole, toRole) {
    if (!Array.isArray(contents) || contents.length === 0) return;
    const last = contents[contents.length - 1];
    if (!last || typeof last !== 'object') return;
    if (String(last.role ?? '').toLowerCase() !== String(fromRole ?? '').toLowerCase()) return;
    last.role = toRole;
}

function insertExtraPromptMessages(messages, prompt, role) {
    const content = String(prompt ?? '');
    const normalizedRole = normalizeExtraPromptRole(role);
    const nextMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
    if (!content.trim()) return nextMessages;

    if (normalizedRole === 'system') {
        let insertAt = 0;
        while (insertAt < nextMessages.length && nextMessages[insertAt]?.role === 'system') {
            insertAt++;
        }
        nextMessages.splice(insertAt, 0, { role: 'system', content });
        return nextMessages;
    }

    nextMessages.push({ role: normalizedRole, content });
    return nextMessages;
}

function mergeAnthropicSystemPrompt(existing, prompt) {
    const content = String(prompt ?? '');
    if (!content.trim()) return existing;

    if (typeof existing === 'string' && existing.trim()) {
        return `${existing}\n${content}`;
    }
    if (Array.isArray(existing)) {
        return [...existing, { type: 'text', text: content }];
    }
    if (existing && typeof existing === 'object' && typeof existing.text === 'string') {
        return [{ ...existing }, { type: 'text', text: content }];
    }
    return content;
}

function appendGeminiSystemInstruction(existing, prompt) {
    const content = String(prompt ?? '');
    if (!content.trim()) return existing;

    if (existing && typeof existing === 'object' && Array.isArray(existing.parts)) {
        return {
            ...existing,
            parts: [...existing.parts, { text: content }],
        };
    }

    return {
        parts: [{ text: content }],
    };
}

function shouldConvertFinalAssistantForTarget(targetUrl) {
    const hostname = String(targetUrl?.hostname ?? '').toLowerCase();
    return hostname.endsWith('openrouter.ai') || hostname.endsWith('anthropic.com');
}

function clearEmptyObjectField(object, key) {
    const value = object?.[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (Object.keys(value).length === 0) {
        delete object[key];
    }
}

function normalizeGenericRole(rawRole) {
    const role = String(rawRole ?? '').trim().toLowerCase();
    if (role === 'assistant' || role === 'model') return 'assistant';
    if (role === 'system') return 'system';
    return 'user';
}

function pushGenericMessage(messages, role, content) {
    const text = normalizeNewlines(extractPlainTextFromContent(content));
    if (!text.trim()) return;
    messages.push({
        role: normalizeGenericRole(role),
        content: text,
    });
}

function extractAnthropicSystemMessages(systemPrompt) {
    const out = [];
    if (typeof systemPrompt === 'string') {
        pushGenericMessage(out, 'system', systemPrompt);
        return out;
    }
    if (Array.isArray(systemPrompt)) {
        for (const block of systemPrompt) {
            if (typeof block === 'string') {
                pushGenericMessage(out, 'system', block);
                continue;
            }
            if (block && typeof block === 'object' && typeof block.text === 'string') {
                pushGenericMessage(out, 'system', block.text);
            }
        }
        return out;
    }
    if (systemPrompt && typeof systemPrompt === 'object' && typeof systemPrompt.text === 'string') {
        pushGenericMessage(out, 'system', systemPrompt.text);
    }
    return out;
}

function extractConversationFromRequest(targetUrl, jsonBody, target) {
    const messages = [];

    switch (target.provider) {
        case 'openai-chat':
        case 'anthropic-messages':
            if (target.provider === 'anthropic-messages') {
                for (const systemMessage of extractAnthropicSystemMessages(jsonBody?.system)) {
                    messages.push(systemMessage);
                }
            }
            for (let index = 0; index < (Array.isArray(jsonBody?.messages) ? jsonBody.messages.length : 0); index++) {
                if (index === target.index) continue;
                const message = jsonBody.messages[index];
                if (!message || typeof message !== 'object') continue;
                pushGenericMessage(messages, message.role, message.content);
            }
            break;
        case 'openai-responses':
            for (let index = 0; index < (Array.isArray(jsonBody?.input) ? jsonBody.input.length : 0); index++) {
                if (index === target.index) continue;
                const item = jsonBody.input[index];
                if (!item || typeof item !== 'object') continue;
                pushGenericMessage(messages, item.role, item.content);
            }
            break;
        case 'gemini-generate-content': {
            const systemText = extractPlainTextFromContent(jsonBody?.systemInstruction?.parts);
            if (systemText.trim()) {
                pushGenericMessage(messages, 'system', systemText);
            }
            for (let index = 0; index < (Array.isArray(jsonBody?.contents) ? jsonBody.contents.length : 0); index++) {
                if (index === target.index) continue;
                const item = jsonBody.contents[index];
                if (!item || typeof item !== 'object') continue;
                const role = String(item.role ?? '').toLowerCase() === 'model' ? 'assistant' : item.role;
                pushGenericMessage(messages, role, item.parts);
            }
            break;
        }
        default:
            break;
    }

    if (!messages.length) {
        throw new Error('Prefill generator: no messages to generate from');
    }

    return messages;
}

function extractModelFromRequest(targetUrl, jsonBody) {
    const directModel = String(jsonBody?.model ?? '').trim();
    if (directModel) return directModel;

    const match = /\/models\/([^/:?]+)(?::[^/?]+)?/i.exec(String(targetUrl?.pathname ?? ''));
    return match ? String(match[1] ?? '').trim() : '';
}

function detectProviderFromTargetUrl(targetUrl, fallbackProvider = '') {
    const pathname = String(targetUrl?.pathname ?? '').toLowerCase();
    if (pathname.includes('generatecontent')) return 'gemini-generate-content';
    if (pathname.endsWith('/messages')) return 'anthropic-messages';
    if (pathname.includes('/responses')) return 'openai-responses';
    if (pathname.includes('/chat/completions')) return 'openai-chat';
    return fallbackProvider || 'openai-chat';
}

function resolveGeneratorTargetUrl(currentTargetUrl, sourceProvider, config) {
    const explicitTarget = String(config?.targetUrl ?? '').trim();
    if (explicitTarget) {
        return new URL(explicitTarget);
    }
    if (String(config?.provider ?? 'auto') !== 'auto' && String(config?.provider ?? '') !== String(sourceProvider ?? '')) {
        throw new Error('Prefill generator: target_url is required when provider differs from the source request');
    }
    return new URL(currentTargetUrl.toString());
}

function resolveGeneratorProvider(targetUrl, sourceProvider, config) {
    const explicitProvider = String(config?.provider ?? 'auto').trim().toLowerCase();
    if (explicitProvider && explicitProvider !== 'auto') return explicitProvider;
    return detectProviderFromTargetUrl(targetUrl, sourceProvider);
}

function resolveGeneratorModel(configModel, sourceModel) {
    const explicitModel = String(configModel ?? '').trim();
    if (explicitModel) return explicitModel;
    return String(sourceModel ?? '').trim();
}

function splitSystemMessages(messages) {
    const systemMessages = [];
    const chatMessages = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        if (!message || typeof message !== 'object') continue;
        if (message.role === 'system') {
            systemMessages.push(String(message.content ?? ''));
            continue;
        }
        chatMessages.push({
            role: message.role,
            content: String(message.content ?? ''),
        });
    }

    return { systemMessages, chatMessages };
}

function buildOpenAiChatGeneratorRequest({ targetUrl, conversation, sourceModel, config }) {
    const messages = insertExtraPromptMessages(conversation, config.extraPrompt, config.extraPromptRole);
    convertFinalMessageRole(messages, 'assistant', 'user');
    if (shouldConvertFinalAssistantForTarget(targetUrl)) {
        convertFinalMessageRole(messages, 'assistant', 'user');
    }

    const model = resolveGeneratorModel(config.model, sourceModel);
    if (!model) {
        throw new Error('Prefill generator: model is required for the selected generator target');
    }

    const stopStrings = normalizeStopStrings(config.stopStrings);
    const jsonBody = {
        model,
        messages,
        stream: false,
        max_tokens: config.maxTokens,
    };

    if (stopStrings.length > 0) {
        jsonBody.stop = stopStrings;
    }

    return {
        provider: 'openai-chat',
        targetUrl: new URL(targetUrl.toString()),
        jsonBody,
        stopStrings,
    };
}

function buildOpenAiResponsesGeneratorRequest({ targetUrl, conversation, sourceModel, config }) {
    const input = insertExtraPromptMessages(conversation, config.extraPrompt, config.extraPromptRole);
    convertFinalMessageRole(input, 'assistant', 'user');
    if (shouldConvertFinalAssistantForTarget(targetUrl)) {
        convertFinalMessageRole(input, 'assistant', 'user');
    }

    const model = resolveGeneratorModel(config.model, sourceModel);
    if (!model) {
        throw new Error('Prefill generator: model is required for the selected generator target');
    }

    return {
        provider: 'openai-responses',
        targetUrl: new URL(targetUrl.toString()),
        jsonBody: {
            model,
            input,
            max_output_tokens: config.maxTokens,
        },
        stopStrings: [],
    };
}

function buildAnthropicGeneratorRequest({ targetUrl, conversation, sourceModel, config }) {
    const { systemMessages, chatMessages } = splitSystemMessages(conversation);
    const messages = chatMessages.map((message) => ({ ...message }));

    if (config.extraPrompt.trim()) {
        if (normalizeExtraPromptRole(config.extraPromptRole) === 'system') {
            systemMessages.push(config.extraPrompt);
        } else {
            messages.push({
                role: normalizeExtraPromptRole(config.extraPromptRole),
                content: config.extraPrompt,
            });
        }
    }

    convertFinalMessageRole(messages, 'assistant', 'user');
    const model = resolveGeneratorModel(config.model, sourceModel);
    if (!model) {
        throw new Error('Prefill generator: model is required for the selected generator target');
    }

    const stopStrings = normalizeStopStrings(config.stopStrings);
    const jsonBody = {
        model,
        messages,
        stream: false,
        max_tokens: config.maxTokens,
    };

    if (systemMessages.length > 0) {
        jsonBody.system = systemMessages.join('\n');
    }
    if (stopStrings.length > 0) {
        jsonBody.stop_sequences = stopStrings;
    }

    return {
        provider: 'anthropic-messages',
        targetUrl: new URL(targetUrl.toString()),
        jsonBody,
        stopStrings,
    };
}

function setGeminiModelInUrl(targetUrl, model) {
    const rewrittenUrl = new URL(targetUrl.toString());
    rewrittenUrl.pathname = rewrittenUrl.pathname.replace(/streamGenerateContent/i, 'generateContent');
    if (rewrittenUrl.searchParams.get('alt') === 'sse') {
        rewrittenUrl.searchParams.delete('alt');
    }
    if (model) {
        rewrittenUrl.pathname = rewrittenUrl.pathname.replace(/(\/models\/)([^/:]+)(:.*)$/i, `$1${model}$3`);
    }
    return rewrittenUrl;
}

function buildGeminiGeneratorRequest({ targetUrl, conversation, sourceModel, config }) {
    const { systemMessages, chatMessages } = splitSystemMessages(conversation);
    const contents = chatMessages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
    }));

    if (config.extraPrompt.trim()) {
        if (normalizeExtraPromptRole(config.extraPromptRole) === 'system') {
            systemMessages.push(config.extraPrompt);
        } else {
            contents.push({
                role: normalizeExtraPromptRole(config.extraPromptRole) === 'assistant' ? 'model' : 'user',
                parts: [{ text: config.extraPrompt }],
            });
        }
    }

    convertFinalGeminiRole(contents, 'model', 'user');
    const model = resolveGeneratorModel(config.model, sourceModel);
    const stopStrings = normalizeStopStrings(config.stopStrings);
    const rewrittenUrl = setGeminiModelInUrl(targetUrl, model);

    return {
        provider: 'gemini-generate-content',
        targetUrl: rewrittenUrl,
        jsonBody: {
            ...(systemMessages.length > 0 ? {
                systemInstruction: {
                    parts: [{ text: systemMessages.join('\n') }],
                },
            } : {}),
            contents,
            generationConfig: {
                maxOutputTokens: config.maxTokens,
                ...(stopStrings.length > 0 ? { stopSequences: stopStrings } : {}),
            },
        },
        stopStrings,
    };
}

function buildPrefillGeneratorRequest({ targetUrl, jsonBody, target, config }) {
    const conversation = extractConversationFromRequest(targetUrl, jsonBody, target);
    const sourceModel = extractModelFromRequest(targetUrl, jsonBody);
    const generatorTargetUrl = resolveGeneratorTargetUrl(targetUrl, target.provider, config);
    const generatorProvider = resolveGeneratorProvider(generatorTargetUrl, target.provider, config);

    switch (generatorProvider) {
        case 'openai-chat':
            return buildOpenAiChatGeneratorRequest({
                targetUrl: generatorTargetUrl,
                conversation,
                sourceModel,
                config,
            });
        case 'openai-responses':
            return buildOpenAiResponsesGeneratorRequest({
                targetUrl: generatorTargetUrl,
                conversation,
                sourceModel,
                config,
            });
        case 'anthropic-messages':
            return buildAnthropicGeneratorRequest({
                targetUrl: generatorTargetUrl,
                conversation,
                sourceModel,
                config,
            });
        case 'gemini-generate-content':
            return buildGeminiGeneratorRequest({
                targetUrl: generatorTargetUrl,
                conversation,
                sourceModel,
                config,
            });
        default:
            throw new Error(`Prefill generator: unsupported provider "${generatorProvider}"`);
    }
}

function extractOpenAiCompletionText(data) {
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    return extractPlainTextFromContent(content);
}

function extractOpenAiResponsesText(data) {
    if (typeof data?.output_text === 'string') return data.output_text;
    let out = '';
    for (const item of Array.isArray(data?.output) ? data.output : []) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') {
            out += item.text;
            continue;
        }
        for (const block of Array.isArray(item.content) ? item.content : []) {
            if (typeof block?.text === 'string') {
                out += block.text;
                continue;
            }
            if (typeof block?.output_text === 'string') {
                out += block.output_text;
                continue;
            }
            if (typeof block?.input_text === 'string') {
                out += block.input_text;
            }
        }
    }
    return out;
}

function extractAnthropicText(data) {
    return extractPlainTextFromContent(data?.content);
}

function extractGeminiText(data) {
    return extractPlainTextFromContent(data?.candidates?.[0]?.content?.parts);
}

function extractGeneratedTextFromResponse(provider, data) {
    switch (provider) {
        case 'openai-chat':
            return extractOpenAiCompletionText(data);
        case 'openai-responses':
            return extractOpenAiResponsesText(data);
        case 'anthropic-messages':
            return extractAnthropicText(data);
        case 'gemini-generate-content':
            return extractGeminiText(data);
        default:
            return '';
    }
}

function collectStopReasons(provider, data) {
    switch (provider) {
        case 'openai-chat':
            return [data?.choices?.[0]?.finish_reason];
        case 'openai-responses':
            return [
                data?.status,
                data?.output?.[0]?.status,
            ];
        case 'anthropic-messages':
            return [data?.stop_reason];
        case 'gemini-generate-content':
            return [data?.candidates?.[0]?.finishReason];
        default:
            return [];
    }
}

function collectExplicitMatchedStops(provider, data) {
    switch (provider) {
        case 'openai-chat':
            return [
                data?.choices?.[0]?.stop_sequence,
                data?.choices?.[0]?.message?.stop_sequence,
                data?.choices?.[0]?.delta?.stop_sequence,
                data?.choices?.[0]?.matched_stop,
                data?.choices?.[0]?.message?.matched_stop,
                data?.stop_sequence,
                data?.matched_stop,
            ];
        case 'anthropic-messages':
            return [data?.stop_sequence];
        default:
            return [];
    }
}

function detectMatchedStopString(provider, data, stopStrings) {
    const normalizedStops = normalizeStopStrings(stopStrings);
    if (!normalizedStops.length) return '';

    for (const value of collectExplicitMatchedStops(provider, data)) {
        if (typeof value === 'string' && normalizedStops.includes(value)) {
            return value;
        }
    }

    const stopReasons = collectStopReasons(provider, data)
        .map((reason) => String(reason ?? '').trim())
        .filter(Boolean);
    if (!stopReasons.length) return '';

    const stopLikeReasons = new Set(['stop', 'stop_sequence', 'end_turn', 'end', 'eos', 'completed', 'complete', 'STOP']);
    const nonStopReasons = new Set(['length', 'max_tokens', 'max_output_tokens', 'tool_use', 'tool_calls', 'content_filter', 'ERROR', 'SAFETY', 'RECITATION']);

    if (stopReasons.some((reason) => nonStopReasons.has(reason))) {
        return '';
    }

    return stopReasons.some((reason) => stopLikeReasons.has(reason)) ? normalizedStops[0] : '';
}

function cloneHeaders(source) {
    const headers = new Headers();

    if (source && typeof source.forEach === 'function') {
        source.forEach((value, key) => headers.append(key, value));
    } else {
        for (const [key, value] of Object.entries(source ?? {})) {
            if (value == null) continue;
            if (Array.isArray(value)) {
                for (const entry of value) {
                    headers.append(key, String(entry));
                }
                continue;
            }
            headers.set(key, String(value));
        }
    }

    headers.delete('content-length');
    headers.set('content-type', 'application/json; charset=utf-8');
    return headers;
}

function parseHeaderLines(raw) {
    const headers = [];
    for (const line of String(raw ?? '').split(/\r?\n/g)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const splitIndex = trimmed.indexOf(':');
        if (splitIndex <= 0) {
            throw new Error(`Prefill generator: invalid extra header "${trimmed}"`);
        }
        const key = trimmed.slice(0, splitIndex).trim();
        const value = trimmed.slice(splitIndex + 1).trim();
        if (!key) {
            throw new Error(`Prefill generator: invalid extra header "${trimmed}"`);
        }
        headers.push([key, value]);
    }
    return headers;
}

function stripGeneratorAuthHeaders(headers) {
    for (const key of [
        'authorization',
        'x-api-key',
        'x-goog-api-key',
        'anthropic-version',
        'api-key',
        'openrouter-api-key',
        'proxy-authorization',
    ]) {
        headers.delete(key);
    }
}

function defaultApiKeyHeader(provider) {
    switch (provider) {
        case 'anthropic-messages':
            return 'x-api-key';
        case 'gemini-generate-content':
            return 'x-goog-api-key';
        default:
            return 'authorization';
    }
}

function defaultApiKeyPrefix(headerName) {
    return String(headerName ?? '').toLowerCase() === 'authorization' ? 'Bearer ' : '';
}

function buildGeneratorHeaders({
    upstreamHeaders,
    config,
    provider,
    sourceProvider,
}) {
    const headers = cloneHeaders(upstreamHeaders);
    const usingSeparateAuth = (
        String(config?.provider ?? 'auto') !== 'auto' &&
        String(config?.provider ?? '') !== String(sourceProvider ?? '')
    ) || Boolean(
        String(config?.apiKey ?? '').trim() ||
        String(config?.apiKeyHeader ?? '').trim() ||
        String(config?.extraHeaders ?? '').trim()
    );

    if (usingSeparateAuth) {
        stripGeneratorAuthHeaders(headers);
    }

    const apiKey = String(config?.apiKey ?? '').trim();
    if (apiKey) {
        const headerName = String(config?.apiKeyHeader ?? '').trim() || defaultApiKeyHeader(provider);
        const prefix = String(config?.apiKeyPrefix ?? '') !== ''
            ? String(config.apiKeyPrefix)
            : defaultApiKeyPrefix(headerName);
        headers.set(headerName, `${prefix}${apiKey}`);
    }

    for (const [key, value] of parseHeaderLines(config?.extraHeaders)) {
        headers.set(key, value);
    }

    if (provider === 'anthropic-messages' && !headers.has('anthropic-version')) {
        headers.set('anthropic-version', '2023-06-01');
    }

    return headers;
}

async function runPrefillGenerator({
    targetUrl,
    jsonBody,
    provider,
    upstreamHeaders,
    sourceProvider,
    config,
    stopStrings,
    fetchImpl,
}) {
    const controller = new AbortController();
    const timeoutMs = clampInt(config?.timeoutMs, 500, 120000, 120000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(targetUrl, {
            method: 'POST',
            headers: buildGeneratorHeaders({
                upstreamHeaders,
                config,
                provider,
                sourceProvider,
            }),
            body: JSON.stringify(jsonBody),
            redirect: 'manual',
            signal: controller.signal,
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Prefill generator: backend returned ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`);
        }

        const data = await response.json();
        const generatedText = extractGeneratedTextFromResponse(provider, data);
        if (!config?.keepMatchedStopString) {
            return generatedText;
        }

        const matchedStopString = detectMatchedStopString(provider, data, stopStrings);
        return appendMatchedStopString(generatedText, matchedStopString);
    } catch (error) {
        if (error?.name === 'AbortError' && controller.signal.aborted) {
            throw new Error(`Prefill generator timed out after ${timeoutMs} ms.`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function applyPrefillGeneratorToRequest({
    targetUrl,
    jsonBody,
    upstreamHeaders,
    config = {},
    fetchImpl = globalThis.fetch,
    skip = false,
}) {
    const target = findPrefillGeneratorTarget(targetUrl, jsonBody);
    const hasSlot = Boolean(target && templateHasPrefillGenSlot(target.prefill));
    const debug = {
        attempted: false,
        applied: false,
        skipped: Boolean(skip),
        reason: !target ? 'no_trailing_prefill' : (!hasSlot ? 'no_pg_slot' : (skip ? 'continue_skip' : '')),
        sourceProvider: target?.provider ?? '',
        sourceTargetUrl: String(targetUrl ?? ''),
        sourceModel: extractModelFromRequest(targetUrl, jsonBody),
        sourcePrefill: String(target?.prefill ?? ''),
        generatorProvider: '',
        generatorTargetUrl: '',
        generatorModel: '',
        requestBody: null,
        generatedText: '',
        error: '',
    };

    if (!target || !hasSlot || skip) {
        return {
            applied: false,
            jsonBody,
            provider: target?.provider ?? '',
            debug,
        };
    }

    let generatedText = '';
    let generatorProvider = target.provider;
    debug.attempted = true;
    if (config?.enabled) {
        try {
            const normalizedConfig = {
                provider: String(config?.provider ?? 'auto').trim().toLowerCase(),
                targetUrl: String(config?.targetUrl ?? '').trim(),
                apiKey: String(config?.apiKey ?? '').trim(),
                apiKeyHeader: String(config?.apiKeyHeader ?? '').trim(),
                apiKeyPrefix: String(config?.apiKeyPrefix ?? ''),
                extraHeaders: normalizeNewlines(String(config?.extraHeaders ?? '')),
                model: String(config?.model ?? '').trim(),
                maxTokens: clampInt(config?.maxTokens, 1, 1000000, 15),
                timeoutMs: clampInt(config?.timeoutMs, 500, 120000, 120000),
                stopStrings: Array.isArray(config?.stopStrings) ? config.stopStrings : [],
                keepMatchedStopString: Boolean(config?.keepMatchedStopString),
                extraPrompt: normalizeNewlines(String(config?.extraPrompt ?? '')),
                extraPromptRole: normalizeExtraPromptRole(config?.extraPromptRole),
            };
            const generatorRequest = buildPrefillGeneratorRequest({
                targetUrl,
                jsonBody,
                target,
                config: normalizedConfig,
            });
            generatorProvider = generatorRequest.provider;
            debug.generatorProvider = generatorRequest.provider;
            debug.generatorTargetUrl = generatorRequest.targetUrl.toString();
            debug.generatorModel = extractModelFromRequest(generatorRequest.targetUrl, generatorRequest.jsonBody);
            debug.requestBody = cloneJson(generatorRequest.jsonBody);

            generatedText = await runPrefillGenerator({
                targetUrl: generatorRequest.targetUrl,
                jsonBody: generatorRequest.jsonBody,
                provider: generatorRequest.provider,
                upstreamHeaders,
                sourceProvider: target.provider,
                config: normalizedConfig,
                stopStrings: generatorRequest.stopStrings,
                fetchImpl,
            });
            debug.reason = 'ok';
        } catch (error) {
            debug.reason = 'error';
            debug.error = String(error?.message ?? error);
            generatedText = '';
        }
    } else {
        debug.reason = 'disabled';
    }
    debug.generatedText = generatedText;

    const nextPrefill = String(target.prefill ?? '').replace(PREFILL_GEN_SLOT_REGEX, String(generatedText ?? ''));
    return {
        applied: true,
        jsonBody: replacePrefillInRequest(jsonBody, target, nextPrefill),
        provider: generatorProvider,
        generatedText,
        debug: {
            ...debug,
            applied: true,
        },
    };
}

module.exports = {
    applyPrefillGeneratorToRequest,
    templateHasPrefillGenSlot,
};
