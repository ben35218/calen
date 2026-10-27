// Production feature switches read from the environment at request time (not
// at module load), so a test can flip one without rebuilding the app.
//
// AI_CALLS_ENABLED — assistant phone calls (Vapi). The whole feature — the
// `/api/calls` routes, the calendar chat's call_business / check_call_status
// tools and the prompt text that advertises them, and the published
// `callPerMinute` price on `/billing/status` — exists only when this is set to
// a truthy value ('1' / 'true' / 'yes'). It is UNSET in production, so the
// store build never offers calling (spec: ai-assistant.md → Phone calls →
// "Production switch"). Clients mirror the state from `/billing/status`
// `features.aiCalls` and hide every call surface when it's false.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function aiCallsEnabled() {
  return TRUTHY.has(String(process.env.AI_CALLS_ENABLED || '').trim().toLowerCase());
}

// Express guard for the calls router: 404 (not 403) when the feature is off —
// the routes don't exist in this deployment, which is also what an old client
// build that still knows the paths should see.
function requireAiCalls(req, res, next) {
  if (!aiCallsEnabled()) {
    return res.status(404).json({ error: 'Assistant phone calls are not available.' });
  }
  next();
}

module.exports = { aiCallsEnabled, requireAiCalls };
