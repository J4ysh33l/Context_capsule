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
  const modelSelect = document.getElementById("model-select");
  const geminiKeyInput = document.getElementById("gemini-key-input");
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
  async function loadSettings() {
    const data = await chrome.storage.local.get([
      "geminiApiKey",
      "selectedModel",
    ]);
    if (data.geminiApiKey) geminiKeyInput.value = data.geminiApiKey;
    modelSelect.value = data.selectedModel || "gemma-4-26b-a4b-it";
  }

  function showKeyStatus(msg, type) {
    keyStatus.textContent = msg;
    keyStatus.className = `key-status ${type}`;
    setTimeout(() => keyStatus.classList.add("hidden"), 3000);
  }

  settingsBtn.addEventListener("click", () => {
    hideAll();
    settingsSection.classList.remove("hidden");
    loadSettings();
  });

  settingsBackBtn.addEventListener("click", () => {
    hideAll();
    readySection.classList.remove("hidden");
  });

  saveKeysBtn.addEventListener("click", async () => {
    const geminiKey = geminiKeyInput.value.trim();
    const model = modelSelect.value;

    if (!geminiKey) {
      showKeyStatus("API key required.", "error");
      return;
    }
    if (!geminiKey.startsWith("AIza")) {
      showKeyStatus('Key should start with "AIza".', "error");
      return;
    }

    await chrome.storage.local.set({
      geminiApiKey: geminiKey,
      selectedModel: model,
    });
    logger.info("popup", "Settings saved", { model });
    showKeyStatus("Settings saved.", "success");
  });

  clearKeysBtn.addEventListener("click", async () => {
    await chrome.storage.local.remove(["geminiApiKey", "selectedModel"]);
    geminiKeyInput.value = "";
    modelSelect.value = "gemma-4-26b-a4b-it";
    logger.info("popup", "Settings cleared");
    showKeyStatus("Cleared. Falling back to shared Worker API.", "success");
  });
});
