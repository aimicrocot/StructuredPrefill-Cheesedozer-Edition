'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_PROXY_CONFIG,
    buildPatternResponseSchema,
    rewriteProxyJsonRequest,
    rewriteProxyJsonResponse,
    tryUnwrapStructuredOutput,
} = require('../structured-prefill-core');
const {
    applyPrefillGeneratorToRequest,
} = require('../prefill-generator');
const {
    buildOpenAiChatSseBody,
    extractJsonPayloadFromSseText,
    normalizeUpstreamError,
    startServer,
    transformOpenAiChatStreamChunk,
} = require('../server');
const {
    createLiveConfigStore,
    DEFAULT_CONFIG,
    parseSimpleYaml,
    refreshLiveConfigStore,
    resolveUpstreamTargetUrl,
} = require('../proxy-config');

async function getFreePort() {
    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function waitForListening(server) {
    if (server.listening) return;
    await new Promise((resolve) => server.once('listening', resolve));
}

test('pattern schema matches the prefix and continuation', () => {
    const schema = buildPatternResponseSchema('Hello there, ', {
        minCharsAfterPrefix: 3,
        newlineToken: '<NL>',
        patternMode: 'default',
        knownNames: [],
        mustEndAfterTemplate: false,
    });

    const pattern = new RegExp(schema.properties.response.pattern);
    assert.equal(pattern.test('Hello there, abc'), true);
    assert.equal(pattern.test('Nope'), false);
});

test('proxy defaults mirror the extension defaults that matter on the wire', () => {
    assert.equal(DEFAULT_PROXY_CONFIG.enabled, true);
    assert.equal(DEFAULT_PROXY_CONFIG.minCharsAfterPrefix, 80);
    assert.equal(DEFAULT_PROXY_CONFIG.newlineToken, '\\n');
    assert.equal(DEFAULT_PROXY_CONFIG.hidePrefillInDisplay, true);
    assert.equal(DEFAULT_PROXY_CONFIG.antiSlopBanList, '');
    assert.equal(DEFAULT_PROXY_CONFIG.continueOverlapChars, 14);

    assert.equal(DEFAULT_CONFIG.structured_prefill.hide_prefill_in_display, true);
    assert.equal(DEFAULT_CONFIG.structured_prefill.prefill_generator.enabled, false);
});

test('anti-slop bans configured words from the continuation pattern', () => {
    const schema = buildPatternResponseSchema('Hello ', {
        minCharsAfterPrefix: 1,
        newlineToken: '<NL>',
        patternMode: 'default',
        knownNames: [],
        antiSlopBanList: 'gaze\nsmirk',
        mustEndAfterTemplate: false,
    });

    const pattern = new RegExp(schema.properties.response.pattern);
    assert.equal(pattern.test('Hello waves'), true);
    assert.equal(pattern.test('Hello gaze'), false);
    assert.equal(pattern.test('Hello smirked'), false);
});

test('openai chat requests are rewritten into response_format json_schema', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'She leaned in and said, "' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 12,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.context.provider, 'openai-chat');
    assert.equal(rewritten.jsonBody.stream, true);
    assert.equal(rewritten.jsonBody.messages.length, 1);
    assert.equal(rewritten.jsonBody.response_format.type, 'json_schema');
    assert.equal(rewritten.jsonBody.response_format.json_schema.name, 'response');
});

test('gpt-5.4 chat requests normalize max_tokens into max_completion_tokens', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-5.4',
        max_tokens: 64,
        frequency_penalty: 0.5,
        stop: ['END'],
        messages: [
            { role: 'user', content: 'Answer.' },
            { role: 'assistant', content: 'The answer is: ' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.jsonBody.max_completion_tokens, 64);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'max_tokens'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'frequency_penalty'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'stop'), false);
});

test('gpt-5-mini chat requests strip legacy sampling fields', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-5-mini',
        max_tokens: 64,
        temperature: 0.8,
        top_p: 0.9,
        presence_penalty: 0.3,
        messages: [
            { role: 'user', content: 'Answer.' },
            { role: 'assistant', content: 'The answer is: ' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.jsonBody.max_completion_tokens, 64);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'max_tokens'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'temperature'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'top_p'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody, 'presence_penalty'), false);
});

test('openrouter chat requests require providers to support structured-output parameters', () => {
    const targetUrl = new URL('https://openrouter.ai/api/v1/chat/completions');
    const body = {
        model: 'anthropic/claude-sonnet-4.5',
        messages: [
            { role: 'user', content: 'Answer.' },
            { role: 'assistant', content: 'The answer is: ' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.jsonBody.provider.require_parameters, true);
});

test('continue schemas only require one more character after the overlap, like the extension', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Hello wor' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 80,
            newlineToken: '\\n',
            hidePrefillInDisplay: true,
            continueMode: 'force',
            continueOverlapChars: 3,
        },
    });

    assert.ok(rewritten);
    const pattern = new RegExp(rewritten.context.responseSchema.properties.response.pattern);
    assert.equal(pattern.test('world'), true);
    assert.equal(pattern.test('worl'), false);
});

test('continue force mode keeps the assistant turn and joins overlap-stripped output', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Hello wor' },
        ],
    };

    const rewrittenRequest = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
            continueMode: 'force',
            continueOverlapChars: 3,
        },
    });

    assert.ok(rewrittenRequest);
    assert.equal(rewrittenRequest.context.continue.active, true);
    assert.equal(rewrittenRequest.jsonBody.messages.length, 2);

    const rewrittenResponse = rewriteProxyJsonResponse({
        context: rewrittenRequest.context,
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"world"}',
                    },
                },
            ],
        },
    });

    assert.equal(rewrittenResponse.choices[0].message.content, 'Hello world');
});

test('continue auto mode activates from a trailing continue instruction', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Start.' },
            { role: 'assistant', content: 'The rain drummed against the window' },
            { role: 'user', content: 'Continue from here without repeating yourself.' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
            continueMode: 'auto',
            continueOverlapChars: 10,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.context.continue.active, true);
    assert.equal(rewritten.jsonBody.messages.length, 3);
});

test('anthropic openai-compatible chat completions stay on the openai rewrite path', () => {
    const targetUrl = new URL('https://api.anthropic.com/v1/chat/completions');
    const body = {
        model: 'claude-sonnet-4-5',
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'She said, "' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 12,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.context.provider, 'openai-chat');
    assert.equal(rewritten.jsonBody.response_format.type, 'json_schema');
    assert.equal(rewritten.jsonBody.response_format.json_schema.name, 'response');
});

test('openai chat responses are unwrapped back to plain text', () => {
    const rewritten = rewriteProxyJsonResponse({
        context: {
            provider: 'openai-chat',
            schemaMode: 'pattern',
            newlineToken: '<NL>',
        },
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"Hello there<NL>General Kenobi"}',
                    },
                },
            ],
        },
    });

    assert.equal(rewritten.choices[0].message.content, 'Hello there\nGeneral Kenobi');
});

test('openai chat streaming shim returns SSE chunks and DONE', () => {
    const body = buildOpenAiChatSseBody({
        id: 'chatcmpl-test',
        created: 123,
        model: 'gpt-test',
        choices: [
            {
                index: 0,
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content: 'Hello there',
                },
            },
        ],
    });

    assert.match(body, /^data: /);
    assert.match(body, /"object":"chat\.completion\.chunk"/);
    assert.match(body, /"content":"Hello there"/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /\[DONE\]\n\n$/);
});

test('openai chat stream chunks are incrementally unwrapped into visible deltas', () => {
    const context = {
        provider: 'openai-chat',
        schemaMode: 'pattern',
        newlineToken: '\\n',
        hidePrefillInDisplay: false,
    };
    const streamState = {
        rawByChoice: new Map(),
        visibleByChoice: new Map(),
    };

    const first = transformOpenAiChatStreamChunk({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [
            {
                index: 0,
                delta: {
                    role: 'assistant',
                    content: '{"response":"Hel',
                },
                finish_reason: null,
            },
        ],
    }, context, streamState);

    const second = transformOpenAiChatStreamChunk({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [
            {
                index: 0,
                delta: {
                    content: 'lo"}',
                },
                finish_reason: null,
            },
        ],
    }, context, streamState);

    assert.equal(first.choices[0].delta.content, 'Hel');
    assert.equal(second.choices[0].delta.content, 'lo');
});

test('sse error payloads are extracted for visible passthrough', () => {
    const extracted = extractJsonPayloadFromSseText([
        'event: message',
        'data: {"error":{"message":"No endpoints found.","code":404}}',
        '',
        'data: [DONE]',
        '',
    ].join('\n'));

    assert.deepEqual(extracted, {
        error: {
            message: 'No endpoints found.',
            code: 404,
        },
    });
});

test('plain-text upstream errors are normalized into visible JSON errors', () => {
    const normalized = normalizeUpstreamError({
        status: 403,
        statusText: 'Forbidden',
    }, 'blocked by upstream relay', 'text/plain');

    assert.equal(normalized.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(normalized.bodyText), {
        error: {
            message: 'blocked by upstream relay',
            status: 403,
            status_text: 'Forbidden',
        },
    });
});

test('streaming structured-prefill requests pass upstream JSON errors through to the client', async (t) => {
    const upstream = http.createServer((req, res) => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: {
                message: 'No endpoints found for anthropic/claude-opus-4.6.',
                code: 404,
            },
            user_id: 'user_test',
        }));
    });
    await new Promise((resolve, reject) => {
        upstream.once('error', reject);
        upstream.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => upstream.close());
    const upstreamAddress = upstream.address();
    const upstreamPort = upstreamAddress && typeof upstreamAddress === 'object' ? upstreamAddress.port : 0;

    const proxyPort = await getFreePort();
    const proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-prefill-proxy-error-'));
    fs.writeFileSync(path.join(proxyDir, 'config.yaml'), [
        'server:',
        '  host: 127.0.0.1',
        `  port: ${proxyPort}`,
        'routing:',
        `  openai_base_url: "http://127.0.0.1:${upstreamPort}/"`,
        `  openrouter_base_url: "http://127.0.0.1:${upstreamPort}/"`,
        `  openai_compatible_base_url: "http://127.0.0.1:${upstreamPort}/"`,
        `  anthropic_base_url: "http://127.0.0.1:${upstreamPort}/"`,
        `  google_base_url: "http://127.0.0.1:${upstreamPort}/"`,
        'structured_prefill:',
        '  enabled: true',
        "  newline_token: '\\n'",
        '  hide_prefill_in_display: true',
    ].join('\n'), 'utf8');

    const proxy = startServer({
        proxyDir,
        logger: {
            log() {},
            warn() {},
        },
    });
    t.after(() => proxy.close());
    await waitForListening(proxy);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'anthropic/claude-opus-4.6',
            stream: true,
            messages: [
                { role: 'user', content: 'Continue.' },
                { role: 'assistant', content: 'Aerilatha: "' },
            ],
        }),
    });

    assert.equal(response.status, 404);
    assert.match(String(response.headers.get('content-type') ?? ''), /application\/json/i);
    const payload = await response.json();
    assert.deepEqual(payload, {
        error: {
            message: 'No endpoints found for anthropic/claude-opus-4.6.',
            code: 404,
        },
        user_id: 'user_test',
    });
});

test('root config editor serves html and saves config changes', async (t) => {
    const proxyPort = await getFreePort();
    const proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-prefill-proxy-ui-'));
    fs.writeFileSync(path.join(proxyDir, 'config.yaml'), [
        'server:',
        '  host: 127.0.0.1',
        `  port: ${proxyPort}`,
        'routing:',
        '  allow_full_url_targets: true',
        '  openai_base_url: "https://api.openai.com"',
        '  openrouter_base_url: "https://openrouter.ai/api"',
        '  openai_compatible_base_url: "https://api.openai.com"',
        '  anthropic_base_url: "https://api.anthropic.com"',
        '  google_base_url: "https://generativelanguage.googleapis.com"',
        'structured_prefill:',
        '  enabled: true',
        "  newline_token: '\\n'",
        '  hide_prefill_in_display: true',
        '  anti_slop_ban_list: ""',
        '  continue:',
        '    mode: "off"',
        '    overlap_chars: 14',
        '  prefill_generator:',
        '    enabled: false',
        '    provider: "auto"',
        '    target_url: ""',
        '    api_key: ""',
        '    api_key_header: ""',
        '    api_key_prefix: ""',
        '    extra_headers: ""',
        '    model: ""',
        '    max_tokens: 15',
        '    timeout_ms: 120000',
        '    stop: ""',
        '    keep_matched_stop_string: false',
        '    extra_prompt: ""',
        '    extra_prompt_role: "system"',
    ].join('\n'), 'utf8');

    const proxy = startServer({
        proxyDir,
        logger: {
            log() {},
            warn() {},
        },
    });
    t.after(() => proxy.close());
    await waitForListening(proxy);

    const page = await fetch(`http://127.0.0.1:${proxyPort}/`);
    assert.equal(page.status, 200);
    assert.match(String(page.headers.get('content-type') ?? ''), /text\/html/i);
    const html = await page.text();
    assert.match(html, /StructuredPrefill Proxy/);
    assert.match(html, /Full generator endpoint URL/);

    const save = await fetch(`http://127.0.0.1:${proxyPort}/__config`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            server: { host: '127.0.0.1', port: proxyPort },
            routing: {
                allow_full_url_targets: true,
                openai_base_url: 'https://api.openai.com',
                openrouter_base_url: 'https://example.com/router',
                openai_compatible_base_url: 'https://example.com/router',
                anthropic_base_url: 'https://api.anthropic.com',
                google_base_url: 'https://generativelanguage.googleapis.com',
            },
            structured_prefill: {
                enabled: true,
                min_chars_after_prefix: 64,
                newline_token: '\\n',
                hide_prefill_in_display: false,
                anti_slop_ban_list: 'gaze\nsmirk',
                continue: {
                    mode: 'auto',
                    overlap_chars: 11,
                },
                prefill_generator: {
                    enabled: true,
                    provider: 'anthropic-messages',
                    target_url: 'https://api.anthropic.com/v1/messages',
                    api_key: 'secret',
                    api_key_header: '',
                    api_key_prefix: '',
                    extra_headers: 'x-test: yep',
                    model: 'claude-sonnet-4-5',
                    max_tokens: 21,
                    timeout_ms: 9000,
                    stop: 'END',
                    keep_matched_stop_string: true,
                    extra_prompt: 'Be terse.',
                    extra_prompt_role: 'system',
                },
            },
        }),
    });

    assert.equal(save.status, 200);
    const saveResult = await save.json();
    assert.equal(saveResult.ok, true);
    assert.match(saveResult.yaml, /openrouter_base_url: "https:\/\/example\.com\/router"/);
    assert.match(saveResult.yaml, /provider: "anthropic-messages"/);
    assert.match(saveResult.yaml, /target_url: "https:\/\/api\.anthropic\.com\/v1\/messages"/);

    const rawConfig = await (await fetch(`http://127.0.0.1:${proxyPort}/config.yaml`)).text();
    assert.match(rawConfig, /extra_headers: "x-test: yep"/);
    assert.match(rawConfig, /anti_slop_ban_list: \|-/);
});

test('anthropic requests are rewritten into a forced tool call', () => {
    const targetUrl = new URL('https://api.anthropic.com/v1/messages');
    const body = {
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'I should not have said "' },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 10,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.context.provider, 'anthropic-messages');
    assert.equal(rewritten.jsonBody.stream, false);
    assert.equal(rewritten.jsonBody.tools[0].name, 'response');
    assert.equal(rewritten.jsonBody.tools[0].description, 'Well-formed JSON object');
    assert.deepEqual(rewritten.jsonBody.tool_choice, { type: 'tool', name: 'response' });
});

test('anthropic tool responses are unwrapped back into text blocks', () => {
    const rewritten = rewriteProxyJsonResponse({
        context: {
            provider: 'anthropic-messages',
            schemaMode: 'pattern',
            newlineToken: '<NL>',
        },
        jsonBody: {
            type: 'message',
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [
                {
                    type: 'tool_use',
                    name: 'response',
                    input: {
                        response: 'Hello<NL>world',
                    },
                },
            ],
        },
    });

    assert.equal(rewritten.stop_reason, 'end_turn');
    assert.deepEqual(rewritten.content, [{ type: 'text', text: 'Hello\nworld' }]);
});

test('gemini requests use flattened responseSchema and default thinkingConfig', () => {
    const targetUrl = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    const body = {
        contents: [
            { role: 'user', parts: [{ text: 'Continue.' }] },
            { role: 'model', parts: [{ text: 'The answer is: ' }] },
        ],
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 10,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.equal(rewritten.context.provider, 'gemini-generate-content');
    assert.equal(rewritten.context.schemaMode, 'pattern');
    assert.equal(rewritten.targetUrl.pathname.endsWith(':generateContent'), true);
    assert.equal(rewritten.jsonBody.generationConfig.candidateCount, 1);
    assert.equal(rewritten.jsonBody.generationConfig.responseMimeType, 'application/json');
    assert.equal(typeof rewritten.jsonBody.generationConfig.responseSchema.properties.response.pattern, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(rewritten.jsonBody.generationConfig.responseSchema, 'additionalProperties'), false);
    assert.deepEqual(rewritten.jsonBody.generationConfig.thinkingConfig, {
        includeThoughts: false,
        thinkingBudget: 0,
    });
    assert.deepEqual(rewritten.jsonBody.safetySettings, [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' },
    ]);
});

test('gemini requests preserve an explicit thinkingConfig', () => {
    const targetUrl = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    const body = {
        contents: [
            { role: 'user', parts: [{ text: 'Continue.' }] },
            { role: 'model', parts: [{ text: 'The answer is: ' }] },
        ],
        generationConfig: {
            maxOutputTokens: 128,
            thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 64,
            },
        },
    };

    const rewritten = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 10,
            newlineToken: '<NL>',
            hidePrefillInDisplay: false,
        },
    });

    assert.ok(rewritten);
    assert.deepEqual(rewritten.jsonBody.generationConfig.thinkingConfig, {
        includeThoughts: true,
        thinkingBudget: 64,
    });
});

test('gemini responses are unwrapped from prefix+response JSON', () => {
    const rewritten = rewriteProxyJsonResponse({
        context: {
            provider: 'gemini-generate-content',
            schemaMode: 'pattern',
            newlineToken: '',
        },
        jsonBody: {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: '{"response":"The answer is: forty two"}',
                            },
                        ],
                    },
                },
            ],
        },
    });

    assert.equal(rewritten.candidates[0].content.parts[0].text, 'The answer is: forty two');
});

test('tolerant unwrapping survives invalid JSON quotes', () => {
    const raw = '{"response":"She said "hello" and left"}';
    const unwrapped = tryUnwrapStructuredOutput(raw, {
        schemaMode: 'pattern',
        newlineToken: '<NL>',
    });

    assert.equal(unwrapped, 'She said "hello" and left');
});

test('hide_prefill_in_display strips the hidden prefix and keeps the visible tail', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Continue.' },
            { role: 'assistant', content: 'Narration: [[keep]]Visible: ' },
        ],
    };

    const rewrittenRequest = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 8,
            newlineToken: '<NL>',
            hidePrefillInDisplay: true,
        },
    });

    const rewrittenResponse = rewriteProxyJsonResponse({
        context: rewrittenRequest.context,
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"Narration: Visible: hello"}',
                    },
                },
            ],
        },
    });

    assert.equal(rewrittenResponse.choices[0].message.content, 'Visible: hello');
});

test('malformed trailing garbage after a quoted prefill is trimmed before display hiding', () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-5.4',
        messages: [
            { role: 'user', content: 'Write one line of dialogue from a spy thriller.' },
            { role: 'assistant', content: 'She leaned closer and whispered, "' },
        ],
        max_tokens: 96,
        reasoning_effort: 'none',
        stream: false,
    };

    const rewrittenRequest = rewriteProxyJsonRequest({
        targetUrl,
        jsonBody: body,
        baseConfig: {
            enabled: true,
            minCharsAfterPrefix: 80,
            newlineToken: '\\n',
            hidePrefillInDisplay: true,
            antiSlopBanList: '',
            continueMode: 'off',
            continueOverlapChars: 14,
        },
    });

    const rewrittenResponse = rewriteProxyJsonResponse({
        context: rewrittenRequest.context,
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"She leaned closer and whispered, “If Prague falls silent at midnight, burn the file and run.”}]} assistant to=final json {"}',
                    },
                },
            ],
        },
    });

    assert.equal(rewrittenResponse.choices[0].message.content, 'If Prague falls silent at midnight, burn the file and run."');
});

test('quoted prefills trim suffix garbage when stray words appear before assistant markers', () => {
    const rewritten = rewriteProxyJsonResponse({
        context: {
            provider: 'openai-chat',
            schemaMode: 'pattern',
            newlineToken: '\\n',
            prefillTemplate: 'She leaned closer and whispered, "',
            hidePrefillInDisplay: true,
            hideState: {
                literal: 'She leaned closer and whispered, "',
                regex: null,
            },
        },
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"She leaned closer and whispered, \\"If they ask, the package was never in Prague.\\"} stray assistant to=final json_object {"}',
                    },
                },
            ],
        },
    });

    assert.equal(rewritten.choices[0].message.content, 'If they ask, the package was never in Prague."');
});

test('quoted prefills trim suffix garbage when the leak starts with a closing brace and random prose', () => {
    const rewritten = rewriteProxyJsonResponse({
        context: {
            provider: 'openai-chat',
            schemaMode: 'pattern',
            newlineToken: '\\n',
            prefillTemplate: 'She leaned closer and whispered, "',
            hidePrefillInDisplay: true,
            hideState: {
                literal: 'She leaned closer and whispered, "',
                regex: null,
            },
        },
        jsonBody: {
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: '{"response":"She leaned closer and whispered, \\"Burn the passport and disappear.\\"} random policy prose that should never be shown."}',
                    },
                },
            ],
        },
    });

    assert.equal(rewritten.choices[0].message.content, 'Burn the passport and disappear."');
});

test('simple yaml config parser reads the proxy config shape', () => {
    const parsed = parseSimpleYaml(`
server:
  host: "127.0.0.1"
  port: 8382
routing:
  openai_compatible_base_url: "https://openrouter.ai/api"
structured_prefill:
  newline_token: '\\n'
  hide_prefill_in_display: true
  anti_slop_ban_list: |
    gaze
    smirk
  continue:
    mode: "force"
    overlap_chars: 18
  prefill_generator:
    enabled: true
    model: "gpt-4.1-mini"
    max_tokens: 21
    timeout_ms: 3000
    stop: |
      END
      STOP
    keep_matched_stop_string: true
    extra_prompt: "Seed it."
    extra_prompt_role: "user"
`);

    assert.equal(parsed.server.host, '127.0.0.1');
    assert.equal(parsed.server.port, 8382);
    assert.equal(parsed.routing.openai_compatible_base_url, 'https://openrouter.ai/api');
    assert.equal(parsed.structured_prefill.newline_token, '\\n');
    assert.equal(parsed.structured_prefill.hide_prefill_in_display, true);
    assert.equal(parsed.structured_prefill.anti_slop_ban_list, 'gaze\nsmirk\n');
    assert.equal(parsed.structured_prefill.continue.mode, 'force');
    assert.equal(parsed.structured_prefill.continue.overlap_chars, 18);
    assert.equal(parsed.structured_prefill.prefill_generator.enabled, true);
    assert.equal(parsed.structured_prefill.prefill_generator.model, 'gpt-4.1-mini');
    assert.equal(parsed.structured_prefill.prefill_generator.max_tokens, 21);
    assert.equal(parsed.structured_prefill.prefill_generator.timeout_ms, 3000);
    assert.equal(parsed.structured_prefill.prefill_generator.stop, 'END\nSTOP\n');
    assert.equal(parsed.structured_prefill.prefill_generator.keep_matched_stop_string, true);
    assert.equal(parsed.structured_prefill.prefill_generator.extra_prompt, 'Seed it.');
    assert.equal(parsed.structured_prefill.prefill_generator.extra_prompt_role, 'user');
});

test('live config store reloads config.yaml changes without restarting', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-prefill-proxy-'));
    const configPath = path.join(tempDir, 'config.yaml');

    fs.writeFileSync(configPath, `
server:
  host: "127.0.0.1"
  port: 8382
routing:
  openrouter_base_url: "https://openrouter.ai/api"
structured_prefill:
  enabled: true
  hide_prefill_in_display: true
`, 'utf8');

    const store = createLiveConfigStore(tempDir);
    assert.equal(store.config.routing.openRouterBaseUrl, 'https://openrouter.ai/api/');
    assert.equal(store.config.structuredPrefill.hidePrefillInDisplay, true);

    const waitUntilNextTimestamp = () => {
        const start = Date.now();
        while (Date.now() === start) {
            // busy wait long enough to guarantee a new mtime on Windows
        }
    };

    waitUntilNextTimestamp();
    fs.writeFileSync(configPath, `
server:
  host: "127.0.0.1"
  port: 8382
routing:
  openrouter_base_url: "https://example.com/router"
structured_prefill:
  enabled: true
  hide_prefill_in_display: false
  continue:
    mode: "force"
`, 'utf8');

    const logs = [];
    refreshLiveConfigStore(store, {
        log(message) {
            logs.push(String(message));
        },
        warn() {
            throw new Error('reload should not warn for a valid config change');
        },
    });

    assert.equal(store.config.routing.openRouterBaseUrl, 'https://example.com/router/');
    assert.equal(store.config.structuredPrefill.hidePrefillInDisplay, false);
    assert.equal(store.config.structuredPrefill.continueMode, 'force');
    assert.equal(logs.length, 1);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reverse proxy mode auto-routes anthropic, google, and openai-compatible paths', () => {
    const config = {
        routing: {
            allowFullUrlTargets: true,
            openAiBaseUrl: 'https://api.openai.com/',
            openRouterBaseUrl: 'https://openrouter.ai/api/',
            openAiCompatibleBaseUrl: 'https://openrouter.ai/api/',
            anthropicBaseUrl: 'https://api.anthropic.com/',
            googleBaseUrl: 'https://generativelanguage.googleapis.com/',
        },
    };

    const anthropic = resolveUpstreamTargetUrl({
        rawUrl: '/v1/messages',
        hostHeader: 'localhost:8382',
        config,
    });
    const google = resolveUpstreamTargetUrl({
        rawUrl: '/v1beta/models/gemini-2.5-flash:generateContent?key=test',
        hostHeader: 'localhost:8382',
        config,
    });
    const openAiCompatible = resolveUpstreamTargetUrl({
        rawUrl: '/v1/chat/completions',
        hostHeader: 'localhost:8382',
        config,
    });

    assert.equal(anthropic.toString(), 'https://api.anthropic.com/v1/messages');
    assert.equal(google.toString(), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test');
    assert.equal(openAiCompatible.toString(), 'https://openrouter.ai/api/v1/chat/completions');
});

test('provider aliases route openrouter, openai, anthropic, and google explicitly', () => {
    const config = {
        routing: {
            allowFullUrlTargets: true,
            openAiBaseUrl: 'https://api.openai.com/',
            openRouterBaseUrl: 'https://openrouter.ai/api/',
            openAiCompatibleBaseUrl: 'https://api.openai.com/',
            anthropicBaseUrl: 'https://api.anthropic.com/',
            googleBaseUrl: 'https://generativelanguage.googleapis.com/',
        },
    };

    const openrouter = resolveUpstreamTargetUrl({
        rawUrl: '/openrouter/v1/chat/completions',
        hostHeader: 'localhost:8382',
        config,
    });
    const openai = resolveUpstreamTargetUrl({
        rawUrl: '/openai/v1/chat/completions',
        hostHeader: 'localhost:8382',
        config,
    });
    const anthropic = resolveUpstreamTargetUrl({
        rawUrl: '/anthropic/v1/messages',
        hostHeader: 'localhost:8382',
        config,
    });
    const google = resolveUpstreamTargetUrl({
        rawUrl: '/google/v1beta/models/gemini-2.5-flash:generateContent?key=test',
        hostHeader: 'localhost:8382',
        config,
    });
    const gemini = resolveUpstreamTargetUrl({
        rawUrl: '/gemini/v1beta/models/gemini-2.5-flash:generateContent?key=test',
        hostHeader: 'localhost:8382',
        config,
    });

    assert.equal(openrouter.toString(), 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(openai.toString(), 'https://api.openai.com/v1/chat/completions');
    assert.equal(anthropic.toString(), 'https://api.anthropic.com/v1/messages');
    assert.equal(google.toString(), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test');
    assert.equal(gemini.toString(), 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=test');
});

test('prefill generator replaces [[pg]] in openai chat requests using the same upstream by default', async () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Write the opener.' },
            { role: 'assistant', content: 'Mood: [[pg]]\nScene: ' },
        ],
    };

    let capturedUrl = '';
    let capturedPayload = null;
    const rewritten = await applyPrefillGeneratorToRequest({
        targetUrl,
        jsonBody: body,
        upstreamHeaders: new Headers({ authorization: 'Bearer test' }),
        config: {
            enabled: true,
            model: '',
            maxTokens: 12,
            timeoutMs: 5000,
            stopStrings: [],
            keepMatchedStopString: false,
            extraPrompt: '',
            extraPromptRole: 'system',
        },
        fetchImpl: async (url, init) => {
            capturedUrl = String(url);
            capturedPayload = JSON.parse(String(init.body ?? '{}'));
            return new Response(JSON.stringify({
                choices: [
                    {
                        message: {
                            role: 'assistant',
                            content: 'brooding',
                        },
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(rewritten.applied, true);
    assert.equal(capturedUrl, 'https://api.openai.com/v1/chat/completions');
    assert.equal(capturedPayload.model, 'gpt-4o-mini');
    assert.equal(capturedPayload.stream, false);
    assert.equal(capturedPayload.max_tokens, 12);
    assert.deepEqual(capturedPayload.messages, [
        { role: 'user', content: 'Write the opener.' },
    ]);
    assert.equal(rewritten.jsonBody.messages[1].content, 'Mood: brooding\nScene: ');
});

test('prefill generator can use a separate anthropic target and api key', async () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'Write the opener.' },
            { role: 'assistant', content: 'Mood: [[pg]]\nScene: ' },
        ],
    };

    let capturedUrl = '';
    let capturedPayload = null;
    let capturedHeaders = null;
    const rewritten = await applyPrefillGeneratorToRequest({
        targetUrl,
        jsonBody: body,
        upstreamHeaders: new Headers({ authorization: 'Bearer main-key' }),
        config: {
            enabled: true,
            provider: 'anthropic-messages',
            targetUrl: 'https://api.anthropic.com/v1/messages',
            apiKey: 'anthropic-secret',
            apiKeyHeader: '',
            apiKeyPrefix: '',
            extraHeaders: 'x-test: yep',
            model: 'claude-sonnet-4-5',
            maxTokens: 12,
            timeoutMs: 5000,
            stopStrings: ['END'],
            keepMatchedStopString: false,
            extraPrompt: '',
            extraPromptRole: 'system',
        },
        fetchImpl: async (url, init) => {
            capturedUrl = String(url);
            capturedPayload = JSON.parse(String(init.body ?? '{}'));
            capturedHeaders = Object.fromEntries(new Headers(init.headers).entries());
            return new Response(JSON.stringify({
                content: [{ type: 'text', text: 'brooding' }],
                stop_reason: 'end_turn',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(rewritten.applied, true);
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(capturedHeaders['x-api-key'], 'anthropic-secret');
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
    assert.equal(capturedHeaders['x-test'], 'yep');
    assert.equal(capturedHeaders.authorization, undefined);
    assert.equal(capturedPayload.model, 'claude-sonnet-4-5');
    assert.equal(capturedPayload.stream, false);
    assert.equal(capturedPayload.max_tokens, 12);
    assert.deepEqual(capturedPayload.messages, [
        { role: 'user', content: 'Write the opener.' },
    ]);
    assert.equal(capturedPayload.system, 'You are terse.');
    assert.deepEqual(capturedPayload.stop_sequences, ['END']);
    assert.equal(rewritten.provider, 'anthropic-messages');
    assert.equal(rewritten.jsonBody.messages[2].content, 'Mood: brooding\nScene: ');
});

test('prefill generator strips [[pg]] to empty when disabled', async () => {
    const targetUrl = new URL('https://api.openai.com/v1/chat/completions');
    const body = {
        model: 'gpt-4o-mini',
        messages: [
            { role: 'user', content: 'Write the opener.' },
            { role: 'assistant', content: 'Mood: [[pg]]\nScene: ' },
        ],
    };

    const rewritten = await applyPrefillGeneratorToRequest({
        targetUrl,
        jsonBody: body,
        upstreamHeaders: new Headers({ authorization: 'Bearer test' }),
        config: {
            enabled: false,
            model: '',
            maxTokens: 12,
            timeoutMs: 5000,
            stopStrings: [],
            keepMatchedStopString: false,
            extraPrompt: '',
            extraPromptRole: 'system',
        },
        fetchImpl: async () => {
            throw new Error('fetch should not run when the generator is disabled');
        },
    });

    assert.equal(rewritten.applied, true);
    assert.equal(rewritten.jsonBody.messages[1].content, 'Mood: \nScene: ');
});

test('prefill generator uses non-stream gemini generateContent and can override the model', async () => {
    const targetUrl = new URL('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=test');
    const body = {
        contents: [
            { role: 'user', parts: [{ text: 'Finish the line.' }] },
            { role: 'model', parts: [{ text: 'Prefix: [[pg]]\nAnswer: ' }] },
        ],
        generationConfig: {
            responseMimeType: 'application/json',
        },
    };

    let capturedUrl = '';
    let capturedPayload = null;
    const rewritten = await applyPrefillGeneratorToRequest({
        targetUrl,
        jsonBody: body,
        upstreamHeaders: new Headers({ 'x-goog-api-key': 'test' }),
        config: {
            enabled: true,
            model: 'gemini-2.5-pro',
            maxTokens: 9,
            timeoutMs: 5000,
            stopStrings: ['END'],
            keepMatchedStopString: false,
            extraPrompt: '',
            extraPromptRole: 'system',
        },
        fetchImpl: async (url, init) => {
            capturedUrl = String(url);
            capturedPayload = JSON.parse(String(init.body ?? '{}'));
            return new Response(JSON.stringify({
                candidates: [
                    {
                        content: {
                            parts: [{ text: 'focused' }],
                        },
                        finishReason: 'STOP',
                    },
                ],
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    });

    assert.equal(rewritten.applied, true);
    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=test');
    assert.equal(capturedPayload.generationConfig.maxOutputTokens, 9);
    assert.equal(capturedPayload.generationConfig.responseMimeType, undefined);
    assert.deepEqual(capturedPayload.generationConfig.stopSequences, ['END']);
    assert.deepEqual(capturedPayload.contents, [
        { role: 'user', parts: [{ text: 'Finish the line.' }] },
    ]);
    assert.deepEqual(rewritten.jsonBody.contents[1].parts, [{ text: 'Prefix: focused\nAnswer: ' }]);
});
