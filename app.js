const state = {
  aulas: [],
  currentAula: null,
  currentMode: null,
  flashcards: {
    cards: [],
    index: 0,
    flipped: false,
  },
};

const els = {
  viewHome: document.getElementById('view-home'),
  viewStudy: document.getElementById('view-study'),
  aulasGrid: document.getElementById('aulasGrid'),
  aulasEmptyState: document.getElementById('aulasEmptyState'),
  estudoAulaNome: document.getElementById('estudoAulaNome'),
  modeButtons: Array.from(document.querySelectorAll('.mode-btn')),
  modeControls: document.getElementById('modeControls'),
  resultadoArea: document.getElementById('resultadoArea'),
  voltarPainelBtn: document.getElementById('voltarPainelBtn'),

  addAulaModal: document.getElementById('addAulaModal'),
  openAddAulaBtn: document.getElementById('openAddAulaBtn'),
  closeAddAulaBtn: document.getElementById('closeAddAulaBtn'),
  cancelAddAulaBtn: document.getElementById('cancelAddAulaBtn'),
  addAulaForm: document.getElementById('addAulaForm'),
  nomeAulaInput: document.getElementById('nomeAulaInput'),
  aulaTextoInput: document.getElementById('aulaTextoInput'),
  aulaArquivoInput: document.getElementById('aulaArquivoInput'),
  videosContainer: document.getElementById('videosContainer'),
  addVideoBtn: document.getElementById('addVideoBtn'),
  salvarAulaBtn: document.getElementById('salvarAulaBtn'),
  videoItemTemplate: document.getElementById('videoItemTemplate'),

  globalLoader: document.getElementById('globalLoader'),
  globalLoaderText: document.getElementById('globalLoaderText'),
};

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function setGlobalLoader(visible, message = 'Processando...') {
  els.globalLoaderText.textContent = message;
  els.globalLoader.classList.toggle('hidden', !visible);
}

function setSalvarAulaLoading(loading) {
  const btnText = els.salvarAulaBtn.querySelector('.btn-text');
  const btnLoader = els.salvarAulaBtn.querySelector('.btn-loader');

  els.salvarAulaBtn.disabled = loading;
  btnText.classList.toggle('hidden', loading);
  btnLoader.classList.toggle('hidden', !loading);
}

function setView(viewName) {
  const isHome = viewName === 'home';

  els.viewHome.classList.toggle('hidden', !isHome);
  els.viewHome.classList.toggle('active', isHome);
  els.viewStudy.classList.toggle('hidden', isHome);
  els.viewStudy.classList.toggle('active', !isHome);
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.erro || `Erro na requisicao (${response.status})`);
  }

  return data;
}

function renderAulas() {
  els.aulasGrid.innerHTML = '';

  if (!state.aulas.length) {
    els.aulasEmptyState.classList.remove('hidden');
    return;
  }

  els.aulasEmptyState.classList.add('hidden');

  state.aulas.forEach((aula) => {
    const card = document.createElement('article');
    card.className = 'aula-card';

    const title = document.createElement('h3');
    title.textContent = aula.nome;

    const meta = document.createElement('p');
    meta.className = 'aula-meta';
    meta.textContent = `${aula.totalVideos || 0} videos transcritos`;

    const actions = document.createElement('div');
    actions.className = 'aula-actions';

    const estudarBtn = document.createElement('button');
    estudarBtn.className = 'btn btn-primary';
    estudarBtn.type = 'button';
    estudarBtn.textContent = 'Estudar';
    estudarBtn.addEventListener('click', () => openStudyView(aula.nome));

    const excluirBtn = document.createElement('button');
    excluirBtn.className = 'btn btn-ghost';
    excluirBtn.type = 'button';
    excluirBtn.textContent = 'Excluir';
    excluirBtn.addEventListener('click', () => handleDeleteAula(aula.nome));

    actions.append(estudarBtn, excluirBtn);
    card.append(title, meta, actions);
    els.aulasGrid.append(card);
  });
}

async function loadAulas() {
  const data = await apiRequest('/api/aulas');
  state.aulas = Array.isArray(data.aulas) ? data.aulas : [];
  renderAulas();
}

function resetResultadosPlaceholder() {
  els.resultadoArea.innerHTML =
    '<p class="placeholder-text">Selecione um modo acima e clique em gerar para receber o conteudo.</p>';
}

function resetModeSelection() {
  state.currentMode = null;
  els.modeButtons.forEach((btn) => btn.classList.remove('active'));
  els.modeControls.innerHTML = '';
  resetResultadosPlaceholder();
}

function openStudyView(nomeAula) {
  state.currentAula = nomeAula;
  els.estudoAulaNome.textContent = nomeAula;
  resetModeSelection();
  setView('study');
}

function showModal() {
  els.addAulaModal.classList.remove('hidden');
  els.addAulaModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  els.addAulaModal.classList.add('hidden');
  els.addAulaModal.setAttribute('aria-hidden', 'true');
}

function clearAddAulaForm() {
  els.addAulaForm.reset();
  els.videosContainer.innerHTML = '';
  addVideoItem();
  setSalvarAulaLoading(false);
}

function addVideoItem(initialValues = {}) {
  const template = els.videoItemTemplate.content.firstElementChild.cloneNode(true);
  const title = template.querySelector('h4');
  const nomeInput = template.querySelector('.video-nome-input');
  const textoInput = template.querySelector('.video-texto-input');
  const removeBtn = template.querySelector('.remove-video-btn');

  const index = els.videosContainer.querySelectorAll('.video-item').length + 1;
  title.textContent = `Video ${index}`;

  nomeInput.value = initialValues.nome || '';
  textoInput.value = initialValues.texto || '';

  removeBtn.addEventListener('click', () => {
    template.remove();
    refreshVideoTitles();
  });

  els.videosContainer.append(template);
}

function refreshVideoTitles() {
  const items = Array.from(els.videosContainer.querySelectorAll('.video-item'));
  items.forEach((item, idx) => {
    const title = item.querySelector('h4');
    title.textContent = `Video ${idx + 1}`;
  });
}

function collectVideosFromForm() {
  const items = Array.from(els.videosContainer.querySelectorAll('.video-item'));

  return items
    .map((item, index) => {
      const nomeInput = item.querySelector('.video-nome-input');
      const textoInput = item.querySelector('.video-texto-input');
      const arquivoInput = item.querySelector('.video-arquivo-input');

      return {
        nome: (nomeInput.value || '').trim() || `Video ${index + 1}`,
        texto: (textoInput.value || '').trim(),
        arquivo: arquivoInput.files[0] || null,
      };
    })
    .filter((video) => video.texto || video.arquivo);
}

async function handleDeleteAula(nomeAula) {
  const confirmed = window.confirm(`Deseja realmente excluir a aula '${nomeAula}'?`);
  if (!confirmed) {
    return;
  }

  try {
    setGlobalLoader(true, 'Excluindo aula...');
    await apiRequest(`/api/aulas/${encodeURIComponent(nomeAula)}`, {
      method: 'DELETE',
    });
    await loadAulas();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setGlobalLoader(false);
  }
}

async function handleSubmitAddAula(event) {
  event.preventDefault();

  const nomeAula = els.nomeAulaInput.value.trim();
  const aulaTexto = els.aulaTextoInput.value.trim();
  const aulaArquivo = els.aulaArquivoInput.files[0] || null;
  const videos = collectVideosFromForm();

  if (!nomeAula) {
    window.alert('Informe o nome da aula.');
    return;
  }

  if (!aulaTexto && !aulaArquivo) {
    window.alert('Preencha a transcricao da aula (texto ou arquivo .txt/.pdf).');
    return;
  }

  if (!videos.length) {
    window.alert('Adicione ao menos uma transcricao de video (texto ou arquivo).');
    return;
  }

  const payload = new FormData();
  payload.append('nomeAula', nomeAula);
  payload.append('aulaTexto', aulaTexto);

  if (aulaArquivo) {
    payload.append('aulaArquivo', aulaArquivo);
  }

  const videosMeta = videos.map((video, index) => {
    if (video.arquivo) {
      payload.append(`videoArquivo_${index}`, video.arquivo);
    }

    return {
      nome: video.nome,
      texto: video.texto,
    };
  });

  payload.append('videos', JSON.stringify(videosMeta));

  try {
    setSalvarAulaLoading(true);
    await apiRequest('/api/aulas', {
      method: 'POST',
      body: payload,
    });

    closeModal();
    clearAddAulaForm();
    await loadAulas();
    window.alert('Aula salva com sucesso.');
  } catch (error) {
    window.alert(error.message);
  } finally {
    setSalvarAulaLoading(false);
  }
}

function convertInlineMarkdown(text) {
  let output = escapeHtml(text);
  output = output.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  output = output.replace(/\*(.+?)\*/g, '<em>$1</em>');
  output = output.replace(/`([^`]+)`/g, '<code>$1</code>');
  return output;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const chunks = [];
  let inList = false;

  function closeListIfOpen() {
    if (inList) {
      chunks.push('</ul>');
      inList = false;
    }
  }

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      closeListIfOpen();
      return;
    }

    const headingMatch = /^(#{1,6})\s+(.+)/.exec(trimmed);
    if (headingMatch) {
      closeListIfOpen();
      const level = headingMatch[1].length;
      chunks.push(`<h${level}>${convertInlineMarkdown(headingMatch[2])}</h${level}>`);
      return;
    }

    const listMatch = /^[-*]\s+(.+)/.exec(trimmed);
    if (listMatch) {
      if (!inList) {
        chunks.push('<ul>');
        inList = true;
      }
      chunks.push(`<li>${convertInlineMarkdown(listMatch[1])}</li>`);
      return;
    }

    closeListIfOpen();
    chunks.push(`<p>${convertInlineMarkdown(trimmed)}</p>`);
  });

  closeListIfOpen();
  return `<div class="markdown-output">${chunks.join('')}</div>`;
}

function extractAulaBadges(text) {
  const regex = /aula\s*[:\-]\s*([^\n]+)/gi;
  const found = new Set();
  let match = regex.exec(text);

  while (match) {
    found.add(match[1].trim());
    match = regex.exec(text);
  }

  return Array.from(found);
}

function renderBuscaResultado(text) {
  const badges = extractAulaBadges(text);
  const badgesHtml = badges.length
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">${badges
        .map((name) => `<span class="badge badge-aula">${escapeHtml(name)}</span>`)
        .join('')}</div>`
    : '';

  els.resultadoArea.innerHTML = `${badgesHtml}${markdownToHtml(text)}`;
}

function parseMindMapLines(markdown) {
  const lines = String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line));

  return lines.map((line) => {
    const spaces = (line.match(/^\s*/) || [''])[0].length;
    const level = Math.floor(spaces / 2);
    const label = line.replace(/^\s*[-*]\s+/, '').trim();

    return {
      level,
      label,
      children: [],
    };
  });
}

function buildMindMapTree(nodes) {
  const root = [];
  const stack = [];

  nodes.forEach((node) => {
    const current = {
      label: node.label,
      children: [],
    };

    while (stack.length && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }

    if (!stack.length) {
      root.push(current);
    } else {
      stack[stack.length - 1].node.children.push(current);
    }

    stack.push({ level: node.level, node: current });
  });

  return root;
}

function createTreeNode(node) {
  const li = document.createElement('li');
  li.className = 'tree-node';

  const label = document.createElement('span');
  label.className = 'tree-label';

  const hasChildren = node.children.length > 0;

  if (hasChildren) {
    const caret = document.createElement('span');
    caret.className = 'tree-caret';
    caret.textContent = '▾';
    label.append(caret);

    label.addEventListener('click', () => {
      li.classList.toggle('collapsed');
    });
  } else {
    const dot = document.createElement('span');
    dot.className = 'tree-caret';
    dot.textContent = '•';
    label.append(dot);
  }

  const text = document.createElement('span');
  text.textContent = node.label;
  label.append(text);

  li.append(label);

  if (hasChildren) {
    const ul = document.createElement('ul');
    node.children.forEach((child) => ul.append(createTreeNode(child)));
    li.append(ul);
  }

  return li;
}

function renderMindMap(markdown) {
  const parsedLines = parseMindMapLines(markdown);

  if (!parsedLines.length) {
    els.resultadoArea.innerHTML = markdownToHtml(markdown);
    return;
  }

  const tree = buildMindMapTree(parsedLines);
  const container = document.createElement('div');
  const root = document.createElement('ul');
  root.className = 'tree-root';

  tree.forEach((node) => root.append(createTreeNode(node)));
  container.append(root);

  els.resultadoArea.innerHTML = '';
  els.resultadoArea.append(container);
}

function shuffleArray(items) {
  const arr = [...items];

  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function updateFlashcardView() {
  const cards = state.flashcards.cards;
  const current = cards[state.flashcards.index];

  const counter = document.getElementById('flashcardsCounter');
  const question = document.getElementById('flashcardPergunta');
  const answer = document.getElementById('flashcardResposta');
  const card = document.getElementById('flashcard');

  if (!current || !counter || !question || !answer || !card) {
    return;
  }

  counter.textContent = `${state.flashcards.index + 1}/${cards.length}`;
  question.textContent = current.pergunta;
  answer.textContent = current.resposta;

  state.flashcards.flipped = false;
  card.classList.remove('is-flipped');
}

function renderFlashcards(cards) {
  state.flashcards.cards = cards;
  state.flashcards.index = 0;
  state.flashcards.flipped = false;

  els.resultadoArea.innerHTML = `
    <div class="flashcards-wrap">
      <div class="flashcards-nav">
        <div class="flashcards-actions">
          <button id="flashcardsPrevBtn" class="btn btn-ghost" type="button">Anterior</button>
          <button id="flashcardsNextBtn" class="btn btn-ghost" type="button">Proximo</button>
          <button id="flashcardsShuffleBtn" class="btn btn-secondary" type="button">Embaralhar</button>
        </div>
        <span id="flashcardsCounter" class="counter-pill">1/${cards.length}</span>
      </div>

      <div class="flashcard-stage">
        <article id="flashcard" class="flashcard" role="button" tabindex="0">
          <div class="flashcard-face flashcard-front">
            <h3>Pergunta</h3>
            <p id="flashcardPergunta"></p>
          </div>
          <div class="flashcard-face flashcard-back">
            <h3>Resposta</h3>
            <p id="flashcardResposta"></p>
          </div>
        </article>
      </div>
    </div>
  `;

  const card = document.getElementById('flashcard');
  const prevBtn = document.getElementById('flashcardsPrevBtn');
  const nextBtn = document.getElementById('flashcardsNextBtn');
  const shuffleBtn = document.getElementById('flashcardsShuffleBtn');

  card.addEventListener('click', () => {
    state.flashcards.flipped = !state.flashcards.flipped;
    card.classList.toggle('is-flipped', state.flashcards.flipped);
  });

  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      card.click();
    }
  });

  prevBtn.addEventListener('click', () => {
    const total = state.flashcards.cards.length;
    state.flashcards.index = (state.flashcards.index - 1 + total) % total;
    updateFlashcardView();
  });

  nextBtn.addEventListener('click', () => {
    const total = state.flashcards.cards.length;
    state.flashcards.index = (state.flashcards.index + 1) % total;
    updateFlashcardView();
  });

  shuffleBtn.addEventListener('click', () => {
    state.flashcards.cards = shuffleArray(state.flashcards.cards);
    state.flashcards.index = 0;
    updateFlashcardView();
  });

  updateFlashcardView();
}

function parseFlashcardsResponse(responseText) {
  const text = String(responseText || '').trim();

  if (!text) {
    throw new Error('Resposta vazia para flashcards.');
  }

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error('Formato de flashcards invalido.');
  }

  const normalized = parsed
    .map((item) => ({
      pergunta: String(item?.pergunta || '').trim(),
      resposta: String(item?.resposta || '').trim(),
    }))
    .filter((item) => item.pergunta && item.resposta);

  if (!normalized.length) {
    throw new Error('Nenhum flashcard valido foi retornado.');
  }

  return normalized;
}

function renderModeControls() {
  if (!state.currentMode) {
    els.modeControls.innerHTML = '';
    return;
  }

  if (state.currentMode === 'busca por tema') {
    els.modeControls.innerHTML = `
      <div class="inline-controls">
        <input id="temaBuscaInput" type="text" placeholder="Digite o tema para buscar em todas as aulas" />
        <button id="buscarTemaBtn" class="btn btn-primary" type="button">Buscar</button>
      </div>
    `;

    const input = document.getElementById('temaBuscaInput');
    const button = document.getElementById('buscarTemaBtn');

    button.addEventListener('click', () => handleBuscarTema(input.value.trim()));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleBuscarTema(input.value.trim());
      }
    });

    return;
  }

  els.modeControls.innerHTML = `
    <div class="inline-controls">
      <button id="gerarModoBtn" class="btn btn-primary" type="button">Gerar</button>
    </div>
  `;

  document
    .getElementById('gerarModoBtn')
    .addEventListener('click', () => handleGerarModo(state.currentMode));
}

function markActiveModeButton() {
  els.modeButtons.forEach((btn) => {
    const isActive = btn.dataset.modo === state.currentMode;
    btn.classList.toggle('active', isActive);
  });
}

async function callGemini({ modo, aula, tema }) {
  const data = await apiRequest('/api/gemini', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ modo, aula, tema }),
  });

  return data.resposta;
}

async function handleGerarModo(modo) {
  if (!state.currentAula) {
    window.alert('Nenhuma aula selecionada.');
    return;
  }

  try {
    setGlobalLoader(true, 'Gerando resposta com Gemini...');
    const resposta = await callGemini({ modo, aula: state.currentAula });

    if (modo === 'mapa mental') {
      renderMindMap(resposta);
      return;
    }

    if (modo === 'flashcards') {
      const cards = parseFlashcardsResponse(resposta);
      renderFlashcards(cards);
      return;
    }

    els.resultadoArea.innerHTML = markdownToHtml(resposta);
  } catch (error) {
    window.alert(error.message);
  } finally {
    setGlobalLoader(false);
  }
}

async function handleBuscarTema(tema) {
  if (!tema) {
    window.alert('Digite um tema para buscar.');
    return;
  }

  try {
    setGlobalLoader(true, 'Buscando tema em todas as aulas...');
    const resposta = await callGemini({ modo: 'busca por tema', tema });
    renderBuscaResultado(resposta);
  } catch (error) {
    window.alert(error.message);
  } finally {
    setGlobalLoader(false);
  }
}

function onSelectMode(modo) {
  state.currentMode = modo;
  markActiveModeButton();
  renderModeControls();
  resetResultadosPlaceholder();
}

function bindEvents() {
  els.openAddAulaBtn.addEventListener('click', () => {
    clearAddAulaForm();
    showModal();
  });

  els.closeAddAulaBtn.addEventListener('click', closeModal);
  els.cancelAddAulaBtn.addEventListener('click', closeModal);

  els.addAulaModal.addEventListener('click', (event) => {
    if (event.target && event.target.dataset.closeModal === 'true') {
      closeModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.addAulaModal.classList.contains('hidden')) {
      closeModal();
    }
  });

  els.addVideoBtn.addEventListener('click', () => addVideoItem());
  els.addAulaForm.addEventListener('submit', handleSubmitAddAula);

  els.voltarPainelBtn.addEventListener('click', () => {
    setView('home');
    state.currentAula = null;
  });

  els.modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => onSelectMode(btn.dataset.modo));
  });
}

async function init() {
  bindEvents();
  clearAddAulaForm();

  try {
    setGlobalLoader(true, 'Carregando aulas...');
    await loadAulas();
  } catch (error) {
    window.alert(error.message);
  } finally {
    setGlobalLoader(false);
  }
}

init();
