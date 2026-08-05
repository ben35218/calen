import { CommonActions } from '@react-navigation/native';

// A save that scopes to one occurrence — "Save for This Event Only" or "Save for
// Future Events" — does not write the record the form was opened on. It creates
// a NEW one (a detached override, or the forked series) and leaves the original
// excepted or truncated.
//
// That breaks plain `goBack()`. The detail screen sitting under the form is still
// bound to the ORIGINAL id and the original day, so returning to it shows the
// unedited event — and for an override it shows an occurrence the series no
// longer has at all. The user sees "my changes didn't save", then finds them on
// the month grid, which reads the store rather than a route param.
//
// So before leaving, rewrite that underlying entry to point at the new record.
// The form is dropped and the detail below it is replaced in one dispatch, which
// leaves Back going wherever it went before (the calendar), not to a stale copy.
//
// This always performs the exit — it pops the form whether or not there was a
// detail to rebind — so it REPLACES the caller's `goBack()` rather than
// preceding it. When the form was reached some other way (a month-cell
// long-press, the assistant), there is simply nothing below to rewrite and the
// pop is all that happens.
// Structural and deliberately `any` on the action: every stack navigator types
// `dispatch` against its own param list, and this helper is shared across three.
type Rebindable = { dispatch: (action: any) => void };

type StackState = { routes: { name: string; key: string; params?: object }[]; index: number };

// The delete counterpart, for the Delete button an edit form carries at its
// bottom. Deleting there destroys (or excepts an occurrence out of) the very
// record the detail screen below the form is bound to, so a plain `goBack()`
// lands the user on a page describing something that no longer exists. Drop
// both in one dispatch and land wherever the detail was opened from — the same
// place the detail screen's own Delete leaves them.
//
// Like rebindDetailBelow this REPLACES the caller's `goBack()`: with no detail
// underneath (the form reached from a calendar cell or the assistant) it is a
// plain pop.
export function popPastDetail(navigation: Rebindable, detailRouteName: string): void {
  navigation.dispatch((state: StackState) => {
    const withoutForm = state.routes.slice(0, -1);
    const below = withoutForm[withoutForm.length - 1];
    const routes = below?.name === detailRouteName ? withoutForm.slice(0, -1) : withoutForm;
    // A stack must keep a root: if popping the detail would empty it, keep the
    // detail (the form was that stack's whole history).
    const next = routes.length ? routes : withoutForm;
    if (!next.length) return CommonActions.reset(state);
    return CommonActions.reset({ ...state, routes: next, index: next.length - 1 });
  });
}

export function rebindDetailBelow(
  navigation: Rebindable,
  detailRouteName: string,
  params: Record<string, unknown>,
): void {
  navigation.dispatch((state: { routes: { name: string; key: string; params?: object }[]; index: number }) => {
    // Drop the form itself, then look at what it was pushed on top of.
    const routes = state.routes.slice(0, -1);
    const below = routes[routes.length - 1];
    if (below && below.name === detailRouteName) {
      routes[routes.length - 1] = {
        ...below,
        // A fresh key so the screen remounts against the new record instead of
        // reusing the mounted one's queries and occurrence state.
        key: `${detailRouteName}-${String(params.eventId ?? params.id ?? '')}-${Date.now()}`,
        params: { ...below.params, ...params },
      };
    }
    return CommonActions.reset({ ...state, routes, index: routes.length - 1 });
  });
}
