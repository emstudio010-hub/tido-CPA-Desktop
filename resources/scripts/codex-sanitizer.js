// CPA Desktop Codex Prompt Sanitizer
// Intercepts competitor agent jailbreak prompts (e.g. "You are Codex, an agent based on GPT-5")
// that trigger Google Antigravity / Cloud Code upstream 429 RESOURCE_EXHAUSTED errors.

function sanitizeBody(bodyStr) {
  if (!bodyStr || typeof bodyStr !== 'string') return bodyStr;

  if (bodyStr.indexOf('an agent based on GPT-') !== -1) {
    bodyStr = bodyStr.replace(/an agent based on GPT-[a-zA-Z0-9.-]+/g, 'an advanced coding agent');
    console.log('[codex-sanitizer] Sanitized competitor prompt signature (GPT-x -> advanced coding agent)');
  }
  return bodyStr;
}

function on_before_request(ctx) {
  if (ctx && ctx.body) {
    ctx.body = sanitizeBody(ctx.body);
  }
  return ctx;
}

function on_after_auth_request(ctx) {
  if (ctx && ctx.body) {
    ctx.body = sanitizeBody(ctx.body);
  }
  return ctx;
}
