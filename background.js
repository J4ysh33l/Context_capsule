// background.js
// Receives extracted text from popup and routes to configured provider or shared Worker

importScripts('logger.js');

const WORKER_URL = 'https://contextcapsule-worker.contextcapsule-app.workers.dev/api/summarize';

const SYSTEM_INSTRUCTION =
  'You are a context compressor. Output a concise briefing. ' +
  'Write the briefing text directly. No bullet-point reasoning, no step-by-step analysis, no Draft: label. ' +
  'Just the final briefing, starting immediately.';

const BRIEFING_PROMPT = 'Summarize this conversation into a briefing:\n\n';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'summarize') {
    logger.info('background', 'Received summarize request', {
      textLength: message.text ? message.text.length : 0,
      platform: message.platform,
    });
    handleSummarize(message.text, message.platform).then(sendResponse);
    return true;
  }
  if (message.action === 'fetchModels') {
    fetchModels(message.provider, message.baseUrl, message.apiKey).then(sendResponse);
    return true;
  }
});

async function handleSummarize(conversationText, platform = 'chatgpt') {
  const stored = await chrome.storage.local.get(['activeProvider', 'providers', 'geminiApiKey', 'selectedModel']);

  const activeProvider = stored.activeProvider || (stored.geminiApiKey ? 'gemini' : null);
  const providers = stored.providers || {};

  if (activeProvider === 'gemini') {
    const apiKey = providers.gemini?.apiKey || stored.geminiApiKey;
    const model = providers.gemini?.model || stored.selectedModel || 'gemma-4-26b-a4b-it';
    logger.info('background', 'Routing to Gemini direct', { model });
    return callGeminiDirect(conversationText, apiKey, model);
  }

  if (['openai', 'groq', 'lmstudio'].includes(activeProvider)) {
    const cfg = providers[activeProvider] || {};
    logger.info('background', 'Routing to OpenAI-compatible provider', { provider: activeProvider, model: cfg.model });
    return callOpenAIDirect(conversationText, cfg.baseUrl, cfg.apiKey, cfg.model);
  }

  logger.info('background', 'Routing to shared Worker API', { platform });
  return callWorkerApi(conversationText, platform);
}

function estimateTokens(text) {
  return Math.round((text || '').length / 4);
}

function extractBriefing(text) {
  if (!text) return text;
  // Strip Gemini thinking-mode preamble: find last "Draft:" or "Summary:" marker and take everything after it
  const draftMatch = text.match(/\*{0,2}(?:Draft|Final answer|Summary|Briefing)\s*:\*{0,2}\s*/gi);
  if (draftMatch) {
    const lastMarker = draftMatch[draftMatch.length - 1];
    const idx = text.lastIndexOf(lastMarker);
    const extracted = text.slice(idx + lastMarker.length).trim();
    if (extracted.length > 100) return extracted;
  }
  return text;
}

async function callGeminiDirect(conversationText, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [{ parts: [{ text: BRIEFING_PROMPT + conversationText }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      logger.warn('background', 'Google AI API error', { status: response.status, error: data.error });
      let userMsg;
      const code = data.error?.code || response.status;
      const errMsg = data.error?.message || '';
      if (code === 400 && /API key/i.test(errMsg)) {
        userMsg = 'Invalid API key. Check it in Settings.';
      } else if (code === 403) {
        userMsg = 'API key rejected (permission denied). Check it in Settings.';
      } else if (code === 429) {
        userMsg = 'Quota exceeded on your key. Check Google AI Studio billing.';
      } else if (code === 404) {
        userMsg = `Model "${model}" not available on your key. Switch model in Settings.`;
      } else {
        userMsg = errMsg || `Google AI API error (${code}).`;
      }
      return { success: false, error: userMsg };
    }

    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return { success: false, error: 'API returned empty response.' };

    const capsule = extractBriefing(raw).trim();
    const originalTokens = data.usageMetadata?.promptTokenCount || estimateTokens(conversationText);
    const capsuleTokens = data.usageMetadata?.candidatesTokenCount || estimateTokens(capsule);
    logger.info('background', 'Gemini direct success', { originalTokens, capsuleTokens, model });

    return { success: true, capsule, originalTokens, capsuleTokens };
  } catch (err) {
    logger.error('background', 'Gemini fetch failed', { error: err.message });
    return { success: false, error: 'Could not reach Google AI API. Check connection.' };
  }
}

async function callOpenAIDirect(conversationText, baseUrl, apiKey, model) {
  const url = `${baseUrl}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTION },
          { role: 'user', content: BRIEFING_PROMPT + conversationText },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      logger.warn('background', 'OpenAI-compatible API error', { status: response.status, error: data.error });
      const code = response.status;
      let userMsg = data.error?.message || `API error (${code}).`;
      if (code === 401) userMsg = 'Invalid API key. Check it in Settings.';
      else if (code === 429) userMsg = 'Quota exceeded or rate limited. Check your account.';
      else if (code === 404) userMsg = `Model "${model}" not found. Fetch models and reselect.`;
      return { success: false, error: userMsg };
    }

    const raw = data.choices?.[0]?.message?.content;
    if (!raw) return { success: false, error: 'API returned empty response.' };

    const capsule = extractBriefing(raw).trim();
    const originalTokens = data.usage?.prompt_tokens || estimateTokens(conversationText);
    const capsuleTokens = data.usage?.completion_tokens || estimateTokens(capsule);
    logger.info('background', 'OpenAI-compatible success', { originalTokens, capsuleTokens, model });

    return { success: true, capsule, originalTokens, capsuleTokens };
  } catch (err) {
    logger.error('background', 'OpenAI-compatible fetch failed', { error: err.message });
    return { success: false, error: `Could not reach ${baseUrl}. Make sure it is running.` };
  }
}

async function fetchModels(provider, baseUrl, apiKey) {
  try {
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
      const data = await (await fetch(url)).json();
      if (data.error) return { success: false, error: data.error.message };
      const models = (data.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name }));
      return { success: true, models };
    }

    // OpenAI-compatible (openai, groq, lmstudio)
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const response = await fetch(`${baseUrl}/models`, { headers });
    const data = await response.json();
    if (!response.ok || data.error) return { success: false, error: data.error?.message || `Error (${response.status}).` };
    const models = (data.data || []).map((m) => ({ id: m.id, name: m.id }));
    return { success: true, models };
  } catch (err) {
    logger.error('background', 'fetchModels failed', { error: err.message });
    return { success: false, error: `Could not reach endpoint: ${err.message}` };
  }
}

async function callWorkerApi(conversationText, platform) {
  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationText,
        mode: 'dense',
        platform: platform || 'chatgpt',
      }),
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      logger.warn('background', 'Worker API returned an error', {
        status: response.status,
        error: data.error,
        message: data.message,
      });
      return { success: false, error: data.message || 'Worker API returned an error.' };
    }

    logger.info('background', 'Worker API success', {
      originalTokens: data.originalTokens,
      capsuleTokens: data.capsuleTokens,
    });

    return {
      success: true,
      capsule: data.capsule,
      originalTokens: data.originalTokens,
      capsuleTokens: data.capsuleTokens,
    };
  } catch (err) {
    logger.error('background', 'Network or fetch failure', { error: err.message });
    return {
      success: false,
      error: 'Could not reach the ContextCapsule API. Please check your internet connection and try again.',
    };
  }
}
