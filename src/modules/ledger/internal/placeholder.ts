// Internal ledger detail — NOT part of the public port.
//
// Importing this file from another module must fail lint
// (boundaries/entry-point): other modules may only reach `ledger` through
// `src/modules/ledger/index.ts`. This placeholder exists so that rule is
// exercised by a real internal path.
export const LEDGER_INTERNAL_MARKER = "internal" as const;
