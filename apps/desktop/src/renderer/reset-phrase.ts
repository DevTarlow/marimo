/**
 * The words that arm the reset button, in one place.
 *
 * A phrase rather than a second "are you sure?" dialog, because this is the one
 * action in the app that cannot be undone and a dialog is a click people learn
 * to make. Typing it is not — and it is a phrase rather than a single word so it
 * cannot be reached by leaning on the keyboard.
 *
 * It lives here rather than inside the component for the reason `first-run.ts`
 * does: this package has no DOM test environment, so the decision is separated
 * from the drawing and gets a test. The component renders `RESET_PHRASE` and
 * compares against `armsReset`, so the words on screen and the words that arm
 * the button are the same string and cannot drift into a button that asks for
 * something nobody can type.
 */
export const RESET_PHRASE = 'reset everything';

/**
 * Whether what somebody typed is the phrase.
 *
 * Case and the whitespace around it are forgiven — a phrase that refuses to arm
 * because of a trailing space is a bug report, not a warning. Everything else is
 * not: a prefix (`reset`) or a phrase with a word appended is refused, which is
 * the half that matters, because a check that accepted a prefix would arm on the
 * first word somebody typed.
 */
export function armsReset(typed: string): boolean {
  return typed.trim().toLowerCase() === RESET_PHRASE;
}
