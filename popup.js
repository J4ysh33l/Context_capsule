function estimateTokens(text) {
  return Math.round(text.length / 4);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["logger.js", "content.js"] });
}

function showCopyFeedback(btnEl, btnTextEl, revertLabel = "Copy") {
  btnTextEl.textContent = "Copied!";
  btnEl.classList.add("copied");
  setTimeout(() => {
    btnTextEl.textContent = revertLabel;
    btnEl.classList.remove("copied");
  }, 2000);
}

window.addEventListener("error", (e) => {
  console.error("[ContextCapsule popup error]", e.error || e.message);
  const home = document.getElementById("home-page");
  const empty = document.getElementById("empty-page");
  if (home && home.classList.contains("hidden") && empty && empty.classList.contains("hidden")) {
    home.classList.remove("hidden");
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  // ── Pages ──
  const homePage       = document.getElementById("home-page");
  const emptyPage      = document.getElementById("empty-page");
  const loadingPage    = document.getElementById("loading-page");
  const resultPage     = document.getElementById("result-page");
  const transcriptPage = document.getElementById("transcript-page");
  const errorPage      = document.getElementById("error-page");
  const settingsPage   = document.getElementById("settings-page");

  // ── Header ──
  const backBtn        = document.getElementById("back-btn");
  const settingsBtn    = document.getElementById("settings-btn");

  // ── Home ──
  const cardTitle        = document.getElementById("card-title");
  const cardMessages     = document.getElementById("card-messages");
  const cardTokens       = document.getElementById("card-tokens");
  const transcriptCharHint = document.getElementById("transcript-char-hint");
  const homeModelLabel   = document.getElementById("home-model-label");
  const summarizeBtn     = document.getElementById("summarize-btn");
  const fullChatBtn      = document.getElementById("full-chat-btn");

  // ── Loading ──
  const loadingStatus   = document.getElementById("loading-status");
  const loadingTokensIn = document.getElementById("loading-tokens-in");
  const loadingEstOut   = document.getElementById("loading-est-out");
  const loadingSavings  = document.getElementById("loading-savings");
  const loadingFill     = document.getElementById("loading-progress-fill");

  // ── Result ──
  const resultSavings    = document.getElementById("result-savings");
  const resultTokensMain = document.getElementById("result-tokens-main");
  const resultTokensFrom = document.getElementById("result-tokens-from");
  const resultText       = document.getElementById("result-text");
  const copyBtn          = document.getElementById("copy-btn");
  const copyBtnText      = document.getElementById("copy-btn-text");
  const regenBtn         = document.getElementById("regen-btn");
  const resultBackBtn    = document.getElementById("result-back-btn");

  // ── Transcript ──
  const transcriptMeta     = document.getElementById("transcript-meta");
  const transcriptChars    = document.getElementById("transcript-chars");
  const transcriptWords    = document.getElementById("transcript-words");
  const transcriptSkeleton = document.getElementById("transcript-skeleton");
  const transcriptTextEl   = document.getElementById("transcript-text");
  const copyTranscriptBtn  = document.getElementById("copy-transcript-btn");
  const copyTranscriptText = document.getElementById("copy-transcript-text");
  const downloadBtn        = document.getElementById("download-btn");
  const downloadBtnText    = document.getElementById("download-btn-text");

  // ── Error ──
  const errorText    = document.getElementById("error-text");
  const retryBtn     = document.getElementById("retry-btn");
  const errorBackBtn = document.getElementById("error-back-btn");

  // ── Settings ──
  const providerSelect  = document.getElementById("provider-select");
  const apiKeyRow       = document.getElementById("api-key-row");
  const apiKeyInput     = document.getElementById("api-key-input");
  const apiKeyHint      = document.getElementById("api-key-hint");
  const baseUrlRow      = document.getElementById("base-url-row");
  const baseUrlInput    = document.getElementById("base-url-input");
  const modelRow        = document.getElementById("model-row");
  const modelSelect     = document.getElementById("model-select");
  const fetchModelsBtn  = document.getElementById("fetch-models-btn");
  const modelStatus     = document.getElementById("model-status");
  const saveKeysBtn     = document.getElementById("save-keys-btn");
  const clearKeysBtn    = document.getElementById("clear-keys-btn");
  const keyStatus       = document.getElementById("key-status");

  // ── State ──
  let currentPlatformLabel = "ChatGPT";
  let lastExtractedText    = null;
  let lastExtractTime      = 0; // timestamp for cache age check
  let previousPage         = null;

  const PAGES = { home: homePage, empty: emptyPage, loading: loadingPage, result: resultPage, transcript: transcriptPage, error: errorPage, settings: settingsPage };

  // ── Platform detection (with timeout guard) ──
  let tab = null;
  try {
    tab = await Promise.race([
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0]),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch (e) {
    console.error("tabs.query failed", e);
  }
  const tabUrl = tab?.url || "";
  const isChatGPT  = /chatgpt\.com\/c\/|chatgpt\.com\/\?/.test(tabUrl) || (tabUrl.includes("chatgpt.com") && !tabUrl.includes("/help"));
  const isClaude   = /claude\.ai\/chat\/|claude\.ai\/\?/.test(tabUrl)   || (tabUrl.includes("claude.ai") && !tabUrl.includes("/docs") && !tabUrl.includes("/help"));
  const isDeepSeek = tabUrl.includes("chat.deepseek.com");
  const isGrok     = tabUrl.includes("grok.com") || (tabUrl.includes("x.com") && tabUrl.includes("/grok"));
  const isGemini   = tabUrl.includes("gemini.google.com");
  const isSupported = isChatGPT || isClaude || isDeepSeek || isGrok || isGemini;

  currentPlatformLabel = isClaude ? "Claude" : isDeepSeek ? "DeepSeek" : isGrok ? "Grok" : isGemini ? "Gemini" : "ChatGPT";

  if (!isSupported) {
    if (typeof logger !== "undefined") logger.warn("popup", "Unsupported page", { url: tabUrl });
    showPage("empty");
    return;
  }

  if (typeof logger !== "undefined") logger.info("popup", "Platform detected", { platform: currentPlatformLabel });
  showHome();

  // ── Back button ──
  backBtn.addEventListener("click", () => {
    if (previousPage === "settings") {
      showHome();
    } else {
      showHome();
    }
  });

  // ── Settings ──
  settingsBtn.addEventListener("click", () => {
    previousPage = currentVisiblePage();
    showPage("settings");
    loadSettings();
  });

  // ── Summarize ──
  summarizeBtn.addEventListener("click", handleSummarize);
  regenBtn.addEventListener("click", handleSummarize);
  retryBtn.addEventListener("click", handleSummarize);
  resultBackBtn.addEventListener("click", showHome);
  errorBackBtn.addEventListener("click", showHome);

  // ── Full chat ──
  fullChatBtn.addEventListener("click", handleFullChat);

  // ── Copy briefing ──
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(resultText.value).then(() => showCopyFeedback(copyBtn, copyBtnText, "Copy briefing"));
  });

  // ── Copy transcript ──
  copyTranscriptBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(transcriptTextEl.value).then(() => showCopyFeedback(copyTranscriptBtn, copyTranscriptText));
  });

  // ── Download transcript ──
  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([transcriptTextEl.value], { type: "text/plain;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `${currentPlatformLabel.toLowerCase()}-conversation.txt`;
    a.click();
    URL.revokeObjectURL(url);
    downloadBtnText.textContent = "Downloaded!";
    setTimeout(() => { downloadBtnText.textContent = "Download"; }, 2000);
  });

  // ────────────────────────────────
  // Core flows
  // ────────────────────────────────

  async function handleSummarize() {
    logger.info("popup", "Summarize clicked", { platform: currentPlatformLabel });
    showPage("loading");
    resetProgress();

    // Show input token count immediately if cached
    if (lastExtractedText) {
      const cachedTokens = estimateTokens(lastExtractedText);
      const estOut = Math.round(cachedTokens * 0.1);
      loadingTokensIn.textContent = `${cachedTokens.toLocaleString()} in`;
      loadingEstOut.textContent   = `est ~${estOut.toLocaleString()} out`;
      loadingSavings.textContent  = `-90%`;
      loadingStatus.textContent   = "compressing prose …";
    } else {
      loadingStatus.textContent = "extracting conversation …";
    }

    try {
      let extracted;
      if (lastExtractedText) {
        extracted = { success: true, text: lastExtractedText, platform: currentPlatformLabel.toLowerCase() };
      } else {
        await injectContentScript(tab.id);
        extracted = await extractWithTimeout();
      }

      if (!extracted?.success || !extracted.text || extracted.text.length < 50) {
        throw new Error("No conversation text found. Make sure you are in an active chat with messages.");
      }

      if (extracted.platform === "claude" && extracted.meta) {
        const { hasHuman, hasAssistant } = extracted.meta;
        if (!hasAssistant) {
          showError("Could not capture Claude's responses. The page may still be loading — please wait and try again.");
          return;
        }
        if (!hasHuman) {
          showError("Could not detect user messages in this conversation. Make sure you are on an active Claude chat.");
          return;
        }
      }

      const estimatedTokens = estimateTokens(extracted.text);
      if (estimatedTokens < 160) {
        showError(`Conversation too short (~${estimatedTokens} tokens). Need at least 160 tokens.`);
        return;
      }

      lastExtractedText = extracted.text;

      // Update loading footer with real numbers
      const estOut = Math.round(estimatedTokens * 0.1);
      loadingTokensIn.textContent = `${estimatedTokens.toLocaleString()} in`;
      loadingEstOut.textContent   = `est ~${estOut.toLocaleString()} out`;
      loadingSavings.textContent  = `-90%`;
      loadingStatus.textContent   = "compressing prose …";

      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "summarize", text: extracted.text, platform: (extracted.platform || currentPlatformLabel).toLowerCase() },
          (response) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          }
        );
      });

      if (!result.success) throw new Error(result.error || "Failed to generate summary.");

      logger.info("popup", "Summary done", { originalTokens: result.originalTokens, capsuleTokens: result.capsuleTokens });
      showResult(result);
    } catch (err) {
      logger.error("popup", "Summarize error", { message: err.message });
      showError(err.message || "An unexpected error occurred.");
    }
  }

  async function handleFullChat() {
    logger.info("popup", "Full chat clicked");
    showPage("transcript");

    // Use cached extraction if available — no skeleton flash
    if (lastExtractedText) {
      transcriptSkeleton.classList.add("hidden");
      showTranscript(lastExtractedText);
      return;
    }

    transcriptSkeleton.classList.remove("hidden");
    transcriptTextEl.classList.add("hidden");
    transcriptMeta.classList.add("hidden");

    try {
      await injectContentScript(tab.id);

      const extracted = await extractWithTimeout();

      if (!extracted?.success || !extracted.text || extracted.text.length < 50) {
        throw new Error("No conversation text found. Make sure you are in an active chat with messages.");
      }

      lastExtractedText = extracted.text;
      logger.info("popup", "Full chat extracted", { length: extracted.text.length });
      showTranscript(extracted.text);
    } catch (err) {
      logger.error("popup", "Full chat error", { message: err.message });
      showError(err.message || "An unexpected error occurred.");
    }
  }

  function extractWithTimeout() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Extraction timed out. Make sure the chat is fully loaded.")),
        12000
      );
      chrome.tabs.sendMessage(tab.id, { action: "extractConversation" }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  // ────────────────────────────────
  // Show helpers
  // ────────────────────────────────

  function showHome() {
    showPage("home");
    // Refresh active model label
    chrome.storage.local.get(["activeProvider", "providers"]).then((data) => {
      const provider = data.activeProvider || "worker";
      if (provider === "worker") {
        homeModelLabel.textContent = "shared worker";
      } else {
        const model = data.providers?.[provider]?.model || "";
        homeModelLabel.textContent = model || provider;
      }
    });
    cardTitle.textContent = currentPlatformLabel + " conversation";
    // Pre-extract transcript in background to populate counts + warm cache
    if (!lastExtractedText && tab?.id) {
      preloadTranscript();
    } else if (lastExtractedText) {
      updateCardMeta(lastExtractedText);
    }
  }

  async function preloadTranscript() {
    try {
      await injectContentScript(tab.id);
      const extracted = await extractWithTimeout();
      if (extracted?.success && extracted.text && extracted.text.length >= 50) {
        lastExtractedText = extracted.text;
        lastExtractTime = Date.now();
        updateCardMeta(extracted.text);
      }
    } catch (e) {
      console.warn("preload failed", e);
    }
  }

  function updateCardMeta(text) {
    const tokens = estimateTokens(text);
    const messageCount = countMessages(text);
    cardMessages.textContent = `${messageCount} messages`;
    cardTokens.textContent   = `~${formatTokens(tokens)} tokens`;
    transcriptCharHint.textContent = formatTokens(tokens) + "tk";
  }

  function countMessages(text) {
    // Heuristic: count [human]:/[assistant]: or User:/Assistant: markers, fallback to paragraph blocks
    const turnMarkers = text.match(/\b(human|user|assistant|model|ai)\s*[:\]]/gi);
    if (turnMarkers && turnMarkers.length >= 2) return turnMarkers.length;
    // Fallback: blocks separated by 2+ newlines
    return text.split(/\n{2,}/).filter((b) => b.trim().length > 20).length;
  }

  function formatTokens(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return n.toLocaleString();
  }

  function formatChars(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "kc";
    return n + "c";
  }

  function showResult(data) {
    showPage("result");
    resultText.value = data.capsule;
    const pct = data.originalTokens > 0
      ? Math.round((1 - data.capsuleTokens / data.originalTokens) * 100)
      : 0;
    resultSavings.textContent    = `-${pct}%`;
    resultTokensMain.textContent = data.capsuleTokens.toLocaleString();
    resultTokensFrom.textContent = `from ${data.originalTokens.toLocaleString()}`;
  }

  function showTranscript(text) {
    transcriptSkeleton.classList.add("hidden");
    transcriptTextEl.classList.remove("hidden");
    transcriptTextEl.value = text;
    const chars = text.length.toLocaleString();
    const words = Math.round(text.split(/\s+/).length).toLocaleString();
    transcriptChars.textContent = `${chars} chars`;
    transcriptWords.textContent = `${words} words`;
    transcriptMeta.classList.remove("hidden");
    const tokens = estimateTokens(text);
    transcriptCharHint.textContent = formatTokens(tokens) + "tk";
  }

  function showError(msg) {
    showPage("error");
    errorText.textContent = msg;
  }

  function resetProgress() {
    if (loadingFill) {
      loadingFill.style.animation = "none";
      loadingFill.offsetHeight; // reflow
      loadingFill.style.animation = "";
    }
    loadingTokensIn.textContent = "";
    loadingEstOut.textContent   = "";
    loadingSavings.textContent  = "";
  }

  function showPage(name) {
    Object.values(PAGES).forEach((p) => p.classList.add("hidden"));
    PAGES[name].classList.remove("hidden");
    // Back button: show on all pages except home and empty
    if (name === "home" || name === "empty") {
      backBtn.classList.add("hidden");
    } else {
      backBtn.classList.remove("hidden");
    }
  }

  function currentVisiblePage() {
    for (const [name, el] of Object.entries(PAGES)) {
      if (!el.classList.contains("hidden")) return name;
    }
    return "home";
  }

  // ────────────────────────────────
  // Settings
  // ────────────────────────────────

  const PROVIDER_CONFIGS = {
    worker:   { needsKey: false, needsUrl: false, defaultModels: [] },
    gemini:   { needsKey: true,  needsUrl: false, hint: "aistudio.google.com", defaultModels: ["gemma-4-26b-a4b-it", "gemini-2.5-flash", "gemini-2.5-flash-lite"] },
    openai:   { needsKey: true,  needsUrl: false, hint: "platform.openai.com", defaultUrl: "https://api.openai.com/v1", defaultModels: ["gpt-4.1-mini", "gpt-4.1", "gpt-4o"] },
    groq:     { needsKey: true,  needsUrl: false, hint: "console.groq.com",    defaultUrl: "https://api.groq.com/openai/v1", defaultModels: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
    lmstudio: { needsKey: false, needsUrl: true,  hint: "No key needed",       defaultUrl: "http://localhost:1234/v1", defaultModels: [] },
  };

  function applyProviderUI(provider, cfg) {
    const config = PROVIDER_CONFIGS[provider] || {};
    if (config.needsKey || config.needsUrl) {
      apiKeyRow.classList.remove("hidden");
      apiKeyHint.textContent = config.hint || "";
    } else {
      apiKeyRow.classList.add("hidden");
    }
    if (config.needsUrl) {
      baseUrlRow.classList.remove("hidden");
      if (!baseUrlInput.value) baseUrlInput.value = cfg?.baseUrl || config.defaultUrl || "";
    } else {
      baseUrlRow.classList.add("hidden");
    }
    if (provider === "worker") {
      modelRow.classList.add("hidden");
    } else {
      modelRow.classList.remove("hidden");
      populateDefaultModels(provider, cfg?.model);
    }
  }

  function populateDefaultModels(provider, selectedModel) {
    const config = PROVIDER_CONFIGS[provider] || {};
    modelSelect.innerHTML = "";
    config.defaultModels.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    });
    if (!config.defaultModels.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "Click Fetch to load models";
      modelSelect.appendChild(opt);
    }
    if (selectedModel) {
      if (!Array.from(modelSelect.options).find((o) => o.value === selectedModel)) {
        const opt = document.createElement("option");
        opt.value = selectedModel;
        opt.textContent = selectedModel;
        modelSelect.insertBefore(opt, modelSelect.firstChild);
      }
      modelSelect.value = selectedModel;
    } else if (config.defaultModels.length) {
      modelSelect.value = config.defaultModels[0];
    }
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(["activeProvider", "providers", "geminiApiKey", "selectedModel"]);
    if (!data.activeProvider && data.geminiApiKey) {
      const migrated = {
        activeProvider: "gemini",
        providers: { gemini: { apiKey: data.geminiApiKey, model: data.selectedModel || "gemma-4-26b-a4b-it" } },
      };
      await chrome.storage.local.set(migrated);
      await chrome.storage.local.remove(["geminiApiKey", "selectedModel"]);
      data.activeProvider = migrated.activeProvider;
      data.providers = migrated.providers;
      logger.info("popup", "Migrated legacy Gemini key");
    }
    const activeProvider = data.activeProvider || "worker";
    const providers = data.providers || {};
    const cfg = providers[activeProvider] || {};
    providerSelect.value  = activeProvider;
    apiKeyInput.value     = cfg.apiKey || "";
    baseUrlInput.value    = cfg.baseUrl || PROVIDER_CONFIGS[activeProvider]?.defaultUrl || "";
    applyProviderUI(activeProvider, cfg);
  }

  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value;
    apiKeyInput.value  = "";
    baseUrlInput.value = PROVIDER_CONFIGS[provider]?.defaultUrl || "";
    applyProviderUI(provider, null);
  });

  fetchModelsBtn.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const apiKey   = apiKeyInput.value.trim();
    const baseUrl  = baseUrlInput.value.trim() || PROVIDER_CONFIGS[provider]?.defaultUrl || "";
    fetchModelsBtn.disabled     = true;
    fetchModelsBtn.textContent  = "…";
    modelStatus.textContent     = "Fetching…";
    modelStatus.className       = "field-status";
    modelStatus.classList.remove("hidden");
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "fetchModels", provider, baseUrl, apiKey }, resolve);
    });
    fetchModelsBtn.disabled    = false;
    fetchModelsBtn.textContent = "Fetch";
    if (!result?.success) {
      modelStatus.textContent = result?.error || "Failed to fetch models.";
      modelStatus.className   = "field-status error";
      return;
    }
    modelSelect.innerHTML = "";
    result.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      modelSelect.appendChild(opt);
    });
    modelStatus.textContent = `${result.models.length} models loaded.`;
    modelStatus.className   = "field-status success";
    setTimeout(() => modelStatus.classList.add("hidden"), 3000);
  });

  function showKeyStatus(msg, type) {
    keyStatus.textContent = msg;
    keyStatus.className   = `key-status ${type}`;
    keyStatus.classList.remove("hidden");
    setTimeout(() => keyStatus.classList.add("hidden"), 3000);
  }

  saveKeysBtn.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const config   = PROVIDER_CONFIGS[provider] || {};
    const apiKey   = apiKeyInput.value.trim();
    const baseUrl  = (config.needsUrl && baseUrlInput.value.trim()) || config.defaultUrl || "";
    const model    = modelSelect.value;
    if (config.needsKey && !apiKey) { showKeyStatus("API key required.", "error"); return; }
    if (provider === "gemini" && apiKey && !apiKey.startsWith("AIza")) { showKeyStatus('Gemini key should start with "AIza".', "error"); return; }
    const stored    = await chrome.storage.local.get("providers");
    const providers = stored.providers || {};
    providers[provider] = { apiKey, baseUrl, model };
    await chrome.storage.local.set({ activeProvider: provider, providers });
    await chrome.storage.local.remove(["geminiApiKey", "selectedModel"]);
    logger.info("popup", "Settings saved", { provider, model });
    showKeyStatus("Settings saved.", "success");
  });

  clearKeysBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove(["activeProvider", "providers", "geminiApiKey", "selectedModel"]);
    providerSelect.value = "worker";
    apiKeyInput.value    = "";
    baseUrlInput.value   = "";
    applyProviderUI("worker", null);
    logger.info("popup", "Settings cleared");
    showKeyStatus("Cleared. Using shared Worker.", "success");
  });
});
