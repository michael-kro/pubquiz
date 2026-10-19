// Optional short links (is.gd) for the internet address, so it is easy to read out or type on a TV.
// Only addresses that carry no key are ever sent: the team join address, and the TV page when the host key is off.

export type ShortLinks = { join?: string; tv?: string };

/** Asks is.gd for a short address. Resolves to undefined if the service says no or cannot be reached. */
export async function shorten(url: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`https://is.gd/create.php?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(6000) });
    const data = (await res.json()) as { shorturl?: unknown };
    return typeof data.shorturl === 'string' && /^https:\/\/is\.gd\/\w+$/.test(data.shorturl) ? data.shorturl : undefined;
  } catch {
    return undefined;
  }
}

/** Short links for a new public address. The TV one is only made when the TV page needs no key. */
export async function shortLinksFor(publicUrl: string, tvNeedsNoKey: boolean, fetchImpl: typeof fetch = fetch): Promise<ShortLinks> {
  const [join, tv] = await Promise.all([shorten(`${publicUrl}/`, fetchImpl), tvNeedsNoKey ? shorten(`${publicUrl}/screen`, fetchImpl) : Promise.resolve(undefined)]);
  return { ...(join ? { join } : {}), ...(tv ? { tv } : {}) };
}
