// The quiz editor on the host screen. Edits a draft of quiz.yaml, autosaves it, and shows
// the server's validation problems next to the fields they're about.
import { openBankPicker } from './bank-picker.js';
import { h, LETTERS } from './common.js';

const TYPES = {
  'multiple-choice': 'Multiple choice',
  picture: 'Picture',
  music: 'Music',
  ordering: 'Put in order',
  letter: 'First letter',
  number: 'Number',
  nearest: 'Nearest wins',
  buzzer: 'Buzzer',
};
const ORDERING_ITEMS = 5;
const SAVE_DELAY_MS = 700;
const MAX_IMAGE_SIDE = 1600;

let nextKey = 1;
const newKey = () => `k${nextKey++}`;

/** Mirrors the server: lower-case, no accents, punctuation or leading "the/a/an". */
function normalise(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

function blankQuestion(type = 'multiple-choice', from = {}) {
  const keep = { text: from.text ?? '', seconds: from.seconds, points: from.points, image: from.image, info: from.info };
  for (const k of Object.keys(keep)) if (keep[k] === undefined) delete keep[k];
  const typed = {
    'multiple-choice': { options: ['', '', '', ''], answer: 0 },
    picture: { accept: [''] },
    music: { accept: [''] },
    ordering: { items: Array(ORDERING_ITEMS).fill('') },
    letter: { answer: '' },
    number: { answer: 0 },
    nearest: { answer: 0 },
    buzzer: { answer: '' },
  }[type];
  // Carry the answer across where the types are similar.
  if ((type === 'picture' || type === 'music') && from.accept) typed.accept = [...from.accept];
  if ((type === 'picture' || type === 'music') && from.type === 'letter' && from.answer) typed.accept = [from.answer];
  if (type === 'letter' && from.accept?.[0]) typed.answer = from.accept[0];
  return { key: newKey(), type, ...keep, ...typed };
}

/** Adds editor-only keys so questions keep their identity while being moved around. */
function toModel(draft) {
  const rounds = Array.isArray(draft.rounds) ? draft.rounds : [];
  return {
    ...draft,
    title: typeof draft.title === 'string' ? draft.title : '',
    rounds: rounds.map((round) => ({
      ...round,
      key: newKey(),
      name: typeof round?.name === 'string' ? round.name : '',
      questions: (Array.isArray(round?.questions) ? round.questions : []).map((q) => ({ ...q, key: newKey() })),
    })),
  };
}

function toDraft(model) {
  const { rounds, ...rest } = model;
  return {
    ...rest,
    rounds: rounds.map(({ key, questions, ...round }) => ({
      ...round,
      questions: questions.map(({ key: _key, ...q }) => q),
    })),
  };
}

/** Shrinks big photos in the browser before upload, so phones on 4G load them quickly. */
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return { blob: file, name: file.name };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1_500_000) return { blob: file, name: file.name };
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no transparency.
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return { blob, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' };
}

/**
 * Mounts the editor for quiz `id` into `container`.
 * `api(method, path, body)` calls the host API; `onExit()` goes back to the library; `onRun()` after a quiz starts.
 */
export async function mountEditor(container, { id, hostKey, api, onExit, onRun }) {
  const loaded = await api('GET', `/quizzes/${id}`);
  const model = toModel(loaded.draft);
  if (model.rounds.length === 0) model.rounds.push({ key: newKey(), name: 'Round 1', questions: [blankQuestion()] });
  let issues = loaded.issues;
  let selected = model.rounds[0]?.questions[0]?.key;
  let saveTimer;
  let saving = Promise.resolve();
  let saveState = 'saved';
  let runProblems = [];
  let dragKey = null;

  const imageUrl = (path) =>
    /^https?:\/\//i.test(path) ? path : `/api/quizzes/${encodeURIComponent(id)}/images/${encodeURIComponent(path.replace(/^images\//, ''))}?key=${encodeURIComponent(hostKey)}`;

  function find(key) {
    for (const [r, round] of model.rounds.entries()) {
      const q = round.questions.findIndex((question) => question.key === key);
      if (q >= 0) return { round, r, q, question: round.questions[q] };
    }
    return undefined;
  }

  // Saving

  function changed({ structure = false } = {}) {
    saveState = 'pending';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
    if (structure) render();
    else updateStatus();
    renderPreview();
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    saving = saving.then(async () => {
      saveState = 'saving';
      updateStatus();
      try {
        const result = await api('PUT', `/quizzes/${id}`, toDraft(model));
        issues = result.issues;
        saveState = saveTimer ? 'pending' : 'saved';
      } catch {
        saveState = 'failed';
        saveTimer = setTimeout(save, 3000);
      }
      updateStatus();
      updateIssues();
    });
    return saving;
  }

  async function flush() {
    if (saveTimer) save();
    await saving;
  }

  // Problems from the server, mapped onto questions and fields.

  function issuesFor(r, q) {
    return issues.filter((i) => i.path[0] === 'rounds' && i.path[1] === r && i.path[2] === 'questions' && i.path[3] === q);
  }

  function updateIssues() {
    // Badges in the sidebar.
    for (const [r, round] of model.rounds.entries()) {
      for (const [q, question] of round.questions.entries()) {
        const item = container.querySelector(`[data-question="${question.key}"]`);
        item?.classList.toggle('has-problem', issuesFor(r, q).length > 0);
      }
    }
    // Messages next to fields of the selected question.
    for (const el of container.querySelectorAll('[data-problem]')) el.textContent = '';
    const where = selected && find(selected);
    if (where) {
      const byField = new Map();
      for (const issue of issuesFor(where.r, where.q)) {
        const field = String(issue.path[4] ?? '');
        const sentence = `${subject(field, issue.path[5])} ${issue.message}.`;
        const sentences = byField.get(field) ?? new Set();
        sentences.add(sentence);
        byField.set(field, sentences);
      }
      for (const [field, sentences] of byField) {
        const el = container.querySelector(`[data-problem="${field}"]`) ?? container.querySelector('[data-problem="*"]');
        if (el) el.textContent = [el.textContent, ...sentences].filter(Boolean).join(' ');
      }
    }
    const general = issues.filter((i) => i.path[0] !== 'rounds' || i.path.length <= 3);
    const top = container.querySelector('.editor-problems');
    if (top) {
      const messages = [...general.map((i) => describe(i)), ...runProblems];
      top.replaceChildren(...messages.map((m) => h('li', {}, m)));
      top.hidden = messages.length === 0;
    }
    const count = container.querySelector('.problem-count');
    if (count) count.textContent = issues.length ? `${issues.length} ${issues.length === 1 ? 'thing' : 'things'} to fix` : '';
  }

  /** "Option B", "Answer 2", "Item 5", or the field's name. */
  function subject(field, index) {
    if (typeof index === 'number') {
      if (field === 'options') return `Option ${LETTERS[index] ?? index + 1}`;
      if (field === 'accept') return `Answer ${index + 1}`;
      if (field === 'items') return `Item ${index + 1}`;
    }
    const names = { text: 'The question', options: 'Options', answer: 'The answer', accept: 'Accepted answers', items: 'Items', image: 'The picture', seconds: 'Time', points: 'Points', letter: 'The letter', type: 'Type' };
    return names[field] ?? 'This question';
  }

  function describe(issue) {
    if (issue.path[0] === 'title') return `Quiz title ${issue.message}.`;
    if (issue.path[0] === 'rounds' && typeof issue.path[1] === 'number') {
      return `Round ${issue.path[1] + 1}${issue.path[2] === 'name' ? ' name' : ''} ${issue.message}.`;
    }
    return `${issue.path.join(' ')} ${issue.message}.`.trim();
  }

  function updateStatus() {
    const el = container.querySelector('.save-status');
    if (!el) return;
    el.textContent = { saved: 'All changes saved', pending: 'Saving…', saving: 'Saving…', failed: "Couldn't save. Retrying…" }[saveState];
    el.classList.toggle('failed', saveState === 'failed');
  }

  // Editing actions

  function select(key) {
    selected = key;
    runProblems = [];
    render();
  }

  function addQuestion(round, type = 'multiple-choice') {
    const question = blankQuestion(type);
    round.questions.push(question);
    selected = question.key;
    changed({ structure: true });
    container.querySelector('.question-form textarea')?.focus();
  }

  function moveQuestion(key, toRound, toIndex) {
    const from = find(key);
    if (!from) return;
    from.round.questions.splice(from.q, 1);
    const index = Math.max(0, Math.min(toIndex, toRound.questions.length));
    toRound.questions.splice(index, 0, from.question);
    changed({ structure: true });
  }

  function removeQuestion(key) {
    const where = find(key);
    if (!where) return;
    if (!confirm('Delete this question?')) return;
    where.round.questions.splice(where.q, 1);
    selected = where.round.questions[Math.min(where.q, where.round.questions.length - 1)]?.key ?? model.rounds.flatMap((r) => r.questions)[0]?.key;
    changed({ structure: true });
  }

  function duplicateQuestion(key) {
    const where = find(key);
    if (!where) return;
    const copy = { ...structuredClone(where.question), key: newKey() };
    where.round.questions.splice(where.q + 1, 0, copy);
    selected = copy.key;
    changed({ structure: true });
  }

  function addRound() {
    const round = { key: newKey(), name: `Round ${model.rounds.length + 1}`, questions: [blankQuestion()] };
    model.rounds.push(round);
    selected = round.questions[0].key;
    changed({ structure: true });
  }

  function moveRound(index, by) {
    const target = index + by;
    if (target < 0 || target >= model.rounds.length) return;
    [model.rounds[index], model.rounds[target]] = [model.rounds[target], model.rounds[index]];
    changed({ structure: true });
  }

  function removeRound(index) {
    const round = model.rounds[index];
    if (!confirm(`Delete "${round.name || 'this round'}" and its ${round.questions.length} questions?`)) return;
    model.rounds.splice(index, 1);
    if (!find(selected)) selected = model.rounds.flatMap((r) => r.questions)[0]?.key;
    changed({ structure: true });
  }

  async function uploadImage(question, file) {
    const status = container.querySelector('[data-problem="image"]');
    if (status) status.textContent = 'Uploading…';
    try {
      const { blob, name } = await prepareImage(file);
      const result = await api('POST', `/quizzes/${id}/images?name=${encodeURIComponent(name)}`, blob);
      question.image = result.path;
      changed({ structure: true });
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  }

  function openBank() {
    void openBankPicker({
      api,
      rounds: () => model.rounds,
      onAdd(questions, roundIndex) {
        const round = model.rounds[Math.min(roundIndex, model.rounds.length - 1)];
        const added = questions.map((q) => ({ key: newKey(), ...q }));
        round.questions.push(...added);
        selected = added[0].key;
        changed({ structure: true });
      },
    });
  }

  async function run() {
    await flush();
    try {
      await api('POST', `/quizzes/${id}/run`, {});
      onRun();
    } catch (error) {
      runProblems = error.issues ?? [error.message];
      updateIssues();
      container.querySelector('.editor-problems')?.scrollIntoView({ block: 'nearest' });
    }
  }

  // Rendering

  function field(label, input, problemKey, hint) {
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      input,
      hint ? h('span', { class: 'hint' }, hint) : null,
      problemKey ? h('span', { class: 'problem', 'data-problem': problemKey, role: 'status' }) : null,
    );
  }

  function textInput(value, onInput, attrs = {}) {
    return h('input', { value: value ?? '', ...attrs, oninput: (e) => onInput(e.target.value) });
  }

  function numberInput(value, placeholder, onInput) {
    return h('input', {
      type: 'number',
      inputmode: 'numeric',
      value: value ?? '',
      placeholder,
      oninput: (e) => onInput(e.target.value === '' ? undefined : Number(e.target.value)),
    });
  }

  function listEditor(question, prop, { min, max, label, placeholder, numbered = false, moveable = false }) {
    const list = question[prop];
    return h(
      'div',
      { class: 'list-editor' },
      list.map((value, i) =>
        h(
          'div',
          { class: 'list-row' },
          numbered ? h('span', { class: 'row-number' }, i + 1) : null,
          textInput(value, (v) => {
            list[i] = v;
            changed();
          }, { placeholder: placeholder(i), 'aria-label': `${label} ${i + 1}` }),
          moveable
            ? [
                h('button', { type: 'button', class: 'icon', title: 'Move up', disabled: i === 0, onclick: () => swap(list, i, i - 1) }, '↑'),
                h('button', { type: 'button', class: 'icon', title: 'Move down', disabled: i === list.length - 1, onclick: () => swap(list, i, i + 1) }, '↓'),
              ]
            : null,
          list.length > min
            ? h('button', { type: 'button', class: 'icon', title: `Remove ${label.toLowerCase()}`, onclick: () => {
                list.splice(i, 1);
                changed({ structure: true });
              } }, '×')
            : null,
        ),
      ),
      list.length < max
        ? h('button', { type: 'button', class: 'add', onclick: () => {
            list.push('');
            changed({ structure: true });
          } }, `+ Add ${label.toLowerCase()}`)
        : null,
    );
  }

  function swap(list, a, b) {
    [list[a], list[b]] = [list[b], list[a]];
    changed({ structure: true });
  }

  const audioUrl = (path) =>
    /^https?:\/\//i.test(path) ? path : `/api/quizzes/${encodeURIComponent(id)}/audio/${encodeURIComponent(path.replace(/^audio\//, ''))}?key=${encodeURIComponent(hostKey)}`;

  async function uploadAudio(question, file) {
    const status = container.querySelector('[data-problem="audio"]');
    if (status) status.textContent = 'Uploading…';
    try {
      const result = await api('POST', `/quizzes/${id}/audio?name=${encodeURIComponent(file.name)}`, file);
      question.audio = result.path;
      changed({ structure: true });
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  }

  async function uploadRevealClip(question, file) {
    try {
      const result = await api('POST', `/quizzes/${id}/audio?name=${encodeURIComponent(file.name)}`, file);
      question.revealAudio = result.path;
      changed({ structure: true });
    } catch (error) {
      const status = container.querySelector('[data-problem="revealAudio"]');
      if (status) status.textContent = error.message;
    }
  }

  /** A fun clip (such as a film quote) that plays on the host or TV after the answer is shown. */
  function revealClipField(q) {
    return field(
      'Reveal clip (optional)',
      h(
        'div',
        { class: 'audio-field' },
        q.revealAudio ? h('audio', { controls: true, preload: 'none', src: audioUrl(q.revealAudio), 'aria-label': 'Preview of the reveal clip' }) : null,
        h(
          'div',
          { class: 'image-actions' },
          h('input', {
            type: 'file',
            accept: 'audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,.mp3,.m4a,.aac,.ogg,.opus,.wav',
            'aria-label': 'Upload a reveal clip',
            onchange: (e) => e.target.files[0] && uploadRevealClip(q, e.target.files[0]),
          }),
          textInput(q.revealCaption ?? '', (v) => {
            q.revealCaption = v.trim() || undefined;
            changed();
          }, { placeholder: 'Caption, e.g. Gladiator (2000)', 'aria-label': 'Reveal clip caption' }),
          q.revealAudio
            ? h('button', { type: 'button', class: 'link-button', onclick: () => {
                delete q.revealAudio;
                delete q.revealCaption;
                changed({ structure: true });
              } }, 'Remove clip')
            : null,
        ),
      ),
      'revealAudio',
      'Plays on the host or TV after the answer is revealed. Great for a film quote.',
    );
  }

  function audioField(q) {
    return field(
      'Audio clip (optional)',
      h(
        'div',
        { class: 'audio-field' },
        q.audio ? h('audio', { controls: true, preload: 'none', src: audioUrl(q.audio), 'aria-label': 'Preview of the audio clip' }) : null,
        h(
          'div',
          { class: 'image-actions' },
          h('input', {
            type: 'file',
            accept: 'audio/mpeg,audio/mp4,audio/aac,audio/ogg,audio/wav,.mp3,.m4a,.aac,.ogg,.opus,.wav',
            'aria-label': 'Upload an audio clip',
            onchange: (e) => e.target.files[0] && uploadAudio(q, e.target.files[0]),
          }),
          textInput(/^https?:/.test(q.audio ?? '') ? q.audio : '', (v) => {
            q.audio = v.trim() || undefined;
            changed();
          }, { placeholder: 'or paste an audio web address', 'aria-label': 'Audio web address' }),
          q.audio
            ? h('button', { type: 'button', class: 'link-button', onclick: () => {
                delete q.audio;
                changed({ structure: true });
              } }, 'Remove clip')
            : null,
        ),
      ),
      'audio',
      'Played on the host or TV screen, never on phones. mp3, m4a, ogg or wav, up to 20 MB.',
    );
  }

  function typeFields(q) {
    switch (q.type) {
      case 'multiple-choice':
        return field(
          'Options (tick the right one)',
          h(
            'div',
            { class: 'list-editor' },
            q.options.map((option, i) =>
              h(
                'div',
                { class: 'list-row' },
                h('input', {
                  type: 'radio',
                  name: `answer-${q.key}`,
                  checked: q.answer === i,
                  'aria-label': `Option ${LETTERS[i]} is right`,
                  onchange: () => {
                    q.answer = i;
                    changed();
                  },
                }),
                h('span', { class: `row-letter opt-${i}` }, LETTERS[i]),
                textInput(option, (v) => {
                  q.options[i] = v;
                  changed();
                }, { placeholder: `Option ${LETTERS[i]}`, 'aria-label': `Option ${LETTERS[i]}` }),
                q.options.length > 2
                  ? h('button', { type: 'button', class: 'icon', title: 'Remove option', onclick: () => {
                      q.options.splice(i, 1);
                      if (q.answer >= q.options.length) q.answer = 0;
                      else if (q.answer > i) q.answer--;
                      changed({ structure: true });
                    } }, '×')
                  : null,
              ),
            ),
            q.options.length < 6
              ? h('button', { type: 'button', class: 'add', onclick: () => {
                  q.options.push('');
                  changed({ structure: true });
                } }, '+ Add option')
              : null,
          ),
          'options',
        );
      case 'picture':
      case 'music':
        return field(
          'Accepted answers',
          listEditor(q, 'accept', { min: 1, max: 10, label: 'Answer', placeholder: (i) => (i === 0 ? 'The answer' : 'Another way to write it') }),
          'accept',
          'Teams type their answer. Small typos, capitals and "the" are forgiven, and you check every answer before the reveal.',
        );
      case 'ordering':
        return field(
          'Items, in the right order',
          listEditor(q, 'items', { min: ORDERING_ITEMS, max: ORDERING_ITEMS, label: 'Item', placeholder: (i) => (i === 0 ? 'First' : i === 4 ? 'Last' : `Item ${i + 1}`), numbered: true, moveable: true }),
          'items',
          'Teams see these shuffled.',
        );
      case 'number':
        return [
          field('Answer', numberInput(q.answer, 'e.g. 1989', (v) => {
            q.answer = v;
            changed();
          }), 'answer', 'Teams type a number. It must match exactly, unless you allow some give below.'),
          field('Give or take (optional)', numberInput(q.tolerance, '0', (v) => {
            q.tolerance = v;
            changed();
          }), 'tolerance', 'For example 5 accepts anything within 5 of the answer.'),
        ];
      case 'nearest':
        return field('Answer', numberInput(q.answer, 'e.g. 8849', (v) => {
          q.answer = v;
          changed();
        }), 'answer', 'Teams type a number and the closest guess wins all the points. Speed doesn\'t count. Good as a bonus question or tie-break.');
      case 'buzzer':
        return [
          field('Answer (only you see it, to judge with)', textInput(q.answer, (v) => {
            q.answer = v;
            changed();
          }, { placeholder: 'e.g. Canberra' }), 'answer', "Teams get a big BUZZ button. The first to buzz answers out loud and you press Correct or Wrong. A wrong team is out, and the next in line gets a go."),
          field('Penalty for a wrong answer (optional)', numberInput(q.penalty, '0', (v) => {
            q.penalty = v;
            changed();
          }), 'penalty', 'Points taken off a team that buzzes and gets it wrong.'),
        ];
      case 'letter': {
        const letter = (q.letter || normalise(q.answer)[0] || '?').toUpperCase();
        return [
          field(
            'Answer',
            textInput(q.answer, (v) => {
              q.answer = v;
              const shown = container.querySelector('.letter-shown');
              if (shown && !q.letter) shown.textContent = (normalise(v)[0] || '?').toUpperCase();
              changed();
            }, { placeholder: 'e.g. John Lennon' }),
            'answer',
            'Skip "The"; write people first name first.',
          ),
          h('p', { class: 'letter-line' }, 'Teams tap ', h('strong', { class: 'letter-shown' }, letter)),
          field(
            'Keypad',
            h(
              'select',
              { 'aria-label': 'Keypad', onchange: (e) => { q.keypad = e.target.value === 'grouped' ? undefined : e.target.value; changed(); } },
              h('option', { value: 'grouped', selected: (q.keypad ?? 'grouped') === 'grouped' }, 'Pairs of letters: AB, CD, EF…'),
              h('option', { value: 'single', selected: q.keypad === 'single' }, 'All 26 letters'),
            ),
            'keypad',
            'Grouped keys are quicker to tap and a bit easier.',
          ),
          field(
            'Different letter (optional)',
            textInput(q.letter, (v) => {
              q.letter = v.trim() ? v.trim().toUpperCase().slice(0, 1) : undefined;
              changed();
            }, { maxlength: '1', class: 'short', placeholder: letter }),
            'letter',
            'Only needed when the answer starts with a number or symbol.',
          ),
        ];
      }
    }
    return null;
  }

  function imageField(q) {
    const required = q.type === 'picture';
    return field(
      required ? 'Picture' : 'Picture (optional)',
      h(
        'div',
        { class: 'image-field' },
        q.image ? h('img', { class: 'image-thumb', src: imageUrl(q.image), alt: '' }) : null,
        h(
          'div',
          { class: 'image-actions' },
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml',
            'aria-label': 'Upload a picture',
            onchange: (e) => e.target.files[0] && uploadImage(q, e.target.files[0]),
          }),
          textInput(/^https?:/.test(q.image ?? '') ? q.image : '', (v) => {
            q.image = v.trim() || undefined;
            changed();
          }, { placeholder: 'or paste a picture web address', 'aria-label': 'Picture web address' }),
          q.image
            ? h('button', { type: 'button', class: 'link-button', onclick: () => {
                delete q.image;
                changed({ structure: true });
              } }, 'Remove picture')
            : null,
        ),
      ),
      'image',
    );
  }

  function questionForm(q) {
    const speedDefault = q.type !== 'music';
    return h(
      'div',
      { class: 'question-form' },
      h(
        'div',
        { class: 'form-row' },
        field(
          'Type',
          h(
            'select',
            {
              onchange: (e) => {
                const where = find(q.key);
                const replacement = { ...blankQuestion(e.target.value, q), key: q.key };
                where.round.questions[where.q] = replacement;
                changed({ structure: true });
              },
            },
            Object.entries(TYPES).map(([value, label]) => h('option', { value, selected: q.type === value }, label)),
          ),
          'type',
        ),
        field('Seconds', numberInput(q.seconds, '20', (v) => {
          q.seconds = v;
          changed();
        }), 'seconds'),
        field('Points', numberInput(q.points, '1000', (v) => {
          q.points = v;
          changed();
        }), 'points'),
      ),
      field(
        q.type === 'music' ? 'Question (play the track yourself)' : 'Question',
        h('textarea', {
          rows: '2',
          placeholder: q.type === 'music' ? 'e.g. Track 1: name the band' : 'Type the question',
          oninput: (e) => {
            q.text = e.target.value;
            const item = container.querySelector(`[data-question="${q.key}"] .q-text`);
            if (item) item.textContent = e.target.value || 'New question';
            changed();
          },
        }, q.text ?? ''),
        'text',
      ),
      typeFields(q),
      imageField(q),
      audioField(q),
      revealClipField(q),
      find(q.key)?.round.wager
        ? field('Category (teams see this while they bet)', textInput(q.category, (v) => {
            q.category = v.trim() ? v : undefined;
            changed();
          }, { maxlength: '60', placeholder: 'e.g. Rivers of the world' }), 'category')
        : null,
      field('Fun fact or source (optional, shown with the answer)', textInput(q.info, (v) => {
        q.info = v.trim() ? v : undefined;
        changed();
      }, { maxlength: '300' }), 'info'),
      q.type === 'nearest' || q.type === 'buzzer' ? null : h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: q.speedBonus ?? speedDefault,
          onchange: (e) => {
            q.speedBonus = e.target.checked === speedDefault ? undefined : e.target.checked;
            changed();
          },
        }),
        ' Faster answers score more',
      ),
      h('p', { class: 'problem', 'data-problem': '*', role: 'status' }),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { type: 'button', onclick: () => duplicateQuestion(q.key) }, 'Duplicate question'),
        h('button', { type: 'button', class: 'danger', onclick: () => removeQuestion(q.key) }, 'Delete question'),
      ),
    );
  }

  function setScoring(name, value) {
    const scoring = { ...(model.scoring ?? {}) };
    if (value === undefined) delete scoring[name];
    else scoring[name] = value;
    model.scoring = Object.keys(scoring).length ? scoring : undefined;
    changed({ structure: name === 'mode' || name === 'fastBonus' });
  }

  /** A labelled drop-down for a quiz-wide setting. */
  function setting(label, options, get, set) {
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h(
        'select',
        { onchange: (e) => set(e.target.value) },
        options.map(([value, text]) => h('option', { value, selected: String(get()) === String(value) }, text)),
      ),
    );
  }

  function sidebar() {
    return h(
      'nav',
      { class: 'editor-sidebar', 'aria-label': 'Rounds and questions' },
      model.rounds.map((round, r) =>
        h(
          'section',
          {
            class: 'round',
            ondragover: (e) => dragKey && e.preventDefault(),
            ondrop: (e) => {
              e.preventDefault();
              if (dragKey) moveQuestion(dragKey, round, round.questions.length);
            },
          },
          h(
            'div',
            { class: 'round-head' },
            textInput(round.name, (v) => {
              round.name = v;
              changed();
            }, { class: 'round-name', 'aria-label': `Round ${r + 1} name`, placeholder: `Round ${r + 1}` }),
            h('button', { type: 'button', class: 'icon', title: 'Move round up', disabled: r === 0, onclick: () => moveRound(r, -1) }, '↑'),
            h('button', { type: 'button', class: 'icon', title: 'Move round down', disabled: r === model.rounds.length - 1, onclick: () => moveRound(r, 1) }, '↓'),
            h('button', { type: 'button', class: 'icon', title: 'Delete round', onclick: () => removeRound(r) }, '×'),
          ),
          h(
            'label',
            { class: 'check round-wager', title: 'Teams bet points on each question before seeing it, Jeopardy style' },
            h('input', {
              type: 'checkbox',
              checked: round.wager === true,
              onchange: (e) => {
                if (e.target.checked) round.wager = true;
                else {
                  delete round.wager;
                  delete round.wagerCap;
                }
                changed({ structure: true });
              },
            }),
            ' Wager round (teams bet before each question)',
          ),
          round.wager
            ? h('input', {
                class: 'round-cap',
                type: 'number',
                inputmode: 'numeric',
                'aria-label': `Largest bet in round ${r + 1}`,
                placeholder: 'Largest bet: their score',
                value: round.wagerCap ?? '',
                oninput: (e) => {
                  if (e.target.value === '') delete round.wagerCap;
                  else round.wagerCap = Number(e.target.value);
                  changed();
                },
              })
            : null,
          h(
            'select',
            {
              class: 'round-mode',
              'aria-label': `Scoring for round ${r + 1}`,
              onchange: (e) => {
                if (e.target.value) round.mode = e.target.value;
                else delete round.mode;
                changed();
              },
            },
            [['', 'Scoring: quiz default'], ['speed', 'Scoring: faster scores more'], ['flat', 'Scoring: flat'], ['first', 'Scoring: first-correct bonus']].map(
              ([value, text]) => h('option', { value, selected: (round.mode ?? '') === value }, text),
            ),
          ),
          h(
            'ol',
            { class: 'question-list' },
            round.questions.map((q, i) =>
              h(
                'li',
                {
                  'data-question': q.key,
                  class: q.key === selected ? 'selected' : '',
                  draggable: 'true',
                  ondragstart: (e) => {
                    dragKey = q.key;
                    e.dataTransfer.effectAllowed = 'move';
                  },
                  ondragend: () => (dragKey = null),
                  ondragover: (e) => dragKey && e.preventDefault(),
                  ondrop: (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (dragKey && dragKey !== q.key) moveQuestion(dragKey, round, i);
                  },
                },
                h(
                  'button',
                  { type: 'button', class: 'question-item', onclick: () => select(q.key) },
                  h('span', { class: 'q-type' }, TYPES[q.type] ?? q.type),
                  h('span', { class: 'q-text' }, q.text || 'New question'),
                ),
              ),
            ),
          ),
          h('button', { type: 'button', class: 'add', onclick: () => addQuestion(round) }, '+ Question'),
        ),
      ),
      h('button', { type: 'button', class: 'add add-round', onclick: addRound }, '+ Round'),
      h(
        'div',
        { class: 'settings' },
        setting('Scoring', [['speed', 'Faster scores more'], ['flat', 'Same for every correct answer'], ['first', 'Flat + bonus for the first correct team']], () => model.scoring?.mode ?? 'speed', (v) => setScoring('mode', v)),
        (model.scoring?.mode ?? 'speed') === 'speed'
          ? setting('Speed bonus', [[0.5, 'Half points at the buzzer'], [0.25, 'Small'], [0, 'Off']], () => model.scoring?.speedFactor ?? 0.5, (v) => setScoring('speedFactor', Number(v)))
          : null,
        (model.scoring?.mode ?? 'speed') === 'first'
          ? field('First-correct bonus', numberInput(model.scoring?.bonus, '500', (v) => setScoring('bonus', v)), 'bonus')
          : null,
        setting('Fastest teams bonus', [[0, 'Off'], [100, 'Small: 100'], [250, 'Medium: 250'], [500, 'Big: 500']], () => model.scoring?.fastBonus ?? 0, (v) => setScoring('fastBonus', Number(v) || undefined)),
        (model.scoring?.fastBonus ?? 0) > 0
          ? setting('Teams that earn it', [[1, 'Quickest only'], [2, 'Quickest two'], [3, 'Quickest three']], () => model.scoring?.fastPlaces ?? 1, (v) => setScoring('fastPlaces', Number(v)))
          : null,
        setting('Full leaderboard', [['round', 'End of each round (top five shown between)'], ['question', 'After every question']], () => model.scoring?.leaderboard ?? 'round', (v) => setScoring('leaderboard', v)),
      ),
      factsEditor(),
    );
  }

  /** Fun facts for the break screen, one per line. Blank means the built-in ones are used. */
  function factsEditor() {
    const box = h('textarea', {
      rows: 5,
      placeholder: 'One fact per line. Leave empty to use the built-in facts.',
      'aria-label': 'Fun facts for the break screen',
      oninput: (event) => {
        const lines = event.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
        model.facts = lines.length ? lines : undefined;
        changed();
      },
    });
    box.value = (model.facts ?? []).join('\n');
    return h(
      'div',
      { class: 'settings facts-editor' },
      h('label', {}, 'Break screen fun facts', h('small', { class: 'muted' }, ` (${(model.facts ?? []).length}, max 200 characters each)`)),
      box,
      h('button', {
        type: 'button',
        onclick: async () => {
          try {
            const { facts } = await api('GET', '/facts?count=10');
            model.facts = [...(model.facts ?? []), ...facts];
            changed();
            render();
          } catch {
            /* offline: leave the box as it is */
          }
        },
      }, 'Add 10 random built-in facts'),
    );
  }

  function previewOf(q) {
    if (!q) return null;
    const answer = (() => {
      switch (q.type) {
        case 'multiple-choice':
          return h('div', { class: 'options' }, q.options.map((o, i) =>
            h('div', { class: `option opt-${i}${i === q.answer ? ' chosen' : ''}` }, h('span', { class: 'letter' }, LETTERS[i]), h('span', {}, o || '…')),
          ));
        case 'buzzer':
          return h('div', { class: 'center' }, h('div', { class: 'big-buzzer', style: 'width:150px;margin:12px auto;font-size:1.3rem' }, 'BUZZ!'));
        case 'number':
        case 'nearest':
          return h('div', { class: 'text-answer' }, h('input', { disabled: true, placeholder: 'Type a number' }), h('div', { class: 'primary fake-button' }, 'Submit answer'));
        case 'picture':
        case 'music':
          return h('div', { class: 'text-answer' }, h('input', { disabled: true, placeholder: 'Type your answer' }), h('div', { class: 'primary fake-button' }, 'Submit answer'));
        case 'ordering':
          return h('div', { class: 'pool' }, [...q.items].reverse().map((item) => h('div', { class: 'pool-item' }, item || '…')));
        case 'letter':
          return h('div', { class: 'keypad' }, [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) =>
            h('div', { class: `key${l === (q.letter || normalise(q.answer)[0] || '').toUpperCase() ? ' chosen' : ''}` }, l),
          ));
      }
      return null;
    })();
    return h(
      'div',
      { class: 'phone-frame' },
      h('div', { class: 'screen' },
        q.type === 'music' ? h('p', { class: 'music-badge' }, '🎵 Listen to the music') : null,
        h('h2', { class: 'question-text' }, q.text || 'Your question'),
        q.image ? h('img', { class: 'question-image', src: imageUrl(q.image), alt: '' }) : null,
        answer,
      ),
    );
  }

  function renderPreview() {
    const box = container.querySelector('.preview-box');
    if (box) box.replaceChildren(previewOf(selected && find(selected)?.question) ?? '');
  }

  function render() {
    const where = selected && find(selected);
    const scroll = container.querySelector('.editor-sidebar')?.scrollTop;
    container.replaceChildren(
      h(
        'div',
        { class: 'editor' },
        h(
          'header',
          { class: 'editor-bar' },
          h('button', { type: 'button', class: 'back', onclick: async () => {
            await flush();
            onExit();
          } }, '← Quizzes'),
          h('input', {
            class: 'quiz-title-input',
            value: model.title,
            placeholder: 'Quiz title',
            'aria-label': 'Quiz title',
            oninput: (e) => {
              model.title = e.target.value;
              changed();
            },
          }),
          h('span', { class: 'problem-count' }),
          h('span', { class: 'save-status', role: 'status' }),
          h('button', { type: 'button', onclick: openBank }, '📚 Question bank'),
          h('a', { class: 'button', href: `/api/quizzes/${id}/export.zip?key=${encodeURIComponent(hostKey)}`, onclick: () => flush() }, 'Export'),
          h('button', { type: 'button', class: 'primary', onclick: run }, 'Run quiz ▶'),
        ),
        h('ul', { class: 'editor-problems', hidden: true }),
        h(
          'div',
          { class: 'editor-body' },
          sidebar(),
          h('section', { class: 'editor-main' }, where ? questionForm(where.question) : h('p', { class: 'muted' }, 'Add a question to get started.')),
          h('aside', { class: 'editor-preview' }, h('p', { class: 'muted small' }, 'What teams see'), h('div', { class: 'preview-box' })),
        ),
      ),
    );
    if (scroll) container.querySelector('.editor-sidebar').scrollTop = scroll;
    updateStatus();
    updateIssues();
    renderPreview();
  }

  const warnIfUnsaved = (e) => {
    if (saveState !== 'saved') e.preventDefault();
  };
  window.addEventListener('beforeunload', warnIfUnsaved);

  render();
  return {
    flush,
    destroy() {
      window.removeEventListener('beforeunload', warnIfUnsaved);
    },
  };
}
