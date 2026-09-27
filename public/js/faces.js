'use strict';

(function () {
  'use strict';

  const el = {
    grid: document.getElementById('faces-grid'),
    empty: document.getElementById('faces-empty'),
    count: document.getElementById('faces-count'),
  };

  const state = { isTeacher: false };

  async function init() {
    try {
      const me = await Api.me();
      state.isTeacher = !!me.authenticated;
    } catch (_) {
      state.isTeacher = false;
    }
    await load();
  }

  async function load() {
    try {
      const { users } = await Api.listUsers();
      render(users);
    } catch (err) {
      el.count.textContent = 'Erro ao carregar: ' + err.message;
    }
  }

  function render(users) {
    el.grid.innerHTML = '';
    el.count.textContent = `${users.length} aluno(s) cadastrado(s).`;
    el.empty.hidden = users.length > 0;

    const sorted = users
      .slice()
      .sort((a, b) =>
        String(a.classroom || '').localeCompare(String(b.classroom || '')) ||
        (a.rollNumber || 0) - (b.rollNumber || 0)
      );
    for (const u of sorted) el.grid.appendChild(card(u));
  }

  function card(user) {
    const div = document.createElement('div');
    div.className = 'face-card';

    const img = document.createElement('img');
    img.className = 'face-card__photo';
    img.alt = user.name;
    img.src = user.photo || ghostIcon();

    const info = document.createElement('div');
    info.className = 'face-card__info';
    appendLine(
      info,
      'span',
      `Sala ${user.classroom || '-'} · Nº ${user.rollNumber == null ? '-' : user.rollNumber}`,
      'face-card__roll'
    );
    appendLine(info, 'strong', user.name);
    appendLine(info, 'span', `${user.sampleCount || 0} vetor(es) facial(is)`);
    if (user.createdAt) {
      appendLine(info, 'span', `Cadastrado em ${new Date(user.createdAt).toLocaleDateString('pt-BR')}`);
    }

    div.appendChild(img);
    div.appendChild(info);

    if (state.isTeacher) {
      const actions = document.createElement('div');
      actions.className = 'face-card__actions';
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'remover';
      del.addEventListener('click', () => remove(user));
      actions.appendChild(del);
      div.appendChild(actions);
    }

    return div;
  }

  function appendLine(parent, tag, text, className) {
    const node = document.createElement(tag);
    node.textContent = text;
    if (className) node.className = className;
    parent.appendChild(node);
  }

  function ghostIcon() {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="76" height="76">' +
      '<rect width="76" height="76" fill="#e2e8f0"/>' +
      '<circle cx="38" cy="30" r="13" fill="#94a3b8"/>' +
      '<ellipse cx="38" cy="62" rx="22" ry="15" fill="#94a3b8"/>' +
      '</svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  async function remove(user) {
    if (!confirm(`Remover ${user.name}? As presencas tambem serao apagadas.`)) return;
    try {
      await Api.deleteUser(user.id);
      await load();
    } catch (err) {
      alert(err.status === 401 ? 'Entre como professor para remover.' : err.message);
    }
  }

  init();
})();
