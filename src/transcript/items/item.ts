/** One classified item, at the shape the daemon holds it in.
 *
 * The contract states the same shape as a schema, which is what a dump is
 * checked against; what it does not give is a type to write code with — a
 * union of that many object schemas erases to nothing usable — so the three
 * fields every item has are named here and the rest are the type's own. The
 * schema stays the authority: the tests validate what this produces against
 * it, so a field that drifts from the contract fails there rather than
 * travelling. */
export interface Item {
  /** The record's id in the transcript, which is what makes an item
   * addressable and what the links between items point with. Every item one
   * record became carries it, so a bound by record keeps a turn whole. */
  readonly uuid: string;
  readonly type: string;
  /** The item's own instant. A call and its result each keep their own. */
  readonly at: number;
  /** Which turn of the session it fell in, counted from where a person spoke.
   * Renumbered whenever the file is read again, so it is an attribute to show
   * and never a way to cut a range. */
  readonly turn?: number;
  readonly [field: string]: unknown;
}
