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
    const aulasMap = new Map();

    (group.aulas || []).forEach((aula) => {
      const url = resolveAbsoluteUrl(page.url(), aula.href);

      if (!url || aulasMap.has(url)) {
        return;
      }

      const flat = flatByUrl.get(url);
      usedUrls.add(url);

      const tituloRaw = normalizeText(aula.titulo || '');
      const tituloFlat = normalizeText(flat?.titulo || '');

      aulasMap.set(url, {
        titulo: tituloRaw || tituloFlat || 'Aula FIAP',
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
  for (const selector of TRANSCRIPT_TOGGLE_SELECTORS) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      await locator
        .nth(index)
        .click({ timeout: 1500 })
        .catch(() => {});
    }
  }
}

async function readMainContent(page) {
  const rawText = await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);

      if (!element) {
        continue;
      }

      const text = String(element.innerText || '').trim();
      if (text.length > 80) {
        return text;
      }
    }

    return String(document.body?.innerText || '').trim();
  }, MAIN_CONTENT_SELECTORS);

  return normalizeText(rawText);
}

async function readTranscriptBlocks(page) {
  const transcripts = await page.evaluate((selectors) => {
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
  }, TRANSCRIPT_BLOCK_SELECTORS);

  return uniqueValues(transcripts.map(normalizeText));
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
    await page.goto(aulaUrl, { waitUntil: 'networkidle' });
    await clickTranscriptToggles(page);

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

    if (!aulaTranscricao && videosRaw.length > 0) {
      aulaTranscricao = videosRaw.join('\n\n');
    }

    if (!aulaTranscricao) {
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

    const domCandidates = await resolvePdfCandidates(page);
    domCandidates.forEach((url) => pdfUrlCandidates.add(url));

    const pdfUrl = Array.from(pdfUrlCandidates)[0] || '';

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
      pdfFileName: 'material.pdf',
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
  return withFiapSession(options, async (page) => {
    return collectContentGroups(page, options.dashboardUrl || DASHBOARD_URL_PADRAO);
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
      return scrapePdfLesson(page, aulaUrl);
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
          ? await scrapePdfLesson(page, aulaUrl)
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
