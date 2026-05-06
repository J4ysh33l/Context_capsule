// Content script — injected into ChatGPT, Claude, DeepSeek, Grok, and Gemini pages
// Extracts conversation turns from the rendered DOM.
//
// Architecture:
//   waitForContent()
//     └─ extractWithRetry()   — 3 attempts, exponential backoff + jitter
//          └─ extractConversation()
//               └─ runStrategies(platform)   — waterfall: A → B → C
//
// Each platform has three independent extraction strategies tried in order.
// Strategy A: primary (stable data-attributes / semantic elements)
// Strategy B: secondary (CSS class patterns / aria attributes)
// Strategy C: tertiary (XPath / broad DOM sweep)
// A strategy returns a non-empty string (≥100 chars) or null.
// The first strategy that succeeds short-circuits the waterfall.

(function () {
  // ── Platform Detection ────────────────────────────────────────────────────
  const platform = detectPlatform();
  if (typeof logger !== 'undefined') {
    logger.info('content', 'Content script initialized', { platform });
  }

  function detectPlatform() {
    const url = window.location.href;
    if (url.includes('chatgpt.com')) return 'chatgpt';
    if (url.includes('claude.ai')) return 'claude';
    if (url.includes('chat.deepseek.com')) return 'deepseek';
    if (url.includes('grok.com') || (url.includes('x.com') && url.includes('/grok'))) return 'grok';
    if (url.includes('gemini.google.com')) return 'gemini';
    return 'unknown';
  }

  // ── Strategy Runner ───────────────────────────────────────────────────────
  /**
   * Try each strategy function in order. Return the first result that is
   * sufficiently long (≥100 chars), or the longest result found, or null.
   * @param {Array<() => string|null>} strategies
   * @returns {string|null}
   */
  function runStrategies(strategies) {
    let best = null;
    let bestIndex = -1;
    for (let i = 0; i < strategies.length; i++) {
      try {
        const result = strategies[i]();
        if (result && result.trim().length >= 100) {
          if (typeof logger !== 'undefined') logger.info('content', `Strategy ${i} succeeded (immediate)`, { length: result.trim().length });
          return result.trim(); // good enough — return immediately
        }
        // keep track of the longest partial result
        if (result && result.trim().length > (best?.length ?? 0)) {
          best = result.trim();
          bestIndex = i;
        }
      } catch (err) {
        if (typeof logger !== 'undefined') logger.debug('content', `Strategy ${i} threw error`, { error: err.message });
      }
    }
    if (best) {
      if (typeof logger !== 'undefined') logger.info('content', `Strategy ${bestIndex} succeeded (best partial)`, { length: best.length });
    } else {
      if (typeof logger !== 'undefined') logger.warn('content', 'All strategies returned null or empty');
    }
    return best || null;
  }

  // ── XPath Helper ──────────────────────────────────────────────────────────
  /**
   * Evaluate an XPath expression and return all matching elements.
   * @param {string} expression
   * @param {Node} [context=document]
   * @returns {Element[]}
   */
  function xpathAll(expression, context = document) {
    const result = document.evaluate(
      expression,
      context,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }
    return nodes;
  }

  /**
   * Collect innerText from a NodeList / array, prefix each with a role label,
   * and join with double newlines.
   * @param {NodeListOf<Element>|Element[]} elements
   * @param {(el: Element, index: number) => string} roleResolver
   * @param {number} [minLength=5]
   * @returns {string}
   */
  function collectText(elements, roleResolver, minLength = 5) {
    const turns = [];
    Array.from(elements).forEach((el, i) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > minLength) {
        turns.push(`[${roleResolver(el, i)}]: ${text}`);
      }
    });
    return turns.join('\n\n');
  }

  // ── Context Helper ────────────────────────────────────────────────────────
  function getContext() {
    return document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  }

  // ── ChatGPT Strategies ────────────────────────────────────────────────────
  /**
   * Strategy A: data-message-author-role attribute (stable, first-party attribute).
   * Covers both old and new ChatGPT frontend versions.
   */
  function chatgptStrategyA() {
    const els = getContext().querySelectorAll('[data-message-author-role]');
    if (!els.length) return null;
    return collectText(els, (el) => el.getAttribute('data-message-author-role') || 'unknown');
  }

  /**
   * Strategy B: .markdown / .prose class blocks — used in legacy ChatGPT builds.
   * Alternates user/assistant by DOM position.
   */
  function chatgptStrategyB() {
    const els = getContext().querySelectorAll('.markdown, .prose');
    if (!els.length) return null;
    return collectText(els, (_, i) => i % 2 === 0 ? 'user' : 'assistant');
  }

  /**
   * Strategy C: XPath sweep of all div elements whose class contains 'group'
   * and that contain meaningful text — a broad fallback that works even when
   * class names are fully obfuscated.
   */
  function chatgptStrategyC() {
    const nodes = xpathAll(".//div[contains(@class,'group') and string-length(normalize-space(.)) > 30]", getContext());
    // Deduplicate nested containers by checking parent containment
    const deduped = nodes.filter((node, _i, arr) =>
      !arr.some((other) => other !== node && other.contains(node))
    );
    if (!deduped.length) return null;
    const turns = [];
    deduped.forEach((el, i) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > 10) turns.push(`[${i % 2 === 0 ? 'user' : 'assistant'}]: ${text}`);
    });
    return turns.join('\n\n') || null;
  }

  // ── Claude Strategies ─────────────────────────────────────────────────────
  /**
   * Strategy A: data-testid for human-turn and ai-turn containers (Anthropic's stable test IDs).
   */
  function claudeStrategyA() {
    // New DOM: outer turn containers only — avoids double-capture of nested user-message/ai-turn children
    const els = getContext().querySelectorAll('[data-testid="human-turn"], [data-testid="ai-turn"]');
    if (!els.length) return null;
    const turns = [];
    Array.from(els).forEach((el) => {
      const isHuman = (el.dataset.testid ?? '').includes('human');
      let text;
      if (isHuman) {
        const userMsg = el.querySelector('[data-testid="user-message"]');
        text = (userMsg ?? el).innerText?.trim() ?? '';
      } else {
        const responses = el.querySelectorAll('.font-claude-response');
        text = responses.length
          ? Array.from(responses).map((r) => r.innerText?.trim()).filter(Boolean).join('\n')
          : el.innerText?.trim() ?? '';
      }
      if (text.length > 10) turns.push(`[${isHuman ? 'human' : 'assistant'}]: ${text}`);
    });
    return turns.join('\n\n') || null;
  }

  /**
   * Strategy B: class-pattern matching for HumanTurn / AssistantMessage —
   * handles obfuscated but still semantically named classes.
   */
  function claudeStrategyB() {
    // Old DOM (no outer turn containers): user-message testid + font-claude-response class, interleaved by DOM order
    const els = getContext().querySelectorAll('[data-testid="user-message"], .font-claude-response');
    if (!els.length) return null;
    const turns = [];
    Array.from(els).forEach((el) => {
      const isHuman = el.matches('[data-testid="user-message"]');
      const text = el.innerText?.trim() ?? '';
      if (text.length > 10) turns.push(`[${isHuman ? 'human' : 'assistant'}]: ${text}`);
    });
    return turns.join('\n\n') || null;
  }

  /**
   * Strategy C: XPath targeting any element whose data-testid attribute
   * contains "turn" — catches future Anthropic testid naming variants.
   */
  function claudeStrategyC() {
    const nodes = xpathAll(".//*[@data-testid and contains(@data-testid, 'turn')]", getContext());
    if (!nodes.length) {
      // Ultimate fallback: all prose-like paragraphs inside article/main
      const paras = xpathAll(".//p[string-length(normalize-space(.)) > 20]", getContext());
      if (!paras.length) return null;
      const turns = [];
      paras.forEach((el, i) => {
        const text = el.innerText?.trim() ?? '';
        if (text) turns.push(`[${i % 2 === 0 ? 'human' : 'assistant'}]: ${text}`);
      });
      return turns.join('\n\n') || null;
    }
    return collectText(nodes, (el) => {
      const tid = el.dataset?.testid ?? '';
      return (tid.includes('human') || tid.includes('user')) ? 'human' : 'assistant';
    });
  }

  function validateClaudeResult(text) {
    const hasHuman = /\[human\]:/i.test(text) || /\[user\]:/i.test(text);
    const hasAssistant = /\[assistant\]:/i.test(text);
    return { hasHuman, hasAssistant };
  }

  // ── DeepSeek Strategies ───────────────────────────────────────────────────
  /**
   * Strategy A: class-name substrings for user/assistant containers,
   * interleaved by DOM order.
   */
  function deepseekStrategyA() {
    const els = getContext().querySelectorAll(
      '[class*="userMessage"], [class*="user-message"], [class*="assistantMessage"], ' +
      '[class*="ds-markdown"], .fbb737a4, .e3ec2a27'
    );
    if (!els.length) return null;
    const turns = [];
    Array.from(els).forEach((el) => {
      const cls = el.className ?? '';
      const isUser = cls.includes('user') || cls.includes('fbb737a4');
      const text = el.innerText?.trim() ?? '';
      if (text.length > 5) turns.push(`[${isUser ? 'user' : 'assistant'}]: ${text}`);
    });
    return turns.join('\n\n') || null;
  }

  /**
   * Strategy B: broader chat/message/bubble class sweep with deduplication.
   */
  function deepseekStrategyB() {
    const els = getContext().querySelectorAll('[class*="chat"], [class*="message"], [class*="bubble"]');
    if (!els.length) return null;
    const seen = new Set();
    const turns = [];
    Array.from(els).forEach((el) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > 20 && !seen.has(text)) {
        seen.add(text);
        turns.push(text);
      }
    });
    return turns.join('\n\n') || null;
  }

  /**
   * Strategy C: semantic HTML sweep — article, section, [role="article"].
   * Deduplicates nested containers.
   */
  function deepseekStrategyC() {
    const nodes = xpathAll(
      ".//article | .//section | .//*[@role='article'] | .//p[string-length(normalize-space(.)) > 20]", getContext()
    );
    const deduped = nodes.filter((node, _, arr) =>
      !arr.some((other) => other !== node && other.contains(node))
    );
    if (!deduped.length) return null;
    const seen = new Set();
    const turns = [];
    deduped.forEach((el) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > 20 && !seen.has(text)) {
        seen.add(text);
        turns.push(text);
      }
    });
    return turns.join('\n\n') || null;
  }

  // ── Grok Strategies ───────────────────────────────────────────────────────
  /**
   * Strategy A: data-testid="message-bubble" — Grok's stable test attribute.
   */
  function grokStrategyA() {
    const els = getContext().querySelectorAll(
      '[data-testid="message-bubble"], [class*="GrokMessage"], [class*="message-container"]'
    );
    if (!els.length) return null;
    return collectText(els, (_, i) => i % 2 === 0 ? 'user' : 'assistant', 5);
  }

  /**
   * Strategy B: aria-label and class-name pattern matching.
   */
  function grokStrategyB() {
    const els = getContext().querySelectorAll('[aria-label*="message"], [class*="Message"], [class*="Bubble"]');
    if (!els.length) return null;
    const seen = new Set();
    const turns = [];
    Array.from(els).forEach((el, i) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > 10 && !seen.has(text)) {
        seen.add(text);
        turns.push(`[${i % 2 === 0 ? 'user' : 'assistant'}]: ${text}`);
      }
    });
    return turns.join('\n\n') || null;
  }

  /**
   * Strategy C: XPath sweep for all text-bearing paragraphs or divs with
   * substantial content, deduplicating ancestors.
   */
  function grokStrategyC() {
    const nodes = xpathAll(
      ".//*[self::div or self::p or self::span][string-length(normalize-space(.)) > 50 and not(descendant::div[string-length(normalize-space(.)) > 50])]", getContext()
    );
    if (!nodes.length) return null;
    const seen = new Set();
    const turns = [];
    nodes.forEach((el) => {
      const text = el.innerText?.trim() ?? '';
      if (text.length > 50 && !seen.has(text)) {
        seen.add(text);
        turns.push(text);
      }
    });
    return turns.join('\n\n') || null;
  }

  // ── Gemini Strategies ─────────────────────────────────────────────────────
  /**
   * Strategy A: custom element tags (user-query, model-response) —
   * Google's semantic custom elements are highly stable.
   */
  function geminiStrategyA() {
    const els = getContext().querySelectorAll('user-query, model-response');
    if (!els.length) return null;
    return collectText(els, (el) => el.tagName.toLowerCase() === 'user-query' ? 'user' : 'gemini', 5);
  }

  /**
   * Strategy B: CSS class patterns (.query-text, .model-response-text, etc.)
   * interleaved by DOM position.
   */
  function geminiStrategyB() {
    const els = getContext().querySelectorAll(
      '.query-text, [aria-label*="you said"], .user-query-text, ' +
      '.model-response-text, .response-container-content'
    );
    if (!els.length) return null;
    return collectText(els, (el) => {
      const cls = el.className ?? '';
      const label = el.getAttribute('aria-label') ?? '';
      return (cls.includes('query') || cls.includes('user') || label.includes('you')) ? 'user' : 'gemini';
    });
  }

  /**
   * Strategy C: broad class-pattern sweep for query/response/message/prompt
   * containers, with ancestor deduplication.
   */
  function geminiStrategyC() {
    const nodes = xpathAll(
      ".//*[contains(@class,'query') or contains(@class,'response') or contains(@class,'message') or contains(@class,'prompt')]" +
      "[string-length(normalize-space(.)) > 20]", getContext()
    );
    const deduped = nodes.filter((node, _, arr) =>
      !arr.some((other) => other !== node && other.contains(node))
    );
    if (!deduped.length) return null;
    const seen = new Set();
    const turns = [];
    deduped.forEach((el) => {
      const cls = el.className ?? '';
      const isUser = cls.includes('query') || cls.includes('user') || cls.includes('prompt');
      const text = el.innerText?.trim() ?? '';
      if (text.length > 5 && !seen.has(text)) {
        seen.add(text);
        turns.push(`[${isUser ? 'user' : 'gemini'}]: ${text}`);
      }
    });
    return turns.join('\n\n') || null;
  }

  // ── Generic Fallback ──────────────────────────────────────────────────────
  function extractFallback() {
    return getContext().innerText.trim();
  }

  // ── Platform → Strategy Waterfall Map ────────────────────────────────────
  const STRATEGY_MAP = {
    chatgpt: [chatgptStrategyA, chatgptStrategyB, chatgptStrategyC],
    claude:  [claudeStrategyA,  claudeStrategyB,  claudeStrategyC],
    deepseek:[deepseekStrategyA,deepseekStrategyB,deepseekStrategyC],
    grok:    [grokStrategyA,    grokStrategyB,    grokStrategyC],
    gemini:  [geminiStrategyA,  geminiStrategyB,  geminiStrategyC],
  };

  // ── Extraction Entry Point ────────────────────────────────────────────────
  function extractConversation() {
    const strategies = STRATEGY_MAP[platform];
    if (!strategies) return extractFallback();
    return runStrategies(strategies) || extractFallback();
  }

  // ── Exponential Backoff Retry ─────────────────────────────────────────────
  /**
   * Run extractConversation up to MAX_ATTEMPTS times.
   * On each failure (result too short), wait BASE_DELAY_MS × 2^attempt ± jitter
   * before trying again. Resolves with the best result available after all attempts.
   *
   * @param {number} maxWaitMs - max time (ms) to spend inside waitForContent per attempt
   * @returns {Promise<string>}
   */
  const RETRY_CONFIG = {
    MAX_ATTEMPTS: 3,
    BASE_DELAY_MS: 400,   // attempt 1→2: 800ms, attempt 2→3: 1600ms
    JITTER_FACTOR: 0.2,   // ±20% of the delay
    MIN_SUCCESS_CHARS: 100,
    SPA_WAIT_MS: 10000,   // per-attempt SPA polling cap
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitteredDelay(attempt) {
    const base = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = base * RETRY_CONFIG.JITTER_FACTOR * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  /**
   * Wait for the SPA to render sufficient content, then return the extracted text.
   * Polls every 500ms, gives up after maxWaitMs.
   */
  function waitForContent(maxWaitMs = RETRY_CONFIG.SPA_WAIT_MS) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      function check() {
        const text = extractConversation();
        if (text && text.length > RETRY_CONFIG.MIN_SUCCESS_CHARS) {
          resolve(text);
          return;
        }
        if (Date.now() - startTime > maxWaitMs) {
          resolve(text || '');
          return;
        }
        setTimeout(check, 500);
      }
      // Give the SPA an initial 1.5 s grace period before first check
      setTimeout(check, 1500);
    });
  }

  /**
   * Retry wrapper: each attempt runs the full waitForContent() SPA poll cycle.
   * If the result is still too short, wait with backoff and try again.
   */
  async function extractWithRetry() {
    let lastResult = '';
    for (let attempt = 0; attempt < RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
      if (typeof logger !== 'undefined') logger.info('content', `Extraction attempt ${attempt + 1}/${RETRY_CONFIG.MAX_ATTEMPTS}`);
      const result = await waitForContent();
      if (result && result.length >= RETRY_CONFIG.MIN_SUCCESS_CHARS) {
        if (typeof logger !== 'undefined') logger.info('content', 'Extraction successful', { attempts: attempt + 1, length: result.length });
        return result; // success — bail out immediately
      }
      // Keep track of best partial result in case all attempts fail
      if (result && result.length > lastResult.length) {
        lastResult = result;
      }
      // Don't sleep after the last attempt
      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS - 1) {
        const delay = jitteredDelay(attempt + 1);
        if (typeof logger !== 'undefined') logger.debug('content', `Attempt ${attempt + 1} failed. Waiting ${delay}ms before retry.`);
        await sleep(delay);
      }
    }
    // All attempts exhausted — return best partial or empty string
    if (typeof logger !== 'undefined') logger.warn('content', 'Extraction exhausted all attempts', { bestLength: lastResult.length });
    return lastResult;
  }

  // ── Message Listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'extractConversation') {
      extractWithRetry().then((text) => {
        const meta = platform === 'claude' ? validateClaudeResult(text || '') : null;
        sendResponse({ success: true, text, platform, meta });
      });
      return true; // keep channel open for async response
    }
  });

})();
