/**
 * The blanks a drafted reply is allowed to contain.
 *
 * This list lives in `lib` rather than in the comms module because BOTH sides
 * of the wire need it and they need the SAME one:
 *
 *  - the server uses it to reject a draft that invented its own placeholder,
 *    and again in `sendReply` to refuse a message that still has blanks in it
 *  - the browser uses it to grey out the send button and say why
 *
 * The comms module is `server-only`, so a client importing from there would
 * fail the build — and the tempting fix, retyping the five strings in the page
 * component, is exactly how the two ends drift. Then a placeholder the server
 * refuses is one the browser cheerfully lets you try to send, or worse, one
 * the browser ignores and the server never sees.
 *
 * Every entry is a fact the SHOP holds and the model does not. Adding one is a
 * decision about what the software may leave blank, not a convenience.
 */
export const PLACEHOLDERS = [
  "[time]",
  "[date]",
  "[price]",
  "[name]",
  "[address]",
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * Does this text still have blanks a person has to fill in?
 *
 * Pure, and shared by the send button and the send path — which is the point:
 * a button that greys out is a courtesy, and `sendReply` calling this same
 * function is what makes it true.
 */
export function hasUnfilledPlaceholders(text: string): boolean {
  return PLACEHOLDERS.some((p) => text.includes(p));
}
