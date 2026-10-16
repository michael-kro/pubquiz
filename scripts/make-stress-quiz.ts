#!/usr/bin/env node
// Writes a long quiz full of long questions, for user testing and stress tests:
//   node scripts/make-stress-quiz.ts [out-folder]     (default examples/stress-test)
// 12 rounds of 10 questions (120 in all) covering every type the phones can answer, with long question text,
// long answer options, long round names, accents, emoji, quotes and angle brackets.
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { parseQuiz } from '../server/quiz.ts';

export const STRESS_ROUNDS = 12;
export const STRESS_PER_ROUND = 10;

/** Real, harmless general-knowledge stories to pad out questions to a few hundred characters. */
const STORIES = [
  'In 1969 the Apollo 11 crew spent just over twenty-one hours on the surface of the Moon, and in that time Neil Armstrong and Buzz Aldrin planted a flag, collected around twenty-two kilograms of lunar rock and soil, deployed a seismometer and a laser reflector that scientists still bounce lasers off today, and left behind a plaque that reads that they came in peace for all mankind, while Michael Collins stayed in orbit above them.',
  'The Great Fire of London began in the early hours of 2 September 1666 in a baker’s shop on Pudding Lane, spread quickly through narrow wooden streets helped by a strong east wind, burned for four days, destroyed around thirteen thousand houses and eighty-seven parish churches including the old St Paul’s Cathedral, yet the official death toll recorded was famously only a handful of people.',
  'Honey never really spoils: archaeologists opening Egyptian tombs thousands of years old have found pots of it that were still perfectly edible, because its very low moisture and slight acidity make it a terrible place for bacteria to grow, and bees also add an enzyme from their stomachs that slowly produces a little hydrogen peroxide, which helps to keep it safe for a remarkably long time.',
  'The Tour de France, first held in 1903 to boost newspaper sales, is raced over about three weeks and twenty-one stages, covers more than three thousand kilometres, climbs mountains such as the Col du Tourmalet and Alpe d’Huez, and awards a yellow jersey to the overall leader, a colour chosen because the newspaper that organised it was printed on yellow paper.',
  'Octopuses have three hearts and blue blood: two hearts pump blood through the gills while the third circulates it to the rest of the body, and the blood is blue because it uses a copper-based molecule called haemocyanin rather than the iron-based haemoglobin that makes human blood red, a design that works well in cold, low-oxygen water.',
  'The Rosetta Stone, found by French soldiers in 1799 near the Egyptian town of Rashid, carries the same decree written in three scripts, hieroglyphic, demotic and ancient Greek, which allowed scholars including Thomas Young and Jean-François Champollion to work out how to read Egyptian hieroglyphs for the first time in well over a thousand years.',
  'A standard game of chess begins with sixteen pieces per side, and although the rules look simple the number of possible games is so enormous that it is often said to exceed the number of atoms in the observable universe, which is why even the strongest computers did not defeat a reigning world champion until Deep Blue beat Garry Kasparov in 1997.',
  'The Amazon rainforest covers roughly five and a half million square kilometres across nine countries, is home to about one in ten of all the known species on Earth, and its river discharges more water into the Atlantic than any other, around two hundred thousand cubic metres every single second, more than the next seven largest rivers combined.',
];

const OPTION_TAILS = [
  'and this is the answer that most people at the table would confidently pick first',
  'which, despite sounding plausible, is a very common misconception repeated in many books',
  'as described in several well-known encyclopaedias, though with a number of caveats',
  'according to the version of the story that is usually told in school lessons',
  'and nobody argues about it, apart from a few historians who enjoy arguing',
  'a surprisingly detailed answer that goes on for rather longer than you expect',
];

const ODD = ['Café “quotes” & <angle brackets>', 'Emoji 🎉🦉🍺 and naïve façade', 'Back\\slash / slash \'single\' "double"'];

function longOption(r: number, q: number, i: number): string {
  const label = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'][i];
  return `Option ${label}: ${ODD[(r + q + i) % ODD.length]}, ${OPTION_TAILS[(r + q + i) % OPTION_TAILS.length]}`;
}

export function buildStressQuiz() {
  const rounds = Array.from({ length: STRESS_ROUNDS }, (_, r) => {
    const story = (q: number) => STORIES[(r * 3 + q) % STORIES.length]!;
    const last = r === STRESS_ROUNDS - 1;
    const questions: Record<string, unknown>[] = [];
    const answerOf = (q: number, n: number) => (r + q) % n;
    for (let q = 0; q < STRESS_PER_ROUND; q++) {
      const tag = `Round ${r + 1}, question ${q + 1}`;
      const common = { seconds: 20, points: 100, ...(last ? { category: ['History', 'Science', 'Nature', 'Sport', 'Maths'][q % 5] } : {}) };
      switch (q) {
        case 0:
        case 1:
        case 2: {
          const n = q === 0 ? 6 : q === 1 ? 4 : 2;
          questions.push({ type: 'multiple-choice', text: `${tag}. ${r === 1 && q === 1 ? [0, 1, 2, 3].map((k) => story(k + 1)).join(' ') : story(q)} Using only what you have just read, which of the following statements is the one the quiz master is looking for?`, options: Array.from({ length: n }, (_, i) => longOption(r, q, i)), answer: answerOf(q, n), ...common });
          break;
        }
        case 3:
          questions.push({ type: 'letter', text: `${tag}. ${story(q)} What is the very first letter of the name of the main person, place or thing this passage is about?`, answer: ['Apollo', 'Baker Street Fire', 'Honey', 'Tour de France', 'Octopus', 'Rosetta Stone'][(r + q) % 6], ...common });
          break;
        case 4:
          questions.push({ type: 'letter', text: `${tag}. Which famous Queen guitarist, who also holds a PhD in astrophysics, shares his initials with a very long tagline of unnecessary words that go on and on across several lines of a small phone screen?`, answer: 'Brian May', ...common });
          break;
        case 5:
          questions.push({ type: 'number', text: `${tag}. ${story(q)} Give the single number of years between the event this passage describes and the year 2000, to the nearest whole number you can manage.`, answer: 30 + r * 7, tolerance: 0, ...common });
          break;
        case 6:
          questions.push({ type: 'nearest', text: `${tag}. ${story(q)} Roughly how many people, in thousands, do you think are described, counted or involved in everything above? The closest guess wins.`, answer: 1000 + r * 111, ...common });
          break;
        case 7:
          questions.push({ type: 'ordering', text: `${tag}. Put the following very long descriptions in the order that they happened, earliest first, reading carefully because every item begins with a similar phrase.`, items: ['Earliest: ', 'Early: ', 'Middle: ', 'Late: ', 'Latest: '].map((p, i) => `${p}${story(i)} `.slice(0, 150) + '…'), ...common });
          break;
        case 8:
          questions.push({ type: 'picture', text: `${tag}. ${story(q)} Look closely at the picture and type the name of the country whose flag is shown.`, image: 'images/flag.svg', accept: ['Japan', 'Nippon'], ...common });
          break;
        default:
          questions.push({ type: 'music', text: `${tag}. The host is playing a track now. ${story(q)} Type the name of the band as you would say it.`, accept: ['Queen', 'The Beatles', 'Beatles'], ...common });
      }
    }
    return {
      name: last ? 'The grand finale wager round with a deliberately long round name that goes on and on' : `Round ${r + 1}: ${['General knowledge', 'History and heritage', 'Science and nature', 'Sport and leisure', 'Music and film'][r % 5]} with a rather long title to test wrapping`,
      ...(last ? { wager: true, wagerCap: 500 } : {}),
      questions,
    };
  });
  return { title: 'Stress Test: Long Questions, Long Quiz', scoring: { mode: 'flat', leaderboard: 'round' }, rounds };
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = process.argv[2] ?? join(here, '..', 'examples', 'stress-test');
  await mkdir(join(out, 'images'), { recursive: true });
  await copyFile(join(here, '..', 'test', 'fixtures', 'images', 'flag.svg'), join(out, 'images', 'flag.svg'));
  const yaml = stringify(buildStressQuiz(), { lineWidth: 0 });
  parseQuiz(yaml); // fail now rather than on quiz night
  await writeFile(join(out, 'quiz.yaml'), yaml);
  console.log(`Wrote ${join(out, 'quiz.yaml')} (${STRESS_ROUNDS * STRESS_PER_ROUND} questions)`);
}
