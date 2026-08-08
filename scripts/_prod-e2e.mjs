/**
 * Disabled by design: this formerly minted a browser cookie and wrote directly
 * to the judged production demo event. Signed server-only sessions make that
 * impossible, and any future production mutation test needs an operator-owned,
 * server-validated one-time gate plus an announced reset window.
 */
console.error("Production mutation E2E is disabled. Use read-only prod-verify and scratch smoke tests.");
process.exit(2);
