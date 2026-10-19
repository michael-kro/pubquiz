// The Branding panel on the host screen: name, tagline, two colours and a logo, with a live preview.
import { contrast, h, paletteFor, setBranding } from './common.js';

const SAVE_DELAY_MS = 600;
const HEX = /^#[0-9a-f]{6}$/i;

export async function mountBranding(container, { api, onExit }) {
  let info;
  try {
    info = await api('GET', '/branding');
  } catch (error) {
    container.replaceChildren(
      h('section', { class: 'screen center' }, h('h1', {}, "Can't open branding"), h('p', {}, error.message), h('button', { class: 'primary', onclick: onExit }, 'Back')),
    );
    return;
  }
  const editable = info.editable !== false;
  const formFrom = (i) => ({ name: i.name, tagline: i.tagline, accent: i.accent, background: i.background, showName: i.showName !== false });
  const form = formFrom(info);
  let status = 'saved';
  let message = '';
  let timer;

  const apply = () => {
    if (HEX.test(form.accent) && HEX.test(form.background)) setBranding({ ...info, ...form });
  };

  async function save() {
    clearTimeout(timer);
    timer = undefined;
    status = 'saving';
    paintStatus();
    try {
      info = await api('PUT', '/branding', form);
      status = 'saved';
      message = '';
    } catch (error) {
      status = 'failed';
      message = error.message;
    }
    paintStatus();
  }

  function changed() {
    status = 'pending';
    message = '';
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
    apply();
    paintStatus();
    paintPreview();
  }

  function paintStatus() {
    const el = container.querySelector('.save-status');
    if (el) {
      el.textContent = { saved: 'All changes saved', pending: 'Saving…', saving: 'Saving…', failed: message || "Couldn't save" }[status];
      el.classList.toggle('failed', status === 'failed');
    }
  }

  function contrastNote() {
    if (!HEX.test(form.accent) || !HEX.test(form.background)) return '';
    const ratio = contrast(form.accent, form.background);
    return ratio < 3 ? `The accent colour is hard to see against this background (contrast ${ratio.toFixed(1)}; aim for 3 or more).` : '';
  }

  function paintPreview() {
    const box = container.querySelector('.brand-preview');
    if (!box || !HEX.test(form.accent) || !HEX.test(form.background)) return;
    const p = paletteFor(form.background, form.accent);
    box.style.cssText = Object.entries(p)
      .filter(([k]) => k.startsWith('--'))
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    // Like the real pages: the name is written out under the logo unless that is switched off.
    box.querySelector('.brand-name')?.replaceChildren(form.showName ? form.name || 'Your venue' : '');
    box.querySelector('.brand-tagline')?.replaceChildren(form.tagline);
    const warn = container.querySelector('.contrast-note');
    if (warn) warn.textContent = contrastNote();
  }

  async function uploadLogo(file) {
    message = '';
    try {
      info = await api('POST', `/branding/logo?name=${encodeURIComponent(file.name)}`, file);
      setBranding({ ...info, ...form });
      render();
    } catch (error) {
      status = 'failed';
      message = error.message;
      paintStatus();
    }
  }

  async function removeLogo() {
    info = await api('DELETE', '/branding/logo');
    setBranding({ ...info, ...form });
    render();
  }

  /** Switching venues: the active profile is what every page shows, and what this panel edits. */
  async function switchTo(id) {
    if (timer) await save();
    try {
      info = await api('POST', '/branding/active', { id });
      Object.assign(form, formFrom(info));
      setBranding({ ...info, ...form });
      render();
    } catch (error) {
      status = 'failed';
      message = error.message;
      paintStatus();
    }
  }

  async function addProfile() {
    const name = prompt('Name of the new venue (for example, The Red Lion):');
    if (!name || !name.trim()) return;
    const copy = info.profiles.length > 0 && confirm(`Start "${name.trim()}" as a copy of "${info.profiles.find((p) => p.id === info.active)?.label ?? 'the current venue'}"?\n\nOK copies its colours and logo to start from. Cancel starts from a blank one.`);
    try {
      info = await api('POST', '/branding/profiles', { name: name.trim(), copyFrom: copy ? info.active : undefined, activate: true });
      Object.assign(form, formFrom(info));
      setBranding({ ...info, ...form });
      render();
    } catch (error) {
      status = 'failed';
      message = error.message;
      paintStatus();
    }
  }

  async function deleteProfile() {
    const current = info.profiles.find((p) => p.id === info.active);
    if (!confirm(`Delete the venue "${current?.label ?? info.active}" and its logo? This cannot be undone.`)) return;
    try {
      info = await api('DELETE', `/branding/profiles/${encodeURIComponent(info.active)}`);
      Object.assign(form, formFrom(info));
      setBranding({ ...info, ...form });
      render();
    } catch (error) {
      status = 'failed';
      message = error.message;
      paintStatus();
    }
  }

  function profileBar() {
    if (!info.profiles) return null;
    return h(
      'div',
      { class: 'profile-bar' },
      h('span', { class: 'field-label' }, 'Venue'),
      h(
        'div',
        { class: 'profile-tabs', role: 'tablist' },
        info.profiles.map((p) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(p.id === info.active), class: p.id === info.active ? 'primary' : '', onclick: () => p.id !== info.active && switchTo(p.id) }, p.label)),
      ),
      h('button', { type: 'button', onclick: addProfile }, '+ New venue'),
      info.profiles.length > 1 ? h('button', { type: 'button', class: 'link-button', onclick: deleteProfile }, 'Delete this venue') : null,
      h('p', { class: 'hint' }, 'The selected venue is the one every screen shows. Switch here before a quiz at a different pub.'),
    );
  }

  function colourField(label, key) {
    return h(
      'div',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h(
        'div',
        { class: 'colour-row' },
        h('input', {
          type: 'color',
          value: HEX.test(form[key]) ? form[key] : '#000000',
          disabled: !editable,
          'aria-label': `${label} picker`,
          oninput: (e) => {
            form[key] = e.target.value;
            container.querySelector(`[data-hex="${key}"]`).value = e.target.value;
            changed();
          },
        }),
        h('input', {
          class: 'hex',
          'data-hex': key,
          value: form[key],
          disabled: !editable,
          maxlength: '7',
          spellcheck: 'false',
          'aria-label': `${label} as a hex code`,
          oninput: (e) => {
            form[key] = e.target.value.trim();
            const picker = e.target.parentElement.querySelector('input[type=color]');
            if (HEX.test(form[key])) picker.value = form[key];
            changed();
          },
        }),
      ),
    );
  }

  function textField(label, key, max, hint) {
    return h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h('input', {
        value: form[key],
        maxlength: String(max),
        disabled: !editable,
        oninput: (e) => {
          form[key] = e.target.value;
          changed();
        },
      }),
      hint ? h('span', { class: 'hint' }, hint) : null,
    );
  }

  function render() {
    container.replaceChildren(
      h(
        'div',
        { class: 'library branding-page' },
        h(
          'header',
          { class: 'library-bar' },
          h('button', { type: 'button', class: 'back', onclick: async () => {
            if (timer) await save();
            onExit();
          } }, '← Quizzes'),
          h('h1', {}, 'Branding'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'save-status', role: 'status' }),
        ),
        profileBar(),
        editable ? null : h('p', { class: 'problem' }, 'This branding comes from a folder given on the command line, so it can only be changed by editing the files there.'),
        h(
          'div',
          { class: 'branding-grid' },
          h(
            'div',
            { class: 'branding-form' },
            textField('Name', 'name', 40, 'Shown on the team phones and as the page title.'),
            h(
              'label',
              { class: 'check' },
              h('input', {
                type: 'checkbox',
                checked: form.showName,
                disabled: !editable,
                onchange: (e) => {
                  form.showName = e.target.checked;
                  changed();
                },
              }),
              ' Show the name under the logo (untick if your logo already says it)',
            ),
            textField('Tagline', 'tagline', 80),
            colourField('Accent colour (buttons and highlights)', 'accent'),
            colourField('Background colour', 'background'),
            h('p', { class: 'problem contrast-note', role: 'status' }),
            h(
              'div',
              { class: 'field' },
              h('span', { class: 'field-label' }, 'Logo'),
              h(
                'div',
                { class: 'logo-field' },
                info.logo ? h('img', { class: 'logo-thumb', src: info.logo, alt: 'Current logo' }) : h('span', { class: 'muted' }, 'No logo yet'),
                editable
                  ? h(
                      'div',
                      { class: 'image-actions' },
                      h('input', {
                        type: 'file',
                        accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
                        'aria-label': 'Upload a logo',
                        onchange: (e) => e.target.files[0] && uploadLogo(e.target.files[0]),
                      }),
                      info.logo ? h('button', { type: 'button', class: 'link-button', onclick: removeLogo }, 'Remove logo') : null,
                      h('span', { class: 'hint' }, 'PNG, JPEG, WebP or SVG, up to 2 MB. A logo with a transparent background works best.'),
                    )
                  : null,
              ),
            ),
          ),
          h(
            'div',
            { class: 'brand-preview', role: 'img', 'aria-label': 'Preview of the team screen' },
            h(
              'div',
              { class: 'preview-screen' },
              info.logo ? h('img', { class: 'brand-logo big', src: info.logo, alt: '' }) : null,
              h('p', { class: 'brand-name' }),
              h('p', { class: 'brand-tagline' }),
              h('h2', {}, 'Join the quiz'),
              h('div', { class: 'preview-input' }, 'Team name'),
              h('div', { class: 'primary preview-button' }, 'Join'),
              h('div', { class: 'preview-card' }, h('span', {}, 'Leaderboard'), h('strong', {}, '1st')),
            ),
          ),
        ),
      ),
    );
    paintStatus();
    paintPreview();
  }

  render();
}
