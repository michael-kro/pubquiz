// Tests for pubquiz.yml. "ruleid" marks a line the rule must flag; "ok" marks one it must leave alone.
declare const el: { innerHTML: string; outerHTML: string; insertAdjacentHTML(where: string, html: string): void };
declare const hostKey: string;
declare const attempt: string;
declare const options: { hostPin?: string };
declare let lastScreenKey: string;

// ruleid: pubquiz-no-eval
eval('1 + 1');
// ruleid: pubquiz-no-eval
const fn = new Function('return 1');
// ok: pubquiz-no-eval
setTimeout(() => {}, 10);

// ruleid: pubquiz-compare-secret-in-constant-time
if (attempt === hostKey) console.log('matched');
// ruleid: pubquiz-compare-secret-in-constant-time
if (hostKey !== attempt) console.log('different');
// ok: pubquiz-compare-secret-in-constant-time
if (options.hostPin === undefined) console.log('no pin');
// ok: pubquiz-compare-secret-in-constant-time
if (hostKey === '') console.log('empty');
// ok: pubquiz-compare-secret-in-constant-time
if (attempt === lastScreenKey) console.log('same screen');
// ruleid: pubquiz-compare-secret-in-constant-time
if (attempt === options.hostPin) console.log('pin matched');
// ruleid: pubquiz-no-html-injection
el.innerHTML = '<b>' + attempt + '</b>';
// ruleid: pubquiz-no-html-injection
el.outerHTML = attempt;
// ruleid: pubquiz-no-html-injection
el.insertAdjacentHTML('beforeend', attempt);
// ok: pubquiz-no-html-injection
const text = el.innerHTML.length;
void text;
void fn;
void el;
