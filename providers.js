/**
 * providers.js — multi-provider LLM API layer.
 *
 * Pulled out of app.js so this file is, like bkt.js, a standalone module
 * with zero dependency on the DOM or on Mentora's app state: every function
 * here takes the provider id / API key / prompt it needs as plain
 * arguments and returns plain text or throws, instead of reaching into a
 * global `state` or `els`. Everything is wrapped in an IIFE and exposed as
 * a single `LLM` namespace (same pattern as Spaced in spaced.js) so it
 * can't collide with app.js's own function names — app.js wires it to the
 * UI with two small `callLLM`/`callLLMForJson` wrappers (see the "LLM
 * dispatcher" section there) that supply the current provider/key and an
 * onRetry callback for the loading overlay.
 *
 * Supports four providers behind one interface (callLLM/callLLMForJson):
 * Anthropic Claude, Google Gemini, DeepSeek, and GitHub Models. Gemini is
 * the default (free tier, no card, no expiration); the others exist as
 * fallbacks for when a free tier's per-minute rate limit gets hit mid-lesson.
 */

const LLM = (() => {
  const PROVIDERS = {
    gemini: {
      label: "Gemini",
      keyLabel: "Gemini API key (stored only in your browser) — get one free at aistudio.google.com/apikey",
      placeholder: "paste your Gemini API key",
    },
    claude: {
      label: "Claude",
      keyLabel: "Claude API key (stored only in your browser) — console.anthropic.com",
      placeholder: "sk-ant-...",
    },
    deepseek: {
      label: "DeepSeek",
      keyLabel: "DeepSeek API key (stored only in your browser) — platform.deepseek.com/api_keys",
      placeholder: "sk-...",
    },
    github: {
      label: "GitHub Models",
      keyLabel: "GitHub personal access token with 'models: read' scope (stored only in your browser) — github.com/settings/tokens",
      placeholder: "ghp_... or github_pat_...",
    },
  };

  /** Routes to whichever provider is selected. All four return plain response text. */
  async function callLLM(provider, apiKey, prompt, maxTokens = 1500, onRetry) {
    return withRetry(
      () => {
        if (provider === "gemini") return callGemini(apiKey, prompt, maxTokens);
        if (provider === "deepseek") return callDeepSeek(apiKey, prompt, maxTokens);
        if (provider === "github") return callGitHubModels(apiKey, prompt, maxTokens);
        return callClaude(apiKey, prompt, maxTokens);
      },
      { onRetry }
    );
  }

  /**
   * Retries a rate-limited (429) call with exponential backoff. Course
   * generation makes several LLM calls back-to-back (concept extraction, then
   * one call per concept) — free-tier keys can cap requests per minute (Gemini's
   * free tier has been seen as low as 5 req/min on some models), so a single
   * 429 partway through would otherwise abort the whole lesson instead of just
   * pausing briefly. Only 429s are retried; any other error fails immediately.
   * `onRetry(delayMs)`, if given, is called before each wait — app.js uses it
   * to surface the wait on the loading overlay without this file touching the
   * DOM directly.
   */
  async function withRetry(fn, { retries = 3, baseDelayMs = 4000, onRetry } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const is429 = /\b429\b/.test(err.message) || /RESOURCE_EXHAUSTED/.test(err.message);
        if (!is429 || attempt >= retries) throw err;
        const delay = baseDelayMs * 2 ** attempt;
        if (onRetry) onRetry(delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async function callClaude(apiKey, prompt, maxTokens = 1500) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text;
  }

  /**
   * Google Gemini API (free tier: no card required, no expiration, ~1500 req/day
   * on Flash models as of mid-2026). Get a key at https://aistudio.google.com/apikey
   *
   * NOTE: Google's specific model versions get deprecated/restricted to new
   * users on a rolling basis (e.g. gemini-2.0-flash, then gemini-2.5-flash both
   * stopped working for new accounts in 2026). We use the "gemini-flash-latest"
   * alias, which Google always points at its current default Flash model, so
   * this stays working across future model releases without code changes.
   */
  async function callGemini(apiKey, prompt, maxTokens = 1500) {
    const model = "gemini-flash-latest";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Newer Gemini Flash models "think" before answering by default, and
        // that internal reasoning counts against maxOutputTokens — with a low
        // budget (800-1500) the thinking alone can exhaust it, leaving zero
        // tokens for the actual answer. thinkingBudget: 0 disables that, and
        // we give extra headroom on maxOutputTokens as a safety margin.
        generationConfig: {
          maxOutputTokens: Math.max(maxTokens, 2048),
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason;
      throw new Error(`Gemini returned no text${reason ? ` (finishReason: ${reason})` : ""} — try again, or try shorter material`);
    }
    return text;
  }

  /**
   * Shared request/response handling for the two OpenAI-compatible chat-
   * completions providers (DeepSeek, GitHub Models) — same endpoint shape,
   * same `choices[0].message.content` response, differing only in URL, model
   * id, auth header, and a couple of provider-specific body fields.
   */
  async function callOpenAICompatible({ url, apiKey, model, prompt, maxTokens, extraHeaders = {}, extraBody = {}, errorLabel }) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.7,
        ...extraBody,
      }),
    });
    if (!res.ok) throw new Error(`${errorLabel} API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(`${errorLabel} returned no text — try again, or try shorter material`);
    return text;
  }

  /**
   * DeepSeek API — OpenAI-compatible chat completions endpoint (api.deepseek.com).
   * New accounts get a one-time 5M free token grant (30-day window, no card
   * required), then cheap pay-as-you-go pricing — a good fallback when a
   * Gemini free-tier key hits its per-minute rate limit mid-lesson.
   * Get a key at platform.deepseek.com/api_keys.
   */
  async function callDeepSeek(apiKey, prompt, maxTokens = 1500) {
    return callOpenAICompatible({
      url: "https://api.deepseek.com/chat/completions",
      apiKey,
      model: "deepseek-v4-flash",
      prompt,
      maxTokens,
      // Thinking mode defaults to on and spends extra tokens on chain-of-thought
      // we don't need for structured JSON extraction/generation — disabling it
      // keeps responses fast and cheap, same rationale as Gemini's
      // thinkingBudget: 0 above.
      extraBody: { thinking: { type: "disabled" }, stream: false },
      errorLabel: "DeepSeek",
    });
  }

  /**
   * GitHub Models API — free, rate-limited inference tied to a GitHub personal
   * access token (`models: read` scope) rather than a separate account or
   * top-up balance. There's no balance to run dry, unlike DeepSeek's
   * grant-based free tier — a good fallback when another provider's free tier
   * is rate-limited or out of credit. Uses gpt-4o-mini, one of the more
   * generously-limited "low" tier models (15 req/min, 150/day on a free
   * GitHub account) rather than a "high" tier reasoning model, to avoid
   * repeating the same rate-limit problem. Get a token at
   * github.com/settings/personal-access-tokens/new.
   */
  async function callGitHubModels(apiKey, prompt, maxTokens = 1500) {
    return callOpenAICompatible({
      url: "https://models.github.ai/inference/chat/completions",
      apiKey,
      model: "openai/gpt-4o-mini",
      prompt,
      maxTokens,
      extraHeaders: { accept: "application/vnd.github+json" },
      errorLabel: "GitHub Models",
    });
  }

  function extractJson(text) {
    const match = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON found in model response");
    return JSON.parse(match[0]);
  }

  /**
   * Calls the LLM and parses its response as JSON, retrying with a FRESH
   * generation (a new sample, not just a backoff wait like withRetry's 429
   * handling) if the output isn't valid JSON. Smaller/faster models — seen in
   * practice with GitHub Models' gpt-4o-mini — are more prone than
   * Gemini/Claude to truncating an array mid-response or dropping a comma.
   * Since sampling is non-deterministic, a clean retry frequently just works
   * where the first attempt produced malformed JSON.
   */
  async function callLLMForJson(provider, apiKey, prompt, maxTokens = 1500, retries = 2, onRetry) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const text = await callLLM(provider, apiKey, prompt, maxTokens, onRetry);
      try {
        return extractJson(text);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(`Model response wasn't valid JSON after ${retries + 1} attempt(s): ${lastErr.message}`);
  }

  return {
    PROVIDERS,
    callLLM,
    withRetry,
    callClaude,
    callGemini,
    callOpenAICompatible,
    callDeepSeek,
    callGitHubModels,
    extractJson,
    callLLMForJson,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = LLM;
} else if (typeof window !== "undefined") {
  window.LLM = LLM;
}
