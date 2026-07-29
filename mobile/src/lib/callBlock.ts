// Do-not-call state for Calen's outbound calls, shared by the two screens that
// surface it: the Event Action screen (blocks the call button before placing)
// and the Interaction/outcome view (explains why a number was suppressed). The
// suppression itself is platform-wide and server-side (see the server's
// services/dnc.js); these are just the user-facing strings + the block decision.
// Behavior spec: specs/features/ai-assistant.md (do-not-call).

// Shown on the Event Action screen when the business number is suppressed — the
// call can't be placed, so the button is disabled and this says why.
export const DNC_BLOCK_MESSAGE =
  'This business asked not to receive automated calls, so Calen can’t call this number. You can still reach them yourself using the number on the event.';

// Shown on a call's outcome (Interaction) view when the recipient asked, on that
// call, not to be called again — so the user knows why no future call will go out.
export const DNC_CAPTURED_NOTICE =
  'This business asked not to receive automated calls. Calen won’t call this number again.';

// Whether the call button should be blocked. Undefined = the check is still in
// flight (or has no number to check): don't block, so the button stays live and
// the server's do-not-call gate remains the backstop. Only a definite `true`
// blocks — a probe that couldn't answer must not strand the user.
export function isCallBlockedBySuppression(suppressed: boolean | undefined): boolean {
  return suppressed === true;
}
