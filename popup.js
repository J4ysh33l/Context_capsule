document.addEventListener("DOMContentLoaded", async () => {
  const wrongPageSection = document.getElementById("wrong-page-section");
  const readySection = document.getElementById("ready-section");
  const statusSection = document.getElementById("status-section");
  const statusText = document.getElementById("status-text");
  const errorSection = document.getElementById("error-section");
  const errorText = document.getElementById("error-text");
  const resultSection = document.getElementById("result-section");
  const resultText = document.getElementById("result-text");
  const summarizeBtn = document.getElementById("summarize-btn");
  const btnText = document.getElementById("btn-text");
  const btnLoader = document.getElementById("btn-loader");
  const copyBtn = document.getElementById("copy-btn");
  const copyBtnText = document.getElementById("copy-text");
  const retryBtn = document.getElementById("retry-btn");
  const newBtn = document.getElementById("new-btn");
  const originalTokensEl = document.getElementById("original-tokens");
  const capsuleTokensEl = document.getElementById("capsule-tokens");
  const savingsEl = document.getElementById("savings");

  // Settings elements
  const settingsBtn = document.getElementById("settings-btn");
  const settingsSection = document.getElementById("settings-section");
  const settingsBackBtn = document.getElementById("settings-back-btn");
  const providerSelect = document.getElementById("provider-select");
  const apiKeyRow = document.getElementById("api-key-row");
  const apiKeyInput = document.getElementById("api-key-input");
  const apiKeyHint = document.getElementById("api-key-hint");
  const baseUrlRow = document.getElementById("base-url-row");
  const baseUrlInput = document.getElementById("base-url-input");
  const modelRow = document.getElementById("model-row");
  const modelSelect = document.getElementById("model-select");
  const fetchModelsBtn = document.getElementById("fetch-models-btn");
  const modelStatus = document.getElementById("model-status");
  const saveKeysBtn = document.getElementById("save-keys-btn");
  const clearKeysBtn = document.getElementById("clear-keys-btn");
  const keyStatus = document.getElementById("key-status");

  // Full chat elements
  const fullChatBtn = document.getElementById("full-chat-btn");
  const fullChatBtnText = document.getElementById("full-chat-btn-text");
  const fullChatLoader = document.getElementById("full-chat-loader");
  const fullChatSection = document.getElementById("full-chat-section");
  const fullChatText = document.getElementById("full-chat-text");
  const fullChatCharCount = document.getElementById("full-chat-char-count");
  const copyChatBtn = document.getElementById("copy-chat-btn");
  const copyChatText = document.getElementById("copy-chat-text");
  const downloadChatBtn = document.getElementById("download-chat-btn");
  const backBtn = document.getElementById("back-btn");

  // Check if current tab is a supported page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url || "";
  const isChatGPT = tabUrl.includes("chatgpt.com");
  const isClaude = tabUrl.includes("claude.ai");
  const isDeepSeek = tabUrl.includes("chat.deepseek.com");
  const isGrok =
    tabUrl.includes("grok.com") ||
    (tabUrl.includes("x.com") && tabUrl.includes("/grok"));
  const isGemini = tabUrl.includes("gemini.google.com");
  const isSupported = isChatGPT || isClaude || isDeepSeek || isGrok || isGemini;

  const platformLabel = isClaude
    ? "Claude"
    : isDeepSeek
      ? "DeepSeek"
      : isGrok
        ? "Grok"
        : isGemini
          ? "Gemini"
          : "ChatGPT";

  if (!isSupported) {
    logger.warn("popup", "Unsupported page", { url: tabUrl });
    wrongPageSection.classList.remove("hidden");
    return;
  }

  logger.info("popup", "Platform detected and supported", {
    platform: platformLabel,
    url: tabUrl,
  });
  readySection.classList.remove("hidden");
  btnText.textContent = `Summarize ${platformLabel} Conversation`;

  // Summarize button click
  async function handleSummarize() {
    logger.info("popup", "Summarize button clicked", {
      platform: platformLabel,
    });
    hideAll();
    showStatus("Extracting conversation...");

    try {
      // Inject logger and content script into the active tab
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["logger.js", "content.js"],
      });

      // Request extraction
      const extractionResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "No conversation detected or extraction timed out. Please make sure the chat has messages and is fully loaded.",
              ),
            ),
          20000,
        );

        chrome.tabs.sendMessage(
          tab.id,
          { action: "extractConversation" },
          (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          },
        );
      });

      if (
        !extractionResult?.success ||
        !extractionResult.text ||
        extractionResult.text.length < 50
      ) {
        throw new Error(
          "No conversation text found. Make sure you are in an active chat with messages.",
        );
      }

      logger.info("popup", "Extraction successful", {
        textLength: extractionResult.text.length,
        platform: extractionResult.platform || platformLabel,
      });

      if (extractionResult.platform === "claude" && extractionResult.meta) {
        const { hasHuman, hasAssistant } = extractionResult.meta;
        if (!hasAssistant) {
          logger.error("popup", "Claude validation failed — no assistant turns", { hasHuman, hasAssistant });
          showError(
            "Could not capture Claude's responses. The page may still be loading — please wait and try again.",
          );
          return;
        }
        if (!hasHuman) {
          logger.warn("popup", "Claude validation — no human turns", { hasHuman, hasAssistant });
          showError(
            "Could not detect user messages in this conversation. Make sure you are on an active Claude chat.",
          );
          return;
        }
      }

      // Pre-flight token check — estimate tokens (chars ÷ 4) before hitting the API
      const MIN_TOKENS = 160;
      const estimatedTokens = Math.round(extractionResult.text.length / 4);
      if (estimatedTokens < MIN_TOKENS) {
        logger.warn("popup", "Conversation too short to summarise", {
          estimatedTokens,
        });
        showError(
          `This conversation is too short to summarise (~${estimatedTokens} tokens). ` +
            `Please try again with a longer conversation (at least ${MIN_TOKENS} tokens).`,
        );
        return;
      }

      showStatus("Generating context briefing...");

      // Send to worker
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            action: "summarize",
            text: extractionResult.text,
            platform: (
              extractionResult.platform || platformLabel
            ).toLowerCase(),
          },
          (response) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          },
        );
      });

      if (!result.success) {
        throw new Error(result.error || "Failed to generate summary.");
      }

      logger.info("popup", "Summary generation successful", {
        originalTokens: result.originalTokens,
        capsuleTokens: result.capsuleTokens,
      });
      showResult(result);
    } catch (err) {
      logger.error("popup", "Error during summarization", {
        message: err.message,
        stack: err.stack,
      });
      showError(err.message || "An unexpected error occurred.");
    }
  }

  summarizeBtn.addEventListener("click", handleSummarize);
  retryBtn.addEventListener("click", handleSummarize);
  newBtn.addEventListener("click", () => {
    hideAll();
    readySection.classList.remove("hidden");
  });

  // Full Chat button
  fullChatBtn.addEventListener("click", handleFullChat);

  // Back button (from full chat view)
  backBtn.addEventListener("click", () => {
    hideAll();
    readySection.classList.remove("hidden");
  });

  // Copy briefing button
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(resultText.value).then(() => {
      copyBtn.classList.add("copied");
      copyBtnText.textContent = "Copied!";
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtnText.textContent = "Copy Briefing";
      }, 2000);
    });
  });

  // Copy full chat button
  copyChatBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(fullChatText.value).then(() => {
      copyChatBtn.classList.add("copied");
      copyChatText.textContent = "✓ Copied!";
      setTimeout(() => {
        copyChatBtn.classList.remove("copied");
        copyChatText.textContent = "📋 Copy to Clipboard";
      }, 2000);
    });
  });

  // Download full chat button
  downloadChatBtn.addEventListener("click", () => {
    const blob = new Blob([fullChatText.value], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${platformLabel.toLowerCase()}-conversation.txt`;
    a.click();
    URL.revokeObjectURL(url);
    downloadChatBtn.classList.add("downloaded");
    downloadChatBtn.querySelector("span").textContent = "✓ Downloaded!";
    setTimeout(() => {
      downloadChatBtn.classList.remove("downloaded");
      downloadChatBtn.querySelector("span").textContent = "⬇ Download .txt";
    }, 2000);
  });

  // Extract raw conversation and show full chat
  async function handleFullChat() {
    logger.info("popup", "Full Chat button clicked", {
      platform: platformLabel,
    });
    fullChatBtnText.textContent = "Extracting...";
    fullChatLoader.classList.remove("hidden");
    fullChatBtn.disabled = true;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["logger.js", "content.js"],
      });

      const extractionResult = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            reject(
              new Error(
                "No conversation detected or extraction timed out. Please make sure the chat has messages and is fully loaded.",
              ),
            ),
          20000,
        );
        chrome.tabs.sendMessage(
          tab.id,
          { action: "extractConversation" },
          (response) => {
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          },
        );
      });

      if (
        !extractionResult?.success ||
        !extractionResult.text ||
        extractionResult.text.length < 50
      ) {
        throw new Error(
          "No conversation text found. Make sure you are in an active chat with messages.",
        );
      }

      logger.info("popup", "Full chat extraction successful", {
        textLength: extractionResult.text.length,
      });
      showFullChat(extractionResult.text);
    } catch (err) {
      logger.error("popup", "Full chat extraction error", {
        message: err.message,
      });
      showError(err.message || "An unexpected error occurred.");
    } finally {
      fullChatBtnText.textContent = "View Full Chat";
      fullChatLoader.classList.add("hidden");
      fullChatBtn.disabled = false;
    }
  }

  function showFullChat(text) {
    hideAll();
    fullChatSection.classList.remove("hidden");
    fullChatText.value = text;
    const chars = text.length.toLocaleString();
    const approxWords = Math.round(text.split(/\s+/).length).toLocaleString();
    fullChatCharCount.textContent = `${chars} chars · ${approxWords} words`;
  }

  function showStatus(text) {
    hideAll();
    statusSection.classList.remove("hidden");
    statusText.textContent = text;
  }

  function showError(msg) {
    hideAll();
    errorSection.classList.remove("hidden");
    errorText.textContent = msg;
  }

  function showResult(data) {
    hideAll();
    resultSection.classList.remove("hidden");
    resultText.value = data.capsule;
    originalTokensEl.textContent = data.originalTokens.toLocaleString();
    capsuleTokensEl.textContent = data.capsuleTokens.toLocaleString() + " tks";
    const pct =
      data.originalTokens > 0
        ? Math.round((1 - data.capsuleTokens / data.originalTokens) * 100)
        : 0;
    savingsEl.textContent = `-${pct}%`;
  }

  function hideAll() {
    wrongPageSection.classList.add("hidden");
    readySection.classList.add("hidden");
    statusSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    resultSection.classList.add("hidden");
    fullChatSection.classList.add("hidden");
    settingsSection.classList.add("hidden");
  }

  // ───── Settings ─────

  const PROVIDER_CONFIGS = {
    worker:   { needsKey: false, needsUrl: false, defaultModels: [] },
    gemini:   { needsKey: true,  needsUrl: false, hint: 'Get key at aistudio.google.com', defaultModels: ['gemma-4-26b-a4b-it', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] },
    openai:   { needsKey: true,  needsUrl: false, hint: 'Get key at platform.openai.com', defaultUrl: 'https://api.openai.com/v1', defaultModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o'] },
    groq:     { needsKey: true,  needsUrl: false, hint: 'Get key at console.groq.com',   defaultUrl: 'https://api.groq.com/openai/v1', defaultModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] },
    lmstudio: { needsKey: false, needsUrl: true,  hint: 'No key needed for local',        defaultUrl: 'http://localhost:1234/v1', defaultModels: [] },
  };

  function applyProviderUI(provider, cfg) {
    const config = PROVIDER_CONFIGS[provider] || {};
    // API key row
    if (config.needsKey) {
      apiKeyRow.classList.remove('hidden');
      apiKeyHint.textContent = config.hint || '';
    } else if (config.needsUrl) {
      apiKeyRow.classList.remove('hidden');
      apiKeyHint.textContent = config.hint || '';
    } else {
      apiKeyRow.classList.add('hidden');
    }
    // Base URL row
    if (config.needsUrl) {
      baseUrlRow.classList.remove('hidden');
      if (!baseUrlInput.value) baseUrlInput.value = cfg?.baseUrl || config.defaultUrl || '';
    } else {
      baseUrlRow.classList.add('hidden');
    }
    // Model row
    if (provider === 'worker') {
      modelRow.classList.add('hidden');
    } else {
      modelRow.classList.remove('hidden');
      populateDefaultModels(provider, cfg?.model);
    }
  }

  function populateDefaultModels(provider, selectedModel) {
    const config = PROVIDER_CONFIGS[provider] || {};
    modelSelect.innerHTML = '';
    config.defaultModels.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      modelSelect.appendChild(opt);
    });
    if (!config.defaultModels.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Click Fetch to load models';
      modelSelect.appendChild(opt);
    }
    if (selectedModel) {
      // ensure selected model is in list (may be fetched model not in defaults)
      if (!Array.from(modelSelect.options).find((o) => o.value === selectedModel)) {
        const opt = document.createElement('option');
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
    const data = await chrome.storage.local.get(['activeProvider', 'providers', 'geminiApiKey', 'selectedModel']);

    // Migrate legacy keys
    if (!data.activeProvider && data.geminiApiKey) {
      const migrated = {
        activeProvider: 'gemini',
        providers: { gemini: { apiKey: data.geminiApiKey, model: data.selectedModel || 'gemma-4-26b-a4b-it' } },
      };
      await chrome.storage.local.set(migrated);
      await chrome.storage.local.remove(['geminiApiKey', 'selectedModel']);
      data.activeProvider = migrated.activeProvider;
      data.providers = migrated.providers;
      logger.info('popup', 'Migrated legacy Gemini key to new provider schema');
    }

    const activeProvider = data.activeProvider || 'worker';
    const providers = data.providers || {};
    const cfg = providers[activeProvider] || {};

    providerSelect.value = activeProvider;
    apiKeyInput.value = cfg.apiKey || '';
    baseUrlInput.value = cfg.baseUrl || PROVIDER_CONFIGS[activeProvider]?.defaultUrl || '';
    applyProviderUI(activeProvider, cfg);
  }

  providerSelect.addEventListener('change', () => {
    const provider = providerSelect.value;
    apiKeyInput.value = '';
    baseUrlInput.value = PROVIDER_CONFIGS[provider]?.defaultUrl || '';
    applyProviderUI(provider, null);
  });

  fetchModelsBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = baseUrlInput.value.trim() || PROVIDER_CONFIGS[provider]?.defaultUrl || '';

    fetchModelsBtn.disabled = true;
    fetchModelsBtn.textContent = '...';
    modelStatus.textContent = 'Fetching models...';
    modelStatus.className = 'settings-hint';
    modelStatus.classList.remove('hidden');

    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'fetchModels', provider, baseUrl, apiKey }, resolve);
    });

    fetchModelsBtn.disabled = false;
    fetchModelsBtn.textContent = 'Fetch';

    if (!result?.success) {
      modelStatus.textContent = result?.error || 'Failed to fetch models.';
      modelStatus.className = 'settings-hint error';
      return;
    }

    modelSelect.innerHTML = '';
    result.models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      modelSelect.appendChild(opt);
    });
    modelStatus.textContent = `${result.models.length} model(s) loaded.`;
    modelStatus.className = 'settings-hint success';
    setTimeout(() => modelStatus.classList.add('hidden'), 3000);
    logger.info('popup', 'Models fetched', { provider, count: result.models.length });
  });

  function showKeyStatus(msg, type) {
    keyStatus.textContent = msg;
    keyStatus.className = `key-status ${type}`;
    setTimeout(() => keyStatus.classList.add('hidden'), 3000);
  }

  settingsBtn.addEventListener('click', () => {
    hideAll();
    settingsSection.classList.remove('hidden');
    loadSettings();
  });

  settingsBackBtn.addEventListener('click', () => {
    hideAll();
    readySection.classList.remove('hidden');
  });

  saveKeysBtn.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const config = PROVIDER_CONFIGS[provider] || {};
    const apiKey = apiKeyInput.value.trim();
    const baseUrl = (config.needsUrl && baseUrlInput.value.trim()) || config.defaultUrl || '';
    const model = modelSelect.value;

    if (config.needsKey && !apiKey) {
      showKeyStatus('API key required.', 'error');
      return;
    }
    if (provider === 'gemini' && apiKey && !apiKey.startsWith('AIza')) {
      showKeyStatus('Gemini key should start with "AIza".', 'error');
      return;
    }

    const stored = await chrome.storage.local.get('providers');
    const providers = stored.providers || {};
    providers[provider] = { apiKey, baseUrl, model };

    await chrome.storage.local.set({ activeProvider: provider, providers });
    // Remove legacy keys to prevent migration conflicts
    await chrome.storage.local.remove(['geminiApiKey', 'selectedModel']);
    logger.info('popup', 'Settings saved', { provider, model });
    showKeyStatus('Settings saved.', 'success');
  });

  clearKeysBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['activeProvider', 'providers', 'geminiApiKey', 'selectedModel']);
    providerSelect.value = 'worker';
    apiKeyInput.value = '';
    baseUrlInput.value = '';
    applyProviderUI('worker', null);
    logger.info('popup', 'Settings cleared');
    showKeyStatus('Cleared. Using shared Worker API.', 'success');
  });
});
