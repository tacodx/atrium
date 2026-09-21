// A leaf module: storage keys only, no imports. session.ts writes the token
// under this key and api.ts reads it back at call time; both import it from
// here, so neither has to import the other for it (review M-4 — api.ts once
// took it from ./session while session.ts imports redeemHandoff from ./api,
// a static cycle). One spelling, two readers.
export const TOKEN_STORAGE_KEY = 'atrium.token'
