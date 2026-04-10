const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { PDFParse } = require('pdf-parse');

const LOGIN_URL_PADRAO = 'https://on.fiap.com.br/index.php';
const DASHBOARD_URL_PADRAO = 'https://on.fiap.com.br/local/salavirtual/conteudo-digital.php';
const SESSION_FILE_PADRAO = path.join(process.cwd(), '.fiap-session.json');

const LOGIN_SELECTORS = {
  user: '#username-plataforma',
  pass: '#password-plataforma',
  button: '#loginbtn-plataforma',
};

const MAIN_CONTENT_SELECTORS = [
  '.aula-content',
  'main[role="main"]',
  'article.lesson-body',
  '.content',
  '#region-main',
  '.box.generalbox',
  'main',
];

const TRANSCRIPT_TOGGLE_SELECTORS = [
  'button.transcricao-btn',
  '[data-action="toggle-transcript"]',
  '.video-transcript-toggle',
  '[aria-controls*="transcript"]',
  '[data-target*="transcript"]',
  '.accordion-button',
  '.btn-transcricao',
];

const TRANSCRIPT_BLOCK_SELECTORS = [
  '.video-transcript',
  '.transcricao',
  '.transcript',
  '[data-transcript]',
  '.accordion-body',
  '.texto-transcricao',
  '.legenda',
  '.captions',
];

const TRANSCRIPT_HINT_PATTERN = /(transcri|legenda|caption|closed\s*caption|cc\b|materiais?)/i;
const MIN_MAIN_TEXT_LENGTH = 180;
const NON_LESSON_TEXT_PATTERNS = [
  'foi removido do grupo da atividade',
  'entregue se',
  'conteudo digital',
  'salavirtual',
  'ambiente virtual',
  'comunicados',
  'cronograma',
];

const TRANSCRIPT_NOISE_LINE_PATTERNS = [
  /^x$/i,
  /^indice$/i,
  /^lista de audios$/i,
  /^lista de videos$/i,
  /^configuracoes$/i,
  /^voltar para a lista de conteudos$/i,
  /^anterior$/i,
  /^proximo$/i,
  /^playlist$/i,
  /^autoplay$/i,
  /^transcricao$/i,
  /^transcricoes$/i,
  /^transcricoes e materiais$/i,
  /^material complementar$/i,
  /^em progresso$/i,
  /^visualizado:\s*\d+%$/i,
  /^video\s*\d+\s*de\s*\d+$/i,
  /^\d+\s*de\s*\d+$/i,
];

const PDF_INVALID_STRUCTURE_PATTERN = /invalid\s+pdf\s+structure/i;

const EXCLUDED_LESSON_TITLE_PATTERNS = [
  'welcome to data analytics',
];

const EXCLUDED_CONTENT_GROUP_NAME_PATTERNS = [
  'welcome to data analytics',
];

const MIN_LESSONS_PER_CONTENT_DEFAULT = 4;

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ').trim();
}

function uniqueValues(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    return false;
  }
}

function isDashboardUrl(url) {
  return String(url || '').includes('/local/salavirtual/conteudo-digital.php');
}

function normalizeLessonType(url) {
  const value = String(url || '');

  if (value.includes('/mod/conteudospdf/')) {
    return 'pdf';
  }

  return 'html';
}

function resolveAbsoluteUrl(baseUrl, rawUrl) {
  try {
    return new URL(String(rawUrl || ''), String(baseUrl || LOGIN_URL_PADRAO)).toString();
  } catch (error) {
    return '';
  }
}

function normalizeComparableText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLessonUrl(url) {
  return /\/mod\/conteudos(html|pdf)\//i.test(String(url || ''));
}

function isLikelyNonLessonText(value) {
  const normalized = normalizeComparableText(value);

  if (!normalized) {
    return false;
  }

  return NON_LESSON_TEXT_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function sanitizeTranscriptChunk(value) {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
  const cleaned = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const normalized = normalizeComparableText(line);

      if (!normalized) {
        return false;
      }

      return !TRANSCRIPT_NOISE_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
    });

  return normalizeText(cleaned.join('\n'));
}

function guessPdfFileName(url) {
  try {
    const parsed = new URL(String(url || ''));
    const fileName = String(parsed.pathname || '').split('/').pop() || '';

    if (/\.pdf$/i.test(fileName)) {
      return fileName;
    }
  } catch (error) {
    // fallback abaixo
  }

  return 'material.pdf';
}

async function getPageAndFrameTargets(page) {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  return [page.mainFrame(), ...frames];
}

async function clickTranscriptHintsInTarget(target) {
  await target.evaluate((hintRegexSource) => {
    const hintRegex = new RegExp(hintRegexSource, 'i');
    const candidates = Array.from(
      document.querySelectorAll(
        'button, a, [role="button"], [role="tab"], .nav-link, .tablinks, [aria-controls], [data-toggle]'
      )
    );

    candidates.forEach((node) => {
      const text = String(node.textContent || node.getAttribute('aria-label') || '').trim();
      const controls = String(node.getAttribute('aria-controls') || node.getAttribute('data-target') || '').trim();
      const targetText = `${text} ${controls}`;

      if (!hintRegex.test(targetText)) {
        return;
      }

      const element = node;
      const style = window.getComputedStyle(element);
      const visible = style.display !== 'none' && style.visibility !== 'hidden';

      if (!visible || element.hasAttribute('disabled')) {
        return;
      }

      element.click();
    });
  }, TRANSCRIPT_HINT_PATTERN.source).catch(() => {});
}

async function clickTranscriptListItemsInTarget(target) {
  await target.evaluate(() => {
    const normalize = (value) =>
      String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const roots = Array.from(document.querySelectorAll('section, aside, div, article'))
      .filter((node) => {
        const text = normalize(node.textContent || '');
        return text.includes('transcricoes') && text.includes('materiais');
      })
      .slice(0, 4);

    const itemPattern = /(^#\d+)|(aula\s*\d)|(video\s*\d)/i;

    roots.forEach((root) => {
      const clickables = Array.from(root.querySelectorAll('button, a, [role="button"], [role="tab"], li, [tabindex]'))
        .filter((node) => {
          const text = String(node.textContent || '').trim();
          return text.length > 3 && text.length < 140 && itemPattern.test(text);
        })
        .slice(0, 12);

      clickables.forEach((node) => {
        const element = node;
        const style = window.getComputedStyle(element);
        const visible = style.display !== 'none' && style.visibility !== 'hidden';

        if (!visible || element.hasAttribute('disabled')) {
          return;
        }

        element.click();
      });
    });
  }).catch(() => {});
}

async function collectPanelTranscriptChunksFromTarget(target) {
  const transcripts = await target.evaluate(() => {
    const normalize = (value) =>
      String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u00a0/g, ' ')
        .trim();

    const roots = Array.from(document.querySelectorAll('section, aside, div, article'))
      .filter((node) => {
        const text = String(node.textContent || '').toLowerCase();
        return text.includes('transcri') && text.includes('material');
      })
      .slice(0, 4);

    const chunks = [];

    roots.forEach((root) => {
      const nodes = Array.from(root.querySelectorAll('p, li, .text, .content, .description, [class*="transcri"], [id*="transcri"]'));

      nodes.forEach((node) => {
        const text = normalize(node.innerText || node.textContent || '');

        if (text.length >= 80) {
          chunks.push(text);
        }
      });
    });

    return chunks;
  }).catch(() => []);

  return uniqueValues(transcripts.map(normalizeText));
}

async function tryScrapePdfThenHtml(page, aulaUrl) {
  try {
    return await scrapePdfLesson(page, aulaUrl);
  } catch (error) {
    const message = String(error?.message || '');

    if (
      PDF_INVALID_STRUCTURE_PATTERN.test(message)
      || message.includes('Nao foi possivel localizar o PDF')
      || message.includes('Status 4')
      || message.includes('Status 5')
    ) {
      return scrapeHtmlLesson(page, aulaUrl);
    }

    throw error;
  }
}

async function collectTextCandidatesFromTarget(target) {
  const chunks = await target.evaluate((selectors) => {
    const collected = [];

    selectors.forEach((selector) => {
      const nodes = Array.from(document.querySelectorAll(selector));

      nodes.forEach((node) => {
        const text = String(node.innerText || '').trim();

        if (text.length > 80) {
          collected.push(text);
        }
      });
    });

    const bodyText = String(document.body?.innerText || '').trim();
    if (bodyText.length > 80) {
      collected.push(bodyText);
    }

    return collected;
  }, MAIN_CONTENT_SELECTORS).catch(() => []);

  return uniqueValues(chunks.map(normalizeText));
}

async function collectTranscriptBlocksFromTarget(target) {
  const transcripts = await target.evaluate((selectors) => {
    const chunks = [];

    selectors.forEach((selector) => {
      const nodes = Array.from(document.querySelectorAll(selector));

      nodes.forEach((node) => {
        const text = String(node.innerText || '').trim();
        if (text.length > 40) {
          chunks.push(text);
        }
      });
    });

    return chunks;
  }, TRANSCRIPT_BLOCK_SELECTORS).catch(() => []);

  return uniqueValues(transcripts.map(normalizeText));
}

async function collectSubtitleTrackUrlsFromTarget(target, pageUrl) {
  const urls = await target.evaluate(() => {
    const tracks = Array.from(document.querySelectorAll('track[src]')).map((track) => track.getAttribute('src'));
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => anchor.getAttribute('href'))
      .filter((href) => /\.(vtt|srt)(\?|$)/i.test(String(href || '')));

    return [...tracks, ...anchors].filter(Boolean);
  }).catch(() => []);

  return uniqueValues(urls.map((url) => resolveAbsoluteUrl(pageUrl, url)));
}

async function assertOnLessonPage(page, aulaUrl) {
  const currentUrl = String(page.url() || '');

  if (isDashboardUrl(currentUrl)) {
    throw new Error('A FIAP redirecionou para o dashboard. Refaça o login e tente novamente.');
  }

  if (!isLessonUrl(currentUrl) && !isLessonUrl(aulaUrl)) {
    throw new Error('URL da aula FIAP invalida ou sem permissao de acesso.');
  }
}

function shouldExcludeLessonByTitle(title) {
  const normalizedTitle = normalizeComparableText(title);

  if (!normalizedTitle) {
    return false;
  }

  return EXCLUDED_LESSON_TITLE_PATTERNS.some((pattern) => normalizedTitle.includes(pattern));
}

function shouldExcludeContentGroupByName(name) {
  const normalizedName = normalizeComparableText(name);

  if (!normalizedName) {
    return false;
  }

  return EXCLUDED_CONTENT_GROUP_NAME_PATTERNS.some((pattern) => normalizedName.includes(pattern));
}

function resolveMinLessonsPerContent(value) {
  const numeric = Number(value);

  if (!Number.isInteger(numeric) || numeric < 1) {
    return MIN_LESSONS_PER_CONTENT_DEFAULT;
  }

  return numeric;
}

function cleanSubtitleText(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const cleaned = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !/^\d{2}:\d{2}:\d{2}[\.,]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[\.,]\d{3}$/.test(line))
    .filter((line) => !/^WEBVTT$/i.test(line));

  return normalizeText(cleaned.join(' '));
}

async function ensureAuthenticated(page, options) {
  const loginUrl = options.loginUrl || LOGIN_URL_PADRAO;
  const dashboardUrl = options.dashboardUrl || DASHBOARD_URL_PADRAO;
  const fiapUser = String(options.user || process.env.FIAP_USER || '').trim();
  const fiapPass = String(options.password || process.env.FIAP_PASS || '').trim();

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  if (isDashboardUrl(page.url())) {
    return;
  }

  if (!fiapUser || !fiapPass) {
    throw new Error('Sessao FIAP expirada e FIAP_USER/FIAP_PASS nao configurados no .env.');
  }

  await page.waitForSelector(LOGIN_SELECTORS.user, { timeout: 15000 });
  await page.waitForSelector(LOGIN_SELECTORS.pass, { timeout: 15000 });
  await page.fill(LOGIN_SELECTORS.user, fiapUser);
  await page.fill(LOGIN_SELECTORS.pass, fiapPass);

  await page.waitForFunction(
    (selector) => {
      const button = document.querySelector(selector);
      return Boolean(button && !button.hasAttribute('disabled'));
    },
    LOGIN_SELECTORS.button,
    { timeout: 10000 }
  );

  await Promise.all([
    page.waitForURL((targetUrl) => String(targetUrl).includes('/local/salavirtual/conteudo-digital.php'), {
      timeout: 25000,
    }),
    page.click(LOGIN_SELECTORS.button),
  ]).catch(() => {
    throw new Error('Nao foi possivel autenticar na FIAP. Verifique usuario, senha e MFA/CAPTCHA.');
  });

  await page.goto(dashboardUrl, { waitUntil: 'networkidle' });
}

async function createAuthenticatedContext(options = {}) {
  const sessionFilePath = options.sessionFilePath || SESSION_FILE_PADRAO;
  const browser = await chromium.launch({
    headless: options.headless !== false,
  });

  const hasSessionFile = await pathExists(sessionFilePath);
  const context = hasSessionFile
    ? await browser.newContext({ storageState: sessionFilePath })
    : await browser.newContext();

  const page = await context.newPage();

  try {
    await ensureAuthenticated(page, options);
    await context.storageState({ path: sessionFilePath });
    return { browser, context, page };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function collectLessonLinks(page, dashboardUrl) {
  await page.goto(dashboardUrl || DASHBOARD_URL_PADRAO, { waitUntil: 'networkidle' });

  const links = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href]'));

    return anchors
      .map((anchor) => {
        const href = String(anchor.getAttribute('href') || '').trim();
        const title = String(anchor.textContent || anchor.getAttribute('aria-label') || '').trim();

        return {
          href,
          title,
        };
      })
      .filter((item) => item.href.includes('/mod/conteudoshtml/') || item.href.includes('/mod/conteudospdf/'));
  });

  const uniqueByUrl = new Map();

  links.forEach((item) => {
    const absoluteUrl = resolveAbsoluteUrl(page.url(), item.href);

    if (!absoluteUrl) {
      return;
    }

    if (shouldExcludeLessonByTitle(item.title)) {
      return;
    }

    if (!uniqueByUrl.has(absoluteUrl)) {
      uniqueByUrl.set(absoluteUrl, {
        titulo: item.title || `Conteudo ${uniqueByUrl.size + 1}`,
        url: absoluteUrl,
        tipo: normalizeLessonType(absoluteUrl),
      });
    }
  });

  return Array.from(uniqueByUrl.values());
}

async function collectContentGroups(page, dashboardUrl) {
  await page.goto(dashboardUrl || DASHBOARD_URL_PADRAO, { waitUntil: 'networkidle' });

  const rawGroups = await page.evaluate(() => {
    const LESSON_SELECTOR = 'a[href*="/mod/conteudoshtml/"], a[href*="/mod/conteudospdf/"]';
    const sanitizeLabel = (value) =>
      String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/\s+encerrado$/i, '')
        .trim();

    const groups = [];
    const byName = new Map();

    const ensureGroup = (name) => {
      const safeName = sanitizeLabel(name) || 'Conteudo Geral';

      if (!byName.has(safeName)) {
        const group = {
          nome: safeName,
          aulas: [],
        };

        byName.set(safeName, group);
        groups.push(group);
      }

      return byName.get(safeName);
    };

    // Estrutura principal observada no dashboard da FIAP.
    const fiapItems = Array.from(document.querySelectorAll('.conteudo-digital-item'));
    let currentHeading = 'Conteudo Geral';

    fiapItems.forEach((item) => {
      const nomeNode = item.querySelector('.conteudo-digital-name');
      const nomeItem = sanitizeLabel(nomeNode?.textContent || item.textContent || '');
      const isMarker = item.classList.contains('is-marcador');

      if (isMarker && nomeItem && !/^aula\s*\d+/i.test(nomeItem)) {
        currentHeading = nomeItem;
      }

      const links = Array.from(item.querySelectorAll(LESSON_SELECTOR));

      if (!links.length) {
        return;
      }

      const group = ensureGroup(currentHeading);

      links.forEach((link) => {
        const href = String(link.getAttribute('href') || '').trim();
        const titulo =
          sanitizeLabel(link.textContent || '') ||
          (nomeItem && /^aula\s*\d+/i.test(nomeItem) ? nomeItem : '') ||
          sanitizeLabel(link.getAttribute('aria-label') || '');

        if (!href) {
          return;
        }

        group.aulas.push({
          href,
          titulo,
        });
      });
    });

    if (groups.some((group) => group.aulas.length > 0)) {
      return groups.filter((group) => group.aulas.length > 0);
    }

    // Fallback generico para manter compatibilidade caso o layout mude.
    const HEADING_SELECTOR = [
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      '[role="heading"]',
      '.sectionname',
      '.section-title',
      '.category-title',
      '.categoryname',
      '.moduletitle',
      '.module-title',
      '.course-title',
      '.titulo',
      'strong',
    ].join(',');

    const root =
      document.querySelector('#region-main, main, .content, .course-content, body') || document.body;

    const nodes = Array.from(root.querySelectorAll(`${HEADING_SELECTOR}, ${LESSON_SELECTOR}`));
    let fallbackHeading = 'Conteudo Geral';

    nodes.forEach((node) => {
      if (node.matches(LESSON_SELECTOR)) {
        const href = String(node.getAttribute('href') || '').trim();
        const titulo = sanitizeLabel(node.textContent || node.getAttribute('aria-label') || '');

        if (!href) {
          return;
        }

        const group = ensureGroup(fallbackHeading);
        group.aulas.push({ href, titulo });
        return;
      }

      if (node.closest('a')) {
        return;
      }

      const text = sanitizeLabel(node.textContent || '');

      if (!text || /^aula\s*\d+/i.test(text) || text.length < 4 || text.length > 160) {
        return;
      }

      if (/^(materiais|atividades|conteudos?|videoaulas?)$/i.test(text)) {
        return;
      }

      fallbackHeading = text;
      ensureGroup(fallbackHeading);
    });

    return groups.filter((group) => group.aulas.length > 0);
  });

  const flatLessons = await collectLessonLinks(page, dashboardUrl || DASHBOARD_URL_PADRAO);
  const flatByUrl = new Map(flatLessons.map((lesson) => [lesson.url, lesson]));
  const usedUrls = new Set();
  const groups = [];

  rawGroups.forEach((group) => {
    const nome = normalizeText(group.nome) || 'Conteudo Geral';

    if (shouldExcludeContentGroupByName(nome)) {
      return;
    }

    const aulasMap = new Map();

    (group.aulas || []).forEach((aula) => {
      const url = resolveAbsoluteUrl(page.url(), aula.href);

      if (!url || aulasMap.has(url)) {
        return;
      }

      const flat = flatByUrl.get(url);
      const tituloRaw = normalizeText(aula.titulo || '');
      const tituloFlat = normalizeText(flat?.titulo || '');
      const tituloFinal = tituloRaw || tituloFlat || 'Aula FIAP';

      if (shouldExcludeLessonByTitle(tituloFinal)) {
        return;
      }

      usedUrls.add(url);

      aulasMap.set(url, {
        titulo: tituloFinal,
        url,
        tipo: normalizeLessonType(url),
      });
    });

    const aulas = Array.from(aulasMap.values());
    if (!aulas.length) {
      return;
    }

    groups.push({
      nome,
      totalAulas: aulas.length,
      aulas,
    });
  });

  const aulasSemGrupo = flatLessons.filter((lesson) => !usedUrls.has(lesson.url));
  if (aulasSemGrupo.length) {
    groups.push({
      nome: 'Conteudo Geral',
      totalAulas: aulasSemGrupo.length,
      aulas: aulasSemGrupo,
    });
  }

  const mergedByName = new Map();

  groups.forEach((group) => {
    const key = normalizeComparableText(group.nome) || 'conteudo geral';

    if (!mergedByName.has(key)) {
      mergedByName.set(key, {
        nome: group.nome,
        aulas: [],
      });
    }

    const target = mergedByName.get(key);
    const existing = new Set(target.aulas.map((aula) => aula.url));

    group.aulas.forEach((aula) => {
      if (existing.has(aula.url)) {
        return;
      }

      target.aulas.push(aula);
      existing.add(aula.url);
    });
  });

  return Array.from(mergedByName.values()).map((group) => ({
    nome: group.nome,
    totalAulas: group.aulas.length,
    aulas: group.aulas,
  }));
}

async function clickTranscriptToggles(page) {
  const targets = await getPageAndFrameTargets(page);

  for (const target of targets) {
    for (const selector of TRANSCRIPT_TOGGLE_SELECTORS) {
      const locator = target.locator(selector);
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index += 1) {
        await locator
          .nth(index)
          .click({ timeout: 1500 })
          .catch(() => {});
      }
    }

    await clickTranscriptHintsInTarget(target);
    await clickTranscriptListItemsInTarget(target);
  }

  await page.waitForTimeout(500).catch(() => {});
}

async function readMainContent(page) {
  const targets = await getPageAndFrameTargets(page);
  const candidates = [];

  for (const target of targets) {
    const chunks = await collectTextCandidatesFromTarget(target);
    candidates.push(...chunks);
  }

  const validCandidates = candidates
    .map(normalizeText)
    .filter((chunk) => chunk.length >= MIN_MAIN_TEXT_LENGTH && !isLikelyNonLessonText(chunk));

  if (validCandidates.length > 0) {
    return validCandidates.sort((a, b) => b.length - a.length)[0];
  }

  const fallback = candidates
    .map(normalizeText)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)[0] || '';

  return fallback;
}

async function readTranscriptBlocks(page) {
  const targets = await getPageAndFrameTargets(page);
  const transcripts = [];

  for (const target of targets) {
    const chunks = await collectTranscriptBlocksFromTarget(target);
    const panelChunks = await collectPanelTranscriptChunksFromTarget(target);
    transcripts.push(...chunks);
    transcripts.push(...panelChunks);
  }

  return uniqueValues(
    transcripts
      .map(sanitizeTranscriptChunk)
      .filter((text) => text.length > 40)
      .filter((text) => !isLikelyNonLessonText(text))
  );
}

async function downloadSubtitleTracks(context, urls) {
  const collected = [];

  for (const subtitleUrl of urls) {
    try {
      const response = await context.request.get(subtitleUrl, { timeout: 15000 });

      if (!response.ok()) {
        continue;
      }

      const rawText = await response.text();
      const cleaned = cleanSubtitleText(rawText);

      if (cleaned.length > 40) {
        collected.push(cleaned);
      }
    } catch (error) {
      // fallback gracioso
    }
  }

  return uniqueValues(collected);
}

async function scrapeHtmlLesson(page, aulaUrl) {
  const subtitleUrlSet = new Set();
  const onResponse = (response) => {
    const responseUrl = String(response.url() || '');

    if (/\.(vtt|srt)(\?|$)/i.test(responseUrl)) {
      subtitleUrlSet.add(responseUrl);
      return;
    }

    const headers = response.headers();
    const contentType = String(headers['content-type'] || '').toLowerCase();

    if (contentType.includes('text/vtt') || contentType.includes('subrip')) {
      subtitleUrlSet.add(responseUrl);
    }
  };

  page.on('response', onResponse);

  try {
    await page.goto(aulaUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await assertOnLessonPage(page, aulaUrl);

    const targets = await getPageAndFrameTargets(page);
    for (const target of targets) {
      const domSubtitleUrls = await collectSubtitleTrackUrlsFromTarget(target, page.url());
      domSubtitleUrls.forEach((url) => subtitleUrlSet.add(url));
    }

    await clickTranscriptToggles(page);

    for (const target of targets) {
      const domSubtitleUrls = await collectSubtitleTrackUrlsFromTarget(target, page.url());
      domSubtitleUrls.forEach((url) => subtitleUrlSet.add(url));
    }

    const titulo = normalizeText(
      await page.evaluate(() => {
        const heading = document.querySelector('h1, h2');
        return String(heading?.textContent || document.title || '').trim();
      })
    );

    let aulaTranscricao = await readMainContent(page);
    const transcriptBlocks = await readTranscriptBlocks(page);
    const subtitleTracks = await downloadSubtitleTracks(page.context(), Array.from(subtitleUrlSet));
    const videosRaw = uniqueValues([...transcriptBlocks, ...subtitleTracks]);
    const videosJoined = normalizeText(videosRaw.join('\n\n'));

    if (videosJoined.length >= 240) {
      aulaTranscricao = videosJoined;
    }

    if (
      videosRaw.length > 0
      && (!aulaTranscricao || aulaTranscricao.length < MIN_MAIN_TEXT_LENGTH || isLikelyNonLessonText(aulaTranscricao))
    ) {
      aulaTranscricao = videosJoined;
    }

    const hasMainText = aulaTranscricao.length >= MIN_MAIN_TEXT_LENGTH && !isLikelyNonLessonText(aulaTranscricao);
    const hasVideoTranscripts = videosRaw.length > 0;

    if (!hasMainText && hasVideoTranscripts) {
      aulaTranscricao = videosJoined;
    }

    if (!aulaTranscricao || isLikelyNonLessonText(aulaTranscricao) || (!hasMainText && !hasVideoTranscripts)) {
      throw new Error('Nao foi possivel extrair o conteudo da aula HTML na FIAP.');
    }

    const videos = videosRaw.map((transcricao, index) => ({
      nome: `Video ${index + 1}`,
      transcricao,
    }));

    return {
      tipo: 'html',
      titulo: titulo || 'Aula FIAP',
      aulaTranscricao,
      videos,
      origemUrl: aulaUrl,
    };
  } finally {
    page.off('response', onResponse);
  }
}

async function resolvePdfCandidates(page) {
  const domCandidates = await page.evaluate(() => {
    const urls = [];

    const iframe = document.querySelector('iframe[src]');
    if (iframe?.src) {
      urls.push(iframe.src);
    }

    const embed = document.querySelector('embed[src]');
    if (embed?.src) {
      urls.push(embed.src);
    }

    const objectData = document.querySelector('object[data]');
    if (objectData?.data) {
      urls.push(objectData.data);
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    anchors.forEach((anchor) => {
      const href = String(anchor.getAttribute('href') || '').trim();
      if (/\.pdf(\?|$)/i.test(href)) {
        urls.push(href);
      }
    });

    return urls;
  });

  return uniqueValues(domCandidates.map((url) => resolveAbsoluteUrl(page.url(), url)));
}

async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return normalizeText(result?.text || '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function scrapePdfLesson(page, aulaUrl) {
  const pdfUrlCandidates = new Set();
  const onResponse = (response) => {
    const responseUrl = String(response.url() || '');
    const headers = response.headers();
    const contentType = String(headers['content-type'] || '').toLowerCase();

    if (/\.pdf(\?|$)/i.test(responseUrl) || contentType.includes('application/pdf')) {
      pdfUrlCandidates.add(responseUrl);
    }
  };

  page.on('response', onResponse);

  try {
    await page.goto(aulaUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await assertOnLessonPage(page, aulaUrl);

    const domCandidates = await resolvePdfCandidates(page);
    domCandidates.forEach((url) => pdfUrlCandidates.add(url));

    let pdfUrl = Array.from(pdfUrlCandidates)[0] || '';

    if (!pdfUrl) {
      const fallbackResponse = await page.context().request.get(aulaUrl, { timeout: 30000 }).catch(() => null);
      const fallbackContentType = String(fallbackResponse?.headers()['content-type'] || '').toLowerCase();

      if (fallbackResponse?.ok() && fallbackContentType.includes('application/pdf')) {
        pdfUrl = aulaUrl;
      }
    }

    if (!pdfUrl) {
      throw new Error('Nao foi possivel localizar o PDF da aula na pagina da FIAP.');
    }

    const response = await page.context().request.get(pdfUrl, { timeout: 30000 });

    if (!response.ok()) {
      throw new Error(`Falha ao baixar PDF da FIAP. Status ${response.status()}.`);
    }

    const pdfBuffer = Buffer.from(await response.body());
    const aulaTranscricao = await extractTextFromPdfBuffer(pdfBuffer);

    if (!aulaTranscricao) {
      throw new Error('PDF baixado, mas sem texto legivel para extracao.');
    }

    const titulo = normalizeText(
      await page.evaluate(() => {
        const heading = document.querySelector('h1, h2');
        return String(heading?.textContent || document.title || '').trim();
      })
    );

    return {
      tipo: 'pdf',
      titulo: titulo || 'Aula PDF FIAP',
      aulaTranscricao,
      videos: [],
      origemUrl: aulaUrl,
      pdfUrl,
      pdfBuffer,
      pdfFileName: guessPdfFileName(pdfUrl),
    };
  } finally {
    page.off('response', onResponse);
  }
}

async function withFiapSession(options, runner) {
  const { browser, context, page } = await createAuthenticatedContext(options);

  try {
    return await runner(page, context);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function listarAulasFiap(options = {}) {
  return withFiapSession(options, async (page) => {
    return collectLessonLinks(page, options.dashboardUrl || DASHBOARD_URL_PADRAO);
  });
}

async function listarConteudosFiap(options = {}) {
  const minLessonsPerContent = resolveMinLessonsPerContent(options.minLessonsPerContent);

  return withFiapSession(options, async (page) => {
    const groups = await collectContentGroups(page, options.dashboardUrl || DASHBOARD_URL_PADRAO);

    return groups.filter((group) => Number(group?.totalAulas || 0) >= minLessonsPerContent);
  });
}

async function scrapeAulaFiap(options = {}) {
  const aulaUrl = resolveAbsoluteUrl(options.loginUrl || LOGIN_URL_PADRAO, options.url);

  if (!aulaUrl) {
    throw new Error('Informe uma URL valida da aula FIAP.');
  }

  return withFiapSession(options, async (page) => {
    const tipo = normalizeLessonType(aulaUrl);

    if (tipo === 'pdf') {
      return tryScrapePdfThenHtml(page, aulaUrl);
    }

    return scrapeHtmlLesson(page, aulaUrl);
  });
}

async function scrapeAulasFiapEmLote(options = {}) {
  const urls = Array.isArray(options.urls) ? options.urls : [];

  if (!urls.length) {
    return [];
  }

  return withFiapSession(options, async (page) => {
    const results = [];

    for (const rawUrl of urls) {
      const aulaUrl = resolveAbsoluteUrl(options.loginUrl || LOGIN_URL_PADRAO, rawUrl);

      if (!aulaUrl) {
        results.push({
          ok: false,
          url: String(rawUrl || ''),
          erro: 'URL invalida da aula FIAP.',
        });
        continue;
      }

      try {
        const tipo = normalizeLessonType(aulaUrl);
        const data = tipo === 'pdf'
          ? await tryScrapePdfThenHtml(page, aulaUrl)
          : await scrapeHtmlLesson(page, aulaUrl);

        results.push({
          ok: true,
          url: aulaUrl,
          data,
        });
      } catch (error) {
        results.push({
          ok: false,
          url: aulaUrl,
          erro: error.message || 'Falha ao extrair aula FIAP.',
        });
      }
    }

    return results;
  });
}

module.exports = {
  listarAulasFiap,
  listarConteudosFiap,
  scrapeAulaFiap,
  scrapeAulasFiapEmLote,
};
