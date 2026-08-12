// Uppercases the first character of a typed value. The `sentences` keyboard
// hint only *suggests* a capital — the user can toggle shift off, and it does
// nothing when the OS-level auto-capitalization setting is disabled — so title
// fields that must start with a capital enforce it on the value itself. Same
// length in as out, so the caret never jumps in a controlled input.
export function capFirst(v: string): string {
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}
