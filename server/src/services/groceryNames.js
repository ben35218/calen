// The implementation lives in the shared workspace (@household/grocery): the
// mobile app reconciles a saved organized list against the week's raw items by
// cleaned name, so the client and this server MUST clean names identically —
// one source of truth instead of two copies drifting apart.
module.exports = require('@household/grocery');
