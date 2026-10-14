// The question bank browser: filter, preview and add ready-made questions to a quiz.
import { h, LETTERS } from './common.js';

const TYPE_NAMES = {
  'multiple-choice': 'Multiple choice',
  letter: 'First letter',
  number: 'Number',
  nearest: 'Nearest wins',
  ordering: 'Put in order',
};
const PAGE = 40;

const normalise = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** What a quizmaster wants to see before adding: the right answer. */
function answerPreview(q) {
  switch (q.type) {
    case 'multiple-choice':
      return `${LETTERS[q.answer]}: ${q.options[q.answer]}   (${q.options.join(' · ')})`;
    case 'ordering':
      return q.items.join(' → ');
    default:
      return String(q.answer);
  }
}

/**
 * Opens the picker over the editor.
 * rounds(): the quiz's rounds as [{name, questions}], for the "add to round" choice and the already-in-quiz markers.
 * onAdd(questions, roundIndex): called with copies of the chosen questions.
 */
export async function openBankPicker({ api, rounds, onAdd }) {
  let summary;
  try {
    summary = await api('GET', '/bank/summary');
  } catch (error) {
    alert(error.message);
    return;
  }
  const filters = { category: '', type: '', difficulty: '', search: '' };
  let results = { total: 0, questions: [] };
  let offset = 0;
  let roundIndex = 0;
  let loading = false;
  let searchTimer;
  const chosen = new Map();

  const overlay = h('div', { class: 'bank-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Question bank' });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.body.append(overlay);

  const query = (extra = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...extra })) if (v !== '' && v !== undefined) p.set(k, v);
    return p.toString();
  };

  async function load() {
    loading = true;
    paint();
    try {
      results = await api('GET', `/bank?${query({ limit: PAGE, offset })}`);
    } catch (error) {
      results = { total: 0, questions: [], error: error.message };
    }
    loading = false;
    paint();
  }

  const inQuiz = () => new Set(rounds().flatMap((r) => r.questions.map((q) => normalise(q.text))));

  function add(entries) {
    if (!entries.length) return;
    onAdd(entries.map((e) => structuredClone(e.question)), roundIndex);
    chosen.clear();
    paint();
  }

  async function addRandom(count) {
    try {
      const picked = await api('GET', `/bank/random?${query({ limit: count })}`);
      const have = inQuiz();
      add(picked.questions.filter((e) => !have.has(normalise(e.text))));
    } catch (error) {
      alert(error.message);
    }
  }

  const select = (label, key, options) =>
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h(
        'select',
        {
          onchange: (e) => {
            filters[key] = e.target.value;
            offset = 0;
            void load();
          },
        },
        h('option', { value: '' }, 'All'),
        options.map(([value, text]) => h('option', { value, selected: filters[key] === value }, text)),
      ),
    );

  function paint() {
    const have = inQuiz();
    const categories = [...new Set(summary.categories.map((c) => c.category))].sort();
    const roundNames = rounds().map((r, i) => [String(i), r.name || `Round ${i + 1}`]);
    overlay.replaceChildren(
      h(
        'div',
        { class: 'bank-modal' },
        h(
          'header',
          { class: 'bank-head' },
          h('h2', {}, 'Question bank'),
          h('span', { class: 'muted' }, `${summary.total} questions`),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: close }, '×'),
        ),
        h(
          'div',
          { class: 'bank-filters' },
          select('Category', 'category', categories.map((c) => [c, c])),
          select('Type', 'type', Object.entries(TYPE_NAMES).filter(([t]) => summary.types[t])),
          select('Difficulty', 'difficulty', [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']]),
          h(
            'label',
            { class: 'field grow' },
            h('span', { class: 'field-label' }, 'Search'),
            h('input', {
              type: 'search',
              value: filters.search,
              placeholder: 'e.g. Everest, Beatles, 1969',
              oninput: (e) => {
                filters.search = e.target.value;
                offset = 0;
                clearTimeout(searchTimer);
                searchTimer = setTimeout(load, 250);
              },
            }),
          ),
        ),
        h(
          'div',
          { class: 'bank-actions' },
          h(
            'label',
            { class: 'field inline' },
            h('span', { class: 'field-label' }, 'Add to'),
            h(
              'select',
              { 'aria-label': 'Round to add to', onchange: (e) => (roundIndex = Number(e.target.value)) },
              roundNames.map(([value, text]) => h('option', { value, selected: Number(value) === roundIndex }, text)),
            ),
          ),
          h('button', { type: 'button', class: 'primary', disabled: chosen.size === 0, onclick: () => add([...chosen.values()]) }, `Add selected (${chosen.size})`),
          h('button', { type: 'button', disabled: results.total === 0, onclick: () => addRandom(10) }, 'Add 10 random from these'),
          h('span', { class: 'muted' }, loading ? 'Loading…' : `${results.total} match${results.total === 1 ? '' : 'es'}`),
        ),
        results.error ? h('p', { class: 'problem' }, results.error) : null,
        h(
          'ul',
          { class: 'bank-list' },
          results.questions.map((e) => {
            const already = have.has(normalise(e.text));
            return h(
              'li',
              { class: already ? 'already' : '' },
              h('input', {
                type: 'checkbox',
                'aria-label': `Select: ${e.text}`,
                checked: chosen.has(e.id),
                disabled: already,
                onchange: (ev) => {
                  if (ev.target.checked) chosen.set(e.id, e);
                  else chosen.delete(e.id);
                  paint();
                },
              }),
              h(
                'div',
                { class: 'bank-item' },
                h('p', { class: 'bank-text' }, e.text),
                h('p', { class: 'bank-answer muted' }, answerPreview(e.question)),
                h(
                  'p',
                  { class: 'bank-meta' },
                  h('span', { class: 'chip' }, TYPE_NAMES[e.type] ?? e.type),
                  h('span', { class: `chip ${e.difficulty}` }, e.difficulty),
                  h('span', { class: 'chip plain' }, e.category),
                  e.source === 'mine' ? h('span', { class: 'chip plain' }, 'mine') : null,
                  already ? h('span', { class: 'chip plain' }, 'already in this quiz') : null,
                ),
              ),
              h('button', { type: 'button', disabled: already, onclick: () => add([e]) }, 'Add'),
            );
          }),
        ),
        h(
          'footer',
          { class: 'bank-foot' },
          h('button', { type: 'button', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); void load(); } }, '← Previous'),
          h('span', { class: 'muted' }, results.total ? `${offset + 1}–${Math.min(offset + PAGE, results.total)} of ${results.total}` : ''),
          h('button', { type: 'button', disabled: offset + PAGE >= results.total, onclick: () => { offset += PAGE; void load(); } }, 'Next →'),
        ),
      ),
    );
  }

  await load();
}
