/**
 * How every short id is printed: an ellipsis and the last six characters ("…abc123"), set in
 * mono by the caller. Enough to tell marks apart, short enough to print; a short id prints whole.
 */
export const shortId = (id: string): string => (id.length > 6 ? `…${id.slice(-6)}` : id);
