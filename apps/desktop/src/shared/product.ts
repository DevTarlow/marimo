/**
 * Facts about this product that more than one entry point needs.
 *
 * `PRODUCT_NAME` is load-bearing rather than cosmetic. Electron derives the
 * user-data directory from the `productName` in `package.json`, and the headless
 * job runner has no `app` object to ask — it works the same directory out from
 * the platform's rules and this name. If the two ever disagree, the window writes
 * one `jobs.json` and the background service reads another, finds nothing due,
 * and exits 0: a service that looks healthy and never runs anything.
 *
 * `tests/product-name.test.ts` asserts this constant, `package.json`'s
 * `productName` and the string the runner uses are all the same, because that
 * failure is otherwise silent.
 */
export const PRODUCT_NAME = 'Marimo Agent';

/** The environment variable that relocates all app state, for dev and tests. */
export const USER_DATA_ENV = 'MARIMO_USER_DATA_DIR';
