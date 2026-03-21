# StructuredPrefill Proxy

Only touch `config.yaml` if you want to change defaults.

Run it:

```bash
cd proxy
npm start
```

Edits to `config.yaml` apply live. If you change `server.host` or `server.port`, restart the proxy.

Use one of these as the reverse proxy or base URL:

```text
OpenRouter: http://localhost:8382/openrouter
OpenAI:     http://localhost:8382/openai
Anthropic:  http://localhost:8382/anthropic
Gemini:     http://localhost:8382/google
```

Then use the normal provider path after that:

```text
/v1/chat/completions
/v1/responses
/v1/messages
/v1beta/models/gemini-2.5-flash:generateContent
```

Bare `http://localhost:8382` still works too. It uses `routing.openai_compatible_base_url` from `config.yaml`.

Full targets also work:

```text
http://localhost:8382/https://api.openai.com/v1/chat/completions
http://localhost:8382/https://api.anthropic.com/v1/messages
http://localhost:8382/https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent
```

StructuredPrefill syntax:

```text
https://rentry.org/structuredprefill
```
