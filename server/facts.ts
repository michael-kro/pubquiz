// Fun facts for the break screen: loading the built-in files, and picking a shuffled handful.
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { bundledFactFiles } from './assets.ts';
import { normalise } from './matching.ts';

export const MAX_FACT_LENGTH = 200;

const FactFile = z.object({ topic: z.string().trim().min(1), facts: z.array(z.string().trim().min(1).max(MAX_FACT_LENGTH)).min(1) }).strict();

export function parseFactFile(text: string): { topic: string; facts: string[] } | undefined {
  try {
    const result = FactFile.safeParse(parseYaml(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

let cache: string[] | undefined;

/** Every built-in fact, once, with repeats removed. Files that don't parse are skipped. */
export async function loadBundledFacts(): Promise<string[]> {
  if (cache) return cache;
  const seen = new Set<string>();
  const facts: string[] = [];
  for (const [, text] of [...(await bundledFactFiles())].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const fact of parseFactFile(text)?.facts ?? []) {
      const key = normalise(fact);
      if (!seen.has(key)) {
        seen.add(key);
        facts.push(fact);
      }
    }
  }
  cache = facts;
  return facts;
}

/** `count` facts in random order, without repeats. */
export function pickFacts(pool: string[], count: number, random: () => number = Math.random): string[] {
  const copy = [...pool];
  const picked: string[] = [];
  while (picked.length < count && copy.length) picked.push(copy.splice(Math.floor(random() * copy.length), 1)[0]!);
  return picked;
}
