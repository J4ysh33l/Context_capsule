# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ContextCapsule** is a browser extension that extracts and summarizes conversations from ChatGPT, Claude, DeepSeek, Grok, and Gemini. Users click the extension icon, extract conversation text from the DOM, send it to a backend Worker API, and receive a compressed context briefing with token savings metrics.

### Supported Platforms
- ChatGPT (chatgpt.com)
- Claude (claude.ai)
- DeepSeek (chat.deepseek.com)
- Grok (grok.com, x.com/grok)
- Gemini (gemini.google.com)

## Architecture

```
popup.js ──> content.js (DOM extraction) ──> background.js ──> Worker API
             (injected)                      (service worker)   (external)
```

### Core Modules

**popup.js/popup.html** — Extension UI and user interactions
- Shows status: wrong page → ready → extracting → result/error
- Two main flows: "Summarize Conversation" (compressed) and "View Full Chat" (raw extraction)
- Displays token counts and compression % savings
- Copy/download buttons for both modes

**content.js** — DOM extraction engine (runs in page context)
- Platform detection based on URL
- Three-strategy waterfall per platform (A: primary → B: secondary → C: tertiary)
- Retry loop with exponential backoff (400ms × 2^attempt ± 20% jitter, max 3 attempts)
- SPA polling every 500ms, max 10s per attempt
- Deduplication to avoid nested/duplicate content
- XPath helpers for semantic element discovery

**background.js** — Service worker (processes in extension context)
- Listens for `summarize` messages from popup
- POSTs conversation text to Worker API
- Handles API success/error responses
- Returns capsule text + token counts

**logger.js** — Structured logging utility
- Ring buffer (max 50 logs) per context (popup/content/background)
- Persistent session storage via `chrome.storage.session`
- Console output + buffer management
- Conditional debug logging via DEBUG_MODE flag

## Extraction Strategy Pattern

Each platform has three strategies tried in order:

1. **Strategy A** — Stable first-party attributes (fastest)
   - ChatGPT: `data-message-author-role` attribute
   - Claude: `data-testid` (human-turn, ai-turn)
   - DeepSeek: class name substrings (userMessage, assistantMessage)
   - Grok: `data-testid="message-bubble"`
   - Gemini: Custom element tags (`<user-query>`, `<model-response>`)

2. **Strategy B** — CSS class / semantic patterns (fallback)
   - Matches common class patterns (markdown, prose, message containers)
   - Handles obfuscated but still semantically-named classes

3. **Strategy C** — XPath / broad DOM sweep (last resort)
   - Catches fully-obfuscated or DOM-structure changes
   - Deduplicates nested containers before returning

First strategy returning ≥100 chars succeeds immediately. If all fail, returns longest partial result or fallback (full page text).

## Testing Locally

1. **Load extension in Brave/Chrome:**
   - Open DevTools → Extensions or navigate to `brave://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked" and select this directory

2. **Test extraction:**
   - Open a conversation on any supported platform (ChatGPT, Claude, etc.)
   - Click ContextCapsule icon
   - Verify platform detection in popup
   - Click "Summarize Conversation"
   - Check browser console (DevTools) and extension logs

3. **Debug DOM extraction:**
   - Open page console on chat page, run:
     ```js
     // After content script is injected
     chrome.runtime.sendMessage({ action: 'extractConversation' }, (resp) => {
       console.log('Extracted text:', resp.text);
     });
     ```

4. **Monitor logs:**
   - Extension logs are in `chrome.storage.session` under `logs` key
   - Can be inspected via DevTools → Application → Session Storage

## Key Files

- `manifest.json` — Extension metadata, permissions, icons, entry points
- `popup.js/html/css` — UI and user flows
- `content.js` — DOM extraction (900+ lines, platform-specific logic)
- `background.js` — Worker API bridge
- `logger.js` — Structured logging with ring buffer

## API Integration

**Dual-path routing:** background.js routes summarization requests to one of two APIs:

1. **Gemini API direct** (if user configured API key in settings)
   - Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
   - Uses `chrome.storage.local` for API key + model selection
   - Returns actual token counts from Google's usage metadata
   - User-keyed requests (not shared quota)

2. **Shared Worker API** (fallback, no key needed)
   - Endpoint: `https://contextcapsule-worker.contextcapsule-app.workers.dev/api/summarize`
   - Request: `{ conversationText, mode: 'dense', platform }`
   - Response: `{ success, capsule, originalTokens, capsuleTokens, error }`
   - Shared quota; no per-user billing

Settings stored in `chrome.storage.local`: `geminiApiKey`, `selectedModel`

## Token Estimation & Validation

- **Token estimate formula:** `Math.ceil(text.length / 4)`
- **Minimum conversation:** 160 tokens (~640 chars) before submission to avoid API waste
- **Extraction timeout:** 20s max per attempt
- **Retry logic:** Exponential backoff (400ms × 2^attempt ± 20% jitter, max 3 attempts)
```

## Deployment

Extension is published to Chrome Web Store (manifest v3). CWS handles updates automatically via `update_url`.

To publish new version:
- Bump `version` in manifest.json
- ZIP directory (excluding node_modules, git files)
- Upload to CWS developer console

## Common Changes

**Add new platform support:**
1. Add URL pattern to `host_permissions` in manifest.json
2. Add platform detection in `popup.js` (isPlatform check)
3. Add strategy functions to `content.js` (platformStrategyA/B/C)
4. Add entry to STRATEGY_MAP in content.js

**Modify extraction strategy:**
- Edit relevant platform strategies in content.js
- Test against live chat to verify DOM selectors still work
- Extraction is resilient — fallback to Strategy B/C if A fails

**Change API endpoint:**
- Update WORKER_URL in background.js
- Verify response schema matches expectations in popup.js

## Notes

- No build process — direct extension file structure, no bundler
- Extraction logic is DOM-dependent and fragile to UI changes
- Worker API is external; extension gracefully handles API downtime
- Logging persists across popup closes via session storage
- All three extraction strategies per platform ensure resilience to future UI refactors
