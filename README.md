# ContextCapsule

A browser extension that extracts conversations from AI chat platforms and compresses them into dense context briefings — saving tokens when continuing long chats in new sessions.

**Supported platforms:** ChatGPT, Claude, DeepSeek, Grok, Gemini

---

## Quick Start

### Installation (Regular User)

1. **Download files**
   - Go to GitHub repository
   - Click green **Code** button → **Download ZIP**
   - Extract (unzip) the folder to your computer

2. **Open extensions page**
   - Chrome: `chrome://extensions`
   - Brave: `brave://extensions`
   - Edge: `edge://extensions`

3. **Enable Developer Mode**
   - Toggle **Developer mode** (top-right corner)

4. **Load extension**
   - Click **Load unpacked**
   - Select the extracted folder
   - Click **Select Folder**

5. **Pin to toolbar**
   - Click puzzle icon in toolbar
   - Find ContextCapsule → click pin
   - Icon now appears permanently

6. **Use it**
   - Open ChatGPT, Claude, Gemini, Grok, or DeepSeek
   - Have a conversation
   - Click ContextCapsule icon
   - Click **Summarize Conversation**
   - Copy or download the briefing

---

## How It Works

### Architecture Overview

```
popup.js ──> content.js (DOM extraction) ──> background.js ──> API
             (injected into page)             (service worker)   (external)
```

4 components, each with a specific job:

---

### 1. `popup.js` / `popup.html` — The UI

When you click the extension icon, popup shows:

- **Platform detection** — checks URL to identify ChatGPT, Claude, etc.
- **Status states** — wrong page → ready → extracting → result/error
- **Two main buttons:**
  - **Summarize Conversation** — sends text to API, returns compressed briefing
  - **View Full Transcript** — shows raw extracted text with no compression
- **Token metrics** — displays original token count, compressed count, % saved
- **Copy/Download** — buttons to copy text or download as file

If you're on unsupported site, shows "Nothing to capture just yet." If extraction fails, shows error with retry button.

---

### 2. `content.js` — DOM Extraction Engine

Script injected into the chat page itself. Reads conversation directly from page HTML (the DOM).

#### Three-Strategy Waterfall

Extraction attempted in order per platform. First strategy returning ≥100 chars wins:

| Strategy | Method | Speed |
|----------|--------|-------|
| **A** | Stable first-party attributes | Fast |
| **B** | CSS class / semantic patterns | Medium |
| **C** | XPath / broad DOM sweep | Slow (last resort) |

#### Platform-Specific Selectors

| Platform | Strategy A |
|----------|-----------|
| ChatGPT | `data-message-author-role` attribute |
| Claude | `data-testid="human-turn"` / `"ai-turn"` |
| DeepSeek | Class substrings `userMessage`, `assistantMessage` |
| Grok | `data-testid="message-bubble"` |
| Gemini | Custom elements `<user-query>`, `<model-response>` |

#### Retry Logic

If extraction fails (page still loading, dynamic content not rendered):
- Retries up to **3 times**
- Wait between retries: `400ms × 2^attempt ± 20% random jitter`
  - Attempt 1: ~400ms
  - Attempt 2: ~800ms
  - Attempt 3: ~1600ms
- SPA polling every 500ms, max 10s per attempt
- Total timeout: 20s max

After extraction, deduplication removes nested/repeated text blocks.

---

### 3. `background.js` — Service Worker / API Bridge

Runs in extension's background context (not the page). Listens for messages from popup.

When popup sends `summarize` message, background.js:
1. Checks if user configured API key in settings
2. Routes to one of two paths:

#### Path A: Direct API (if configured)
- Use your own API key (Gemini, OpenAI, Groq, etc.)
- Your personal quota and billing
- Real token counts from provider's metadata

#### Path B: OpenAI-compatible API
- Supports Groq, LMStudio, or any OpenAI-compatible endpoint
- Send API key and base URL in settings
- Real token counts from provider's metadata

---

### 4. `logger.js` — Structured Logging

- Ring buffer stores last 50 log entries per context (popup / content / background)
- Persists across popup closes via `chrome.storage.session`
- Inspect logs: DevTools → Application → Session Storage → `logs` key

---

## Settings

Click gear icon in popup to open settings:

**Provider options:**
- **Google Gemini** — paste API key from aistudio.google.com
- **OpenAI** — paste API key from platform.openai.com
- **Groq** — paste API key from console.groq.com
- **LM Studio (local)** — point to local server (http://localhost:1234/v1)

For providers requiring key:
- Paste API key in **API Key** field
- Select **Model** from dropdown
- Click **Save**

Settings stored in `chrome.storage.local`.

---

## Token Estimation

- Formula: `Math.ceil(text.length / 4)` — standard GPT-style approximation
- Minimum threshold: **160 tokens (~640 chars)** before submission — prevents API waste on tiny extractions

---

## For Developers

### Architecture

- No build process — pure JS/HTML/CSS
- No bundler or node_modules
- Direct extension file structure (Manifest V3)

### Adding a New Platform

1. Add URL pattern to `host_permissions` in `manifest.json`
2. Add platform detection in `popup.js` (URL check function)
3. Add three strategy functions in `content.js`:
   - `platformStrategyA()` — fast, first-party attributes
   - `platformStrategyB()` — CSS class patterns
   - `platformStrategyC()` — XPath fallback
4. Register them in `STRATEGY_MAP` at top of `content.js`

### Modifying Extraction Strategy

1. Edit relevant platform strategies in `content.js`
2. Test against live chat — verify DOM selectors still work
3. Extraction is resilient — Strategy B/C act as fallbacks if A fails

### Changing API Provider

1. Add new provider handler in `background.js` (model callGeminiDirect/callOpenAIDirect)
2. Add provider config to `PROVIDER_CONFIGS` in `popup.js`
3. Verify request/response schema matches the API's format

---

## Key Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension metadata, permissions, icons, entry points |
| `popup.html` | Extension UI structure (states, buttons, settings) |
| `popup.js` | UI logic, state machine, platform detection |
| `popup.css` | UI styling |
| `content.js` | DOM extraction engine (900+ lines), platform strategies |
| `background.js` | Service worker, API routing (Gemini/OpenAI-compatible/LMStudio) |
| `logger.js` | Structured logging, ring buffer, session storage |

---

## Troubleshooting

**Extension shows "Nothing to capture":**
- Make sure you're on a supported platform (ChatGPT, Claude, Gemini, Grok, DeepSeek)
- Reload the page and try again

**Extraction takes a long time or fails:**
- Platform UI may have changed — extraction will retry up to 3 times
- Check DevTools console for error logs
- Try **View Full Transcript** first to see if raw extraction works

**Token counts seem off:**
- Token formula is approximate (`text.length / 4`)
- If using direct API (Gemini, OpenAI), numbers are from provider's metadata (more accurate)

**API key not working:**
- Make sure you pasted the full key (no spaces at start/end)
- Verify key is valid for the selected provider
- Check that model name is correct

---

## Publishing

Extension is published to Chrome Web Store (Manifest V3). To publish new version:

1. Bump `version` in `manifest.json`
2. ZIP directory (excluding node_modules, git files)
3. Upload to Chrome Web Store developer console
4. CWS handles updates automatically via `update_url`

---

## Notes

- Extraction selectors are DOM-dependent — can break on platform UI updates (strategies B/C act as fallbacks)
- API provider is external — extension handles downtime gracefully
- No personal data is logged or persisted beyond extension storage
- Conversations sent to API are processed and not stored
