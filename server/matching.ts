// Fuzzy matching for typed answers (picture and music questions).
// The server only suggests a mark; the host confirms or overrides it before the reveal.

export type Match = 'exact' | 'close' | 'none';

/** Lower-case, no accents or punctuation, "&" as "and", no leading "the"/"a"/"an". */
export function normalise(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Typos allowed: none for very short answers, one for medium, two for long ones. */
function allowedTypos(length: number): number {
  if (length <= 3) return 0;
  if (length <= 7) return 1;
  return 2;
}

export function matchAnswer(given: string, accepted: string[]): Match {
  const answer = normalise(given);
  if (!answer) return 'none';
  let best: Match = 'none';
  for (const option of accepted) {
    const target = normalise(option);
    if (answer === target) return 'exact';
    if (editDistance(answer, target) <= allowedTypos(target.length)) best = 'close';
  }
  return best;
}
