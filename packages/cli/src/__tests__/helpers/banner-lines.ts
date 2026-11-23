/**
 * CLIENTS-18 moved every status banner from stdout to stderr. The older
 * banner-format tests assert ordering against the payload, so their harnesses
 * mirror banner lines into the log array they already read. Which stream a
 * banner lands on is asserted in exit-codes.test.ts.
 */
export const isBanner = (line: string): boolean => /^(🧠|✓ )/.test(line);
