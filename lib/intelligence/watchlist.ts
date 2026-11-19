export function addWatchSymbol(current: readonly string[], input: string) {
  const symbol = input.trim().toUpperCase();
  if (!/^[\p{L}\p{N}_]{2,40}$/u.test(symbol)) throw new Error('Enter a valid futures symbol.');
  if (current.includes(symbol)) return [...current];
  if (current.length >= 50) throw new Error('This temporary watchlist is limited to 50 symbols.');
  return [...current, symbol];
}
