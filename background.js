// background.js
// Receives extracted text from popup and routes to user-keyed Gemini API or shared Worker

importScripts('logger.js');

const WORKER_URL = 'https://contextcapsule-worker.contextcapsule-app.workers.dev/api/summarize';

const BRIEFING_PROMPT =
  'Create a dense, token-efficient context briefing from this AI conversation. ' +
  'Preserve: key decisions, code, technical details, action items, and user intent. ' +
  'Use structured format with clear sections. Be concise but complete.\n\nConversation:\n';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'summarize') {
    logger.info('background', 'Received summarize request', {
      textLength: message.text ? message.text.length : 0,
      platform: message.platform,
    });
    handleSummarize(message.text, message.platform).then(sendResponse);
    return true; // Keep channel open for async response
  }
});

async function handleSummarize(conversationText, platform = 'chatgpt') {
  const stored = await chrome.storage.local.get(['geminiApiKey', 'selectedModel']);

  if (stored.geminiApiKey) {
    const model = stored.selectedModel || 'gemma-4-26b-a4b-it';
    logger.info('background', 'Routing to Google AI Studio direct', { model });
    return callGeminiDirect(conversationText, stored.geminiApiKey, model);
  }

  logger.info('background', 'Routing to shared Worker API', { platform });
  return callWorkerApi(conversationText, platform);
}

function estimateTokens(text) {
  return Math.round((text || '').length / 4);
}

async function callGeminiDirect(conversationText, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const prompt = BRIEFING_PROMPT + conversationText;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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

    const capsule = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!capsule) {
      return { success: false, error: 'API returned empty response.' };
    }

    const originalTokens = data.usageMetadata?.promptTokenCount || estimateTokens(conversationText);
    const capsuleTokens = data.usageMetadata?.candidatesTokenCount || estimateTokens(capsule);
    logger.info('background', 'Google AI direct success', { originalTokens, capsuleTokens, model });

    return { success: true, capsule: capsule.trim(), originalTokens, capsuleTokens };
  } catch (err) {
    logger.error('background', 'Google AI fetch failed', { error: err.message });
    return { success: false, error: 'Could not reach Google AI API. Check connection.' };
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
      return {
        success: false,
        error: data.message || 'Worker API returned an error.',
      };
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
