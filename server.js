const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { PDFParse } = require('pdf-parse');
const dotenv = require('dotenv');
const {
  listarAulasFiap,
  listarConteudosFiap,
  scrapeAulaFiap,
  scrapeAulasFiapEmLote,
} = require('./scrapers/fiapScraper');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT);
const ROOT_DIR = __dirname;
const AULAS_DIR = path.join(ROOT_DIR, 'aulas');
const FASES_CONFIG = [
  { numero: 1, nome: 'Fase 1', mesLiberacao: null, diaLiberacao: null },
  { numero: 2, nome: 'Fase 2', mesLiberacao: 5, diaLiberacao: 6 },
  { numero: 3, nome: 'Fase 3', mesLiberacao: 7, diaLiberacao: 6 },
  { numero: 4, nome: 'Fase 4', mesLiberacao: 9, diaLiberacao: 6 },
  { numero: 5, nome: 'Fase 5', mesLiberacao: 11, diaLiberacao: 6 },
];
const MAX_CONTEUDOS_POR_FASE = 5;
const MIN_AULAS_POR_CONTEUDO_FIAP = 4;
const FASES_INDEX = new Map(FASES_CONFIG.map((fase) => [fase.numero, fase]));
const EXCLUDED_CONTENT_NAME_PATTERNS = [
  'welcome to data analytics',
];

if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error('PORT invalida no .env. Use um numero inteiro positivo.');
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(ROOT_DIR));

function sanitizeName(value) {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 120);
}

function normalizePhaseName(value) {
  const match = String(value || '').match(/(\d+)/);
  const numero = match ? Number(match[1]) : NaN;
  const fase = FASES_INDEX.get(numero);

  if (!Number.isInteger(numero) || !fase) {
    return '';
  }

  return fase.nome;
}

function normalizePortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

function buildReleaseDate(mes, dia, nowDate = new Date()) {
  if (!mes || !dia) {
    return null;
  }

  return new Date(nowDate.getFullYear(), mes - 1, dia, 0, 0, 0, 0);
}

function formatDateBr(dateValue) {
  if (!dateValue) {
    return 'Liberada';
  }

  const dia = String(dateValue.getDate()).padStart(2, '0');
  const mes = String(dateValue.getMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}`;
}

function getFasesStatus(nowDate = new Date()) {
  return FASES_CONFIG.map((fase) => {
    const dataLiberacao = buildReleaseDate(fase.mesLiberacao, fase.diaLiberacao, nowDate);
    const liberada = !dataLiberacao || nowDate >= dataLiberacao;

    return {
      numero: fase.numero,
      nome: fase.nome,
      liberada,
      dataLiberacao: formatDateBr(dataLiberacao),
      dataLiberacaoIso: dataLiberacao
        ? dataLiberacao.toISOString().slice(0, 10)
        : null,
    };
  });
}

function getFaseStatusByName(faseNome, nowDate = new Date()) {
  const faseNormalizada = normalizePhaseName(faseNome);
  if (!faseNormalizada) {
    return null;
  }

  return getFasesStatus(nowDate).find((fase) => fase.nome === faseNormalizada) || null;
}

function getMensagemFaseBloqueada(faseNome) {
  const faseInfo = getFaseStatusByName(faseNome);
  return {
    bloqueada: Boolean(faseInfo && !faseInfo.liberada),
    mensagem: `${faseNome} ainda esta bloqueada. Liberacao prevista para ${faseInfo?.dataLiberacao || 'data futura'}.`,
  };
}

function normalizeModeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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

function stripNumericSuffix(value) {
  return String(value || '').replace(/\s+\(\d+\)\s*$/, '').trim();
}

function normalizeComparableLessonTitle(value) {
  return normalizeComparableText(stripNumericSuffix(value));
}

function shouldExcludeContentName(value) {
  const normalized = normalizeComparableText(value);

  if (!normalized) {
    return false;
  }

  return EXCLUDED_CONTENT_NAME_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function extractFaseFromAulaIdentifier(aula) {
  const partes = normalizePortablePath(aula).split('/').filter(Boolean);

  if (partes.length < 3) {
    return '';
  }

  return normalizePhaseName(partes[0]);
}

function normalizeLineBreaks(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractTextFromFile(file) {
  if (!file || !file.buffer) {
    return '';
  }

  return normalizeLineBreaks(file.buffer.toString('utf-8'));
}

function isPdfFile(file) {
  if (!file) {
    return false;
  }

  const mimeType = String(file.mimetype || '').toLowerCase();
  const originalName = String(file.originalname || '').toLowerCase();

  return mimeType === 'application/pdf' || originalName.endsWith('.pdf');
}

async function extractTextFromPdfBuffer(buffer) {
  const parser = new PDFParse({ data: buffer });

  try {
    const result = await parser.getText();
    return normalizeLineBreaks(result?.text || '');
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractAulaText(file, fallbackText) {
  if (fallbackText) {
    return {
      text: fallbackText,
      sourceType: 'text',
    };
  }

  if (!file) {
    return {
      text: '',
      sourceType: 'empty',
    };
  }

  if (isPdfFile(file)) {
    let parsedText = '';

    try {
      parsedText = await extractTextFromPdfBuffer(file.buffer);
    } catch (error) {
      throw new Error('Falha ao ler o PDF da aula. Verifique se o arquivo nao esta corrompido.');
    }

    return {
      text: parsedText,
      sourceType: 'pdf',
    };
  }

  return {
    text: extractTextFromFile(file),
    sourceType: 'txt',
  };
}

function parseVideosJson(rawVideos) {
  if (!rawVideos) {
    return [];
  }

  if (Array.isArray(rawVideos)) {
    return rawVideos;
  }

  if (typeof rawVideos === 'string') {
    try {
      const parsed = JSON.parse(rawVideos);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function getSingleFileByField(req, fieldName) {
  return (req.files || []).find((file) => file.fieldname === fieldName);
}

function getVideoFileByIndex(req, index) {
  const byIndex = (req.files || []).find(
    (file) => file.fieldname === `videoArquivo_${index}`
  );

  if (byIndex) {
    return byIndex;
  }

  return (req.files || []).find((file) => file.fieldname === 'videoArquivos');
}

async function parseCreateAulaPayload(req) {
  const nomeAula = sanitizeName(req.body.nomeAula || req.body.nome);
  const fase = normalizePhaseName(req.body.fase);
  const conteudoGeral = sanitizeName(req.body.conteudoGeral || req.body.conteudo);
  const aulaArquivo = getSingleFileByField(req, 'aulaArquivo');
  const videos = parseVideosJson(req.body.videos);

  if (!fase) {
    throw new Error('Informe uma fase valida entre 1 e 5.');
  }

  if (!conteudoGeral) {
    throw new Error('Informe o conteudo geral da fase.');
  }

  if (!nomeAula) {
    throw new Error('Nome da aula e obrigatorio.');
  }

  if (!aulaArquivo) {
    throw new Error('Envie o PDF da transcricao da aula.');
  }

  if (!isPdfFile(aulaArquivo)) {
    throw new Error('A transcricao da aula deve ser enviada em PDF.');
  }

  const aulaData = await extractAulaText(aulaArquivo, '');
  const aulaTranscricao = aulaData.text;

  const videosNormalizados = videos.map((video, index) => {
    const nome = sanitizeName(video.nome || video.nomeVideo || `Video ${index + 1}`);
    const textoVideo = normalizeLineBreaks(video.texto || video.transcricao);
    const arquivoVideo = getVideoFileByIndex(req, index);
    const transcricao = textoVideo || extractTextFromFile(arquivoVideo);

    return {
      nome,
      transcricao,
    };
  });

  return {
    fase,
    conteudoGeral,
    nomeAula,
    aulaTranscricao,
    aulaArquivo,
    aulaSourceType: aulaData.sourceType,
    videos: videosNormalizados.filter((item) => item.transcricao),
  };
}

function parseCreateConteudoPayload(req) {
  const fase = normalizePhaseName(req.body.fase);
  const nomeConteudo = sanitizeName(
    req.body.nomeConteudo || req.body.conteudoGeral || req.body.conteudo
  );

  if (!fase) {
    throw new Error('Informe uma fase valida entre 1 e 5.');
  }

  if (!nomeConteudo) {
    throw new Error('Informe o nome do conteudo.');
  }

  if (shouldExcludeContentName(nomeConteudo)) {
    throw new Error('Conteudo de boas-vindas nao deve ser sincronizado.');
  }

  return {
    fase,
    nomeConteudo,
  };
}

function parseBooleanFlag(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'sim', 'yes', 'y'].includes(normalized);
}

function buildFiapOptions(req) {
  const requestedMin = Number(req.body?.minAulasPorConteudo);
  const minLessonsPerContent = Number.isInteger(requestedMin) && requestedMin > 0
    ? requestedMin
    : MIN_AULAS_POR_CONTEUDO_FIAP;

  return {
    headless: parseBooleanFlag(req.body?.headless, true),
    loginUrl: String(req.body?.loginUrl || '').trim() || undefined,
    dashboardUrl: String(req.body?.dashboardUrl || '').trim() || undefined,
    sessionFilePath: path.join(ROOT_DIR, '.fiap-session.json'),
    user: String(req.body?.fiapUser || '').trim() || undefined,
    password: String(req.body?.fiapPass || '').trim() || undefined,
    minLessonsPerContent,
  };
}

function parseScrapeFiapPayload(req) {
  const url = String(req.body?.url || '').trim();

  if (!url) {
    throw new Error('Informe a URL da aula FIAP para scraping.');
  }

  return {
    url,
  };
}

function parseImportFiapPayload(req) {
  const fase = normalizePhaseName(req.body?.fase);
  const conteudoGeral = sanitizeName(req.body?.conteudoGeral || req.body?.conteudo);
  const nomeAula = sanitizeName(req.body?.nomeAula || '');
  const { url } = parseScrapeFiapPayload(req);

  if (!fase) {
    throw new Error('Informe uma fase valida entre 1 e 5.');
  }

  if (!conteudoGeral) {
    throw new Error('Informe o conteudo geral para importar a aula FIAP.');
  }

  return {
    fase,
    conteudoGeral,
    nomeAula,
    url,
  };
}

function parseImportConteudoFiapPayload(req) {
  const fase = normalizePhaseName(req.body?.fase);
  const conteudoGeral = sanitizeName(req.body?.conteudoGeral || req.body?.conteudo);
  const conteudoFiap = sanitizeName(req.body?.conteudoFiap || req.body?.nomeConteudoFiap || '');

  if (!fase) {
    throw new Error('Informe uma fase valida entre 1 e 5.');
  }

  if (!conteudoGeral) {
    throw new Error('Informe o conteudo geral para importar aulas da FIAP.');
  }

  return {
    fase,
    conteudoGeral,
    conteudoFiap,
  };
}

function findFiapContentByName(conteudos, targetName) {
  const target = normalizeComparableText(targetName);

  if (!target) {
    return null;
  }

  const byExact = conteudos.find((conteudo) => normalizeComparableText(conteudo.nome) === target);
  if (byExact) {
    return byExact;
  }

  return (
    conteudos.find((conteudo) => {
      const normalized = normalizeComparableText(conteudo.nome);
      return normalized.includes(target) || target.includes(normalized);
    }) || null
  );
}

async function buildUniqueAulaName(fase, conteudoGeral, preferredName) {
  const baseName = sanitizeName(preferredName) || 'Aula FIAP';
  let candidate = baseName;
  let index = 2;

  while (
    await pathExists(
      path.join(AULAS_DIR, fase, conteudoGeral, candidate, 'ATranscritos', 'aula.txt')
    )
  ) {
    candidate = `${baseName} (${index})`;
    index += 1;
  }

  return candidate;
}

async function ensureBaseFolders() {
  await fs.mkdir(AULAS_DIR, { recursive: true });
}

async function listSubdirectories(dirPath) {
  if (!(await pathExists(dirPath))) {
    return [];
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

async function contarVideosTxt(pastaAula) {
  const videosDir = path.join(pastaAula, 'VTranscritos');

  if (!(await pathExists(videosDir))) {
    return 0;
  }

  const videos = await fs.readdir(videosDir, { withFileTypes: true });
  return videos.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.txt')).length;
}

function buildAulaPath(fase, conteudoGeral, nomeAula) {
  return normalizePortablePath(path.join(fase, conteudoGeral, nomeAula));
}

async function listConteudosByFase(faseNome) {
  const faseNormalizada = normalizePhaseName(faseNome);

  if (!faseNormalizada) {
    return [];
  }

  const faseDir = path.join(AULAS_DIR, faseNormalizada);
  const conteudos = await listSubdirectories(faseDir);
  const result = [];

  for (const nomeConteudo of conteudos) {
    if (shouldExcludeContentName(nomeConteudo)) {
      continue;
    }

    const conteudoDir = path.join(faseDir, nomeConteudo);
    const nomesAulas = await listSubdirectories(conteudoDir);
    let totalAulas = 0;
    let totalVideos = 0;

    for (const nomeAula of nomesAulas) {
      const aulaDir = path.join(conteudoDir, nomeAula);
      const hasAulaTranscritos = await pathExists(path.join(aulaDir, 'ATranscritos'));

      if (!hasAulaTranscritos) {
        continue;
      }

      totalAulas += 1;
      totalVideos += await contarVideosTxt(aulaDir);
    }

    result.push({
      nome: nomeConteudo,
      totalAulas,
      totalVideos,
    });
  }

  return result;
}

async function listarAulas() {
  await ensureBaseFolders();

  const entradas = await listSubdirectories(AULAS_DIR);
  const aulas = [];

  for (const entrada of entradas) {
    const faseNormalizada = normalizePhaseName(entrada);

    if (!faseNormalizada) {
      const pastaLegada = path.join(AULAS_DIR, entrada);
      const hasAulaTranscritos = await pathExists(path.join(pastaLegada, 'ATranscritos'));

      if (!hasAulaTranscritos) {
        continue;
      }

      const totalVideos = await contarVideosTxt(pastaLegada);

      aulas.push({
        nome: entrada,
        fase: 'Sem fase',
        conteudoGeral: 'Geral',
        caminho: entrada,
        totalVideos,
        liberada: true,
        dataLiberacao: 'Liberada',
      });
      continue;
    }

    const faseInfo = getFaseStatusByName(faseNormalizada);
    const faseDir = path.join(AULAS_DIR, entrada);
    const conteudos = await listSubdirectories(faseDir);

    for (const conteudoGeral of conteudos) {
      if (shouldExcludeContentName(conteudoGeral)) {
        continue;
      }

      const conteudoDir = path.join(faseDir, conteudoGeral);
      const nomesAulas = await listSubdirectories(conteudoDir);

      for (const nomeAula of nomesAulas) {
        const aulaDir = path.join(conteudoDir, nomeAula);
        const hasAulaTranscritos = await pathExists(path.join(aulaDir, 'ATranscritos'));

        if (!hasAulaTranscritos) {
          continue;
        }

        const totalVideos = await contarVideosTxt(aulaDir);

        aulas.push({
          nome: nomeAula,
          fase: faseNormalizada,
          conteudoGeral,
          caminho: buildAulaPath(faseNormalizada, conteudoGeral, nomeAula),
          totalVideos,
          liberada: Boolean(faseInfo?.liberada),
          dataLiberacao: faseInfo?.dataLiberacao || 'Liberada',
        });
      }
    }
  }

  aulas.sort((a, b) => {
    const faseA = normalizePhaseName(a.fase);
    const faseB = normalizePhaseName(b.fase);
    const ordemA = faseA ? Number(faseA.replace(/\D/g, '')) : 99;
    const ordemB = faseB ? Number(faseB.replace(/\D/g, '')) : 99;

    if (ordemA !== ordemB) {
      return ordemA - ordemB;
    }

    const compareConteudo = String(a.conteudoGeral || '').localeCompare(
      String(b.conteudoGeral || ''),
      'pt-BR'
    );

    if (compareConteudo !== 0) {
      return compareConteudo;
    }

    return String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR');
  });

  return aulas;
}

async function salvarAula(payload) {
  const { fase, conteudoGeral, nomeAula, aulaTranscricao, videos, aulaArquivo } = payload;
  const faseNormalizada = normalizePhaseName(fase);

  if (!faseNormalizada) {
    throw new Error('Fase invalida.');
  }

  if (!conteudoGeral) {
    throw new Error('Conteudo geral e obrigatorio.');
  }

  if (!aulaTranscricao) {
    throw new Error('Transcricao da aula e obrigatoria.');
  }

  const pastaAula = path.join(AULAS_DIR, faseNormalizada, conteudoGeral, nomeAula);
  const pastaAulaTranscritos = path.join(pastaAula, 'ATranscritos');
  const pastaVideosTranscritos = path.join(pastaAula, 'VTranscritos');
  const pastaMaterialOriginal = path.join(pastaAula, 'MaterialOriginal');

  await fs.mkdir(pastaAulaTranscritos, { recursive: true });
  await fs.mkdir(pastaVideosTranscritos, { recursive: true });
  await fs.mkdir(pastaMaterialOriginal, { recursive: true });

  await fs.writeFile(path.join(pastaAulaTranscritos, 'aula.txt'), `${aulaTranscricao}\n`, 'utf-8');

  if (aulaArquivo && aulaArquivo.buffer) {
    const ext = path.extname(aulaArquivo.originalname || '').toLowerCase();
    const safeExt = ext || (isPdfFile(aulaArquivo) ? '.pdf' : '.txt');
    const fileName = `material${safeExt}`;
    await fs.writeFile(path.join(pastaMaterialOriginal, fileName), aulaArquivo.buffer);
  }

  for (const [index, video] of videos.entries()) {
    const nomeVideoBase = sanitizeName(video.nome || `Video ${index + 1}`) || `Video ${index + 1}`;
    const nomeArquivo = `${String(index + 1).padStart(2, '0')}-${nomeVideoBase}.txt`;
    const destino = path.join(pastaVideosTranscritos, nomeArquivo);

    await fs.writeFile(destino, `${video.transcricao}\n`, 'utf-8');
  }
}

async function salvarConteudo(payload) {
  const faseNormalizada = normalizePhaseName(payload.fase);
  const nomeConteudo = sanitizeName(payload.nomeConteudo);

  if (!faseNormalizada) {
    throw new Error('Fase invalida.');
  }

  if (!nomeConteudo) {
    throw new Error('Conteudo invalido.');
  }

  if (shouldExcludeContentName(nomeConteudo)) {
    throw new Error('Conteudo de boas-vindas nao deve ser salvo.');
  }

  const faseDir = path.join(AULAS_DIR, faseNormalizada);
  await fs.mkdir(faseDir, { recursive: true });

  const conteudosExistentes = await listSubdirectories(faseDir);
  const conteudoJaExiste = conteudosExistentes.includes(nomeConteudo);

  if (!conteudoJaExiste && conteudosExistentes.length >= MAX_CONTEUDOS_POR_FASE) {
    throw new Error(`Cada fase permite no maximo ${MAX_CONTEUDOS_POR_FASE} conteudos gerais.`);
  }

  const destino = path.join(faseDir, nomeConteudo);
  await fs.mkdir(destino, { recursive: true });

  return {
    fase: faseNormalizada,
    nomeConteudo,
  };
}

async function removerAula(nomeAula, options = {}) {
  const nomeSeguro = sanitizeName(nomeAula);
  const faseNormalizada = normalizePhaseName(options.fase);
  const conteudoSeguro = sanitizeName(options.conteudoGeral);

  if (!nomeSeguro) {
    throw new Error('Nome da aula invalido.');
  }

  const destino =
    faseNormalizada && conteudoSeguro
      ? path.join(AULAS_DIR, faseNormalizada, conteudoSeguro, nomeSeguro)
      : path.join(AULAS_DIR, nomeSeguro);

  const destinoResolvido = path.resolve(destino);
  const baseResolvida = path.resolve(AULAS_DIR);

  if (!destinoResolvido.startsWith(`${baseResolvida}${path.sep}`)) {
    throw new Error('Caminho de aula invalido.');
  }

  await fs.rm(destino, { recursive: true, force: true });
}

function loadGeminiHandler() {
  try {
    const gemini = require('./gemini');

    if (typeof gemini.gerarRespostaGemini === 'function') {
      return gemini.gerarRespostaGemini;
    }

    if (typeof gemini === 'function') {
      return gemini;
    }

    return null;
  } catch (error) {
    return null;
  }
}

app.get('/api/aulas', async (req, res) => {
  try {
    const aulas = await listarAulas();
    const fasesBase = getFasesStatus();
    const fases = await Promise.all(
      fasesBase.map(async (fase) => ({
        nome: fase.nome,
        liberada: fase.liberada,
        dataLiberacao: fase.dataLiberacao,
        limiteConteudos: MAX_CONTEUDOS_POR_FASE,
        conteudos: await listConteudosByFase(fase.nome),
      }))
    );

    const fasesComLimite = fases.map((fase) => ({
      ...fase,
      podeCriarConteudo: fase.liberada && fase.conteudos.length < fase.limiteConteudos,
    }));

    res.json({
      aulas,
      fases: fasesComLimite,
      limites: {
        totalFases: FASES_CONFIG.length,
        conteudosPorFase: MAX_CONTEUDOS_POR_FASE,
      },
    });
  } catch (error) {
    res.status(500).json({ erro: 'Nao foi possivel listar as aulas.' });
  }
});

app.post('/api/conteudos', async (req, res) => {
  try {
    const payload = parseCreateConteudoPayload(req);
    const faseStatus = getMensagemFaseBloqueada(payload.fase);

    if (faseStatus.bloqueada) {
      return res.status(403).json({ erro: faseStatus.mensagem });
    }

    const conteudo = await salvarConteudo(payload);

    res.status(201).json({
      mensagem: 'Conteudo criado com sucesso.',
      conteudo,
    });
  } catch (error) {
    res.status(400).json({ erro: error.message || 'Falha ao criar conteudo.' });
  }
});

app.post('/api/aulas', upload.any(), async (req, res) => {
  try {
    const payload = await parseCreateAulaPayload(req);
    const faseStatus = getMensagemFaseBloqueada(payload.fase);

    if (faseStatus.bloqueada) {
      return res.status(403).json({ erro: faseStatus.mensagem });
    }

    await salvarAula(payload);

    res.status(201).json({
      mensagem: 'Aula salva com sucesso.',
      aula: {
        nome: payload.nomeAula,
        fase: payload.fase,
        conteudoGeral: payload.conteudoGeral,
        caminho: buildAulaPath(payload.fase, payload.conteudoGeral, payload.nomeAula),
        totalVideos: payload.videos.length,
        origemMaterial: payload.aulaSourceType,
      },
    });
  } catch (error) {
    res.status(400).json({ erro: error.message || 'Falha ao salvar aula.' });
  }
});

app.delete('/api/aulas/:nome', async (req, res) => {
  try {
    await removerAula(req.params.nome, {
      fase: req.query.fase,
      conteudoGeral: req.query.conteudoGeral,
    });
    res.json({ mensagem: 'Aula removida com sucesso.' });
  } catch (error) {
    res.status(400).json({ erro: error.message || 'Falha ao remover aula.' });
  }
});

app.post('/api/gemini', async (req, res) => {
  try {
    const { modo, aula, tema } = req.body || {};
    const modoNormalizado = normalizeModeName(modo);

    if (!modo) {
      return res.status(400).json({ erro: 'Campo modo e obrigatorio.' });
    }

    if (aula && ['resumo', 'mapa', 'mapa mental', 'mapamental', 'flashcards', 'flashcard'].includes(modoNormalizado)) {
      const faseSolicitada = extractFaseFromAulaIdentifier(aula);

      if (faseSolicitada && !getFaseStatusByName(faseSolicitada)?.liberada) {
        const faseInfo = getFaseStatusByName(faseSolicitada);
        return res.status(403).json({
          erro: `${faseSolicitada} ainda esta bloqueada. Liberacao prevista para ${faseInfo?.dataLiberacao || 'data futura'}.`,
        });
      }
    }

    const geminiHandler = loadGeminiHandler();
    if (!geminiHandler) {
      return res.status(501).json({
        erro: 'Integracao Gemini ainda nao configurada. Crie gemini.js na etapa seguinte.',
      });
    }

    let aulasPermitidas = null;

    if (['busca', 'busca por tema', 'tema'].includes(modoNormalizado)) {
      const aulas = await listarAulas();
      aulasPermitidas = aulas.filter((item) => item.liberada).map((item) => item.caminho);

      if (!aulasPermitidas.length) {
        return res.status(400).json({
          erro: 'Nenhuma aula liberada no momento para busca por tema.',
        });
      }
    }

    const resposta = await geminiHandler({
      modo,
      aula,
      tema,
      aulasDir: AULAS_DIR,
      aulasPermitidas,
    });
    return res.json({ resposta });
  } catch (error) {
    return res.status(500).json({ erro: error.message || 'Erro ao consultar Gemini.' });
  }
});

app.post('/api/scrape-fiap/listar', async (req, res) => {
  try {
    const fiapOptions = buildFiapOptions(req);
    const aulas = await listarAulasFiap(fiapOptions);

    return res.json({
      total: aulas.length,
      aulas,
    });
  } catch (error) {
    return res.status(400).json({ erro: error.message || 'Falha ao listar aulas FIAP.' });
  }
});

app.post('/api/scrape-fiap/conteudos', async (req, res) => {
  try {
    const fiapOptions = buildFiapOptions(req);
    const conteudos = (await listarConteudosFiap(fiapOptions)).filter(
      (conteudo) => !shouldExcludeContentName(conteudo?.nome)
    );

    return res.json({
      total: conteudos.length,
      minAulasPorConteudo: fiapOptions.minLessonsPerContent,
      conteudos,
    });
  } catch (error) {
    return res.status(400).json({ erro: error.message || 'Falha ao listar conteudos FIAP.' });
  }
});

app.post('/api/scrape-fiap', async (req, res) => {
  try {
    const fiapOptions = buildFiapOptions(req);
    const payload = parseScrapeFiapPayload(req);
    const result = await scrapeAulaFiap({
      ...fiapOptions,
      url: payload.url,
    });

    return res.json({
      tipo: result.tipo,
      titulo: result.titulo,
      origemUrl: result.origemUrl,
      totalVideos: result.videos.length,
      aulaTranscricao: result.aulaTranscricao,
      videos: result.videos,
      pdfUrl: result.pdfUrl || null,
    });
  } catch (error) {
    return res.status(400).json({ erro: error.message || 'Falha ao extrair conteudo da FIAP.' });
  }
});

app.post('/api/scrape-fiap/importar', async (req, res) => {
  try {
    const fiapOptions = buildFiapOptions(req);
    const payload = parseImportFiapPayload(req);
    const faseStatus = getMensagemFaseBloqueada(payload.fase);

    if (faseStatus.bloqueada) {
      return res.status(403).json({ erro: faseStatus.mensagem });
    }

    const result = await scrapeAulaFiap({
      ...fiapOptions,
      url: payload.url,
    });

    const nomeAulaFinal = sanitizeName(payload.nomeAula || result.titulo || 'Aula FIAP');
    const aulaTranscricao = normalizeLineBreaks(result.aulaTranscricao);

    if (!aulaTranscricao) {
      throw new Error('Nao foi possivel importar: transcricao principal vazia.');
    }

    const videos = Array.isArray(result.videos)
      ? result.videos
          .map((video, index) => ({
            nome: sanitizeName(video.nome || `Video ${index + 1}`),
            transcricao: normalizeLineBreaks(video.transcricao),
          }))
          .filter((video) => video.transcricao)
      : [];

    const aulaArquivo = result.pdfBuffer
      ? {
          fieldname: 'aulaArquivo',
          originalname: result.pdfFileName || 'material.pdf',
          encoding: '7bit',
          mimetype: 'application/pdf',
          size: result.pdfBuffer.length,
          buffer: result.pdfBuffer,
        }
      : null;

    await salvarAula({
      fase: payload.fase,
      conteudoGeral: payload.conteudoGeral,
      nomeAula: nomeAulaFinal,
      aulaTranscricao,
      aulaArquivo,
      aulaSourceType: result.tipo,
      videos,
    });

    return res.status(201).json({
      mensagem: 'Aula FIAP importada com sucesso.',
      aula: {
        nome: nomeAulaFinal,
        fase: payload.fase,
        conteudoGeral: payload.conteudoGeral,
        caminho: buildAulaPath(payload.fase, payload.conteudoGeral, nomeAulaFinal),
        totalVideos: videos.length,
        origemMaterial: result.tipo,
        origemUrl: result.origemUrl,
      },
    });
  } catch (error) {
    return res.status(400).json({ erro: error.message || 'Falha ao importar aula FIAP.' });
  }
});

app.post('/api/scrape-fiap/importar-conteudo', async (req, res) => {
  try {
    const fiapOptions = buildFiapOptions(req);
    const payload = parseImportConteudoFiapPayload(req);
    const faseStatus = getMensagemFaseBloqueada(payload.fase);

    if (faseStatus.bloqueada) {
      return res.status(403).json({ erro: faseStatus.mensagem });
    }

    const conteudosFiap = await listarConteudosFiap(fiapOptions);
    const alvoFiap =
      findFiapContentByName(conteudosFiap, payload.conteudoFiap) ||
      findFiapContentByName(conteudosFiap, payload.conteudoGeral);

    if (!alvoFiap) {
      return res.status(404).json({
        erro: `Conteudo '${payload.conteudoFiap || payload.conteudoGeral}' nao encontrado na FIAP.`,
      });
    }

    const aulasFiap = Array.isArray(alvoFiap.aulas) ? alvoFiap.aulas : [];
    const aulasPorChave = new Map();

    aulasFiap.forEach((item) => {
      const url = String(item?.url || '').trim();
      if (!url) {
        return;
      }

      const titulo = sanitizeName(item?.titulo || '');
      const tipo = String(item?.tipo || '').toLowerCase();
      const chave = normalizeComparableLessonTitle(titulo) || normalizeComparableText(url);

      const atual = {
        url,
        titulo,
        tipo,
      };

      if (!aulasPorChave.has(chave)) {
        aulasPorChave.set(chave, atual);
        return;
      }

      const anterior = aulasPorChave.get(chave);
      const score = (candidate) => {
        let value = 0;

        if (candidate.tipo === 'html' || candidate.url.includes('/mod/conteudoshtml/')) {
          value += 10;
        }

        if (candidate.tipo === 'pdf' || candidate.url.includes('/mod/conteudospdf/')) {
          value += 1;
        }

        if (candidate.titulo) {
          value += 2;
        }

        return value;
      };

      if (score(atual) > score(anterior)) {
        aulasPorChave.set(chave, atual);
      }
    });

    const aulasSelecionadas = Array.from(aulasPorChave.values());
    const urls = aulasSelecionadas.map((item) => item.url).filter(Boolean);
    const aulaTituloPorUrl = new Map(aulasSelecionadas.map((item) => [item.url, item.titulo]));

    if (!urls.length) {
      return res.status(400).json({
        erro: `Nenhuma aula encontrada no conteudo '${alvoFiap.nome}'.`,
      });
    }

    const resultadosLote = await scrapeAulasFiapEmLote({
      ...fiapOptions,
      urls,
    });

    const nomesAulasExistentes = await listSubdirectories(
      path.join(AULAS_DIR, payload.fase, payload.conteudoGeral)
    );
    const chavesExistentes = new Set(
      nomesAulasExistentes
        .map((nome) => normalizeComparableLessonTitle(nome))
        .filter(Boolean)
    );

    const importadas = [];
    const falhas = [];
    const ignoradas = [];

    for (const item of resultadosLote) {
      if (!item.ok || !item.data) {
        falhas.push({
          aula: aulaTituloPorUrl.get(item.url) || '',
          url: item.url,
          erro: item.erro || 'Falha ao extrair aula da FIAP.',
        });
        continue;
      }

      const result = item.data;
      const aulaTranscricao = normalizeLineBreaks(result.aulaTranscricao);
      const nomeBase = sanitizeName(
        aulaTituloPorUrl.get(item.url) || result.titulo || 'Aula FIAP'
      ) || 'Aula FIAP';
      const chaveAula = normalizeComparableLessonTitle(nomeBase);

      if (chaveAula && chavesExistentes.has(chaveAula)) {
        ignoradas.push({
          aula: nomeBase,
          url: item.url,
          motivo: 'Aula ja existente neste conteudo.',
        });
        continue;
      }

      if (!aulaTranscricao) {
        falhas.push({
          aula: nomeBase,
          url: item.url,
          erro: 'Aula sem transcricao principal.',
        });
        continue;
      }

      const nomeAulaFinal = await buildUniqueAulaName(
        payload.fase,
        payload.conteudoGeral,
        nomeBase
      );

      const videos = Array.isArray(result.videos)
        ? result.videos
            .map((video, index) => ({
              nome: sanitizeName(video.nome || `Video ${index + 1}`),
              transcricao: normalizeLineBreaks(video.transcricao),
            }))
            .filter((video) => video.transcricao)
        : [];

      const aulaArquivo = result.pdfBuffer
        ? {
            fieldname: 'aulaArquivo',
            originalname: result.pdfFileName || 'material.pdf',
            encoding: '7bit',
            mimetype: 'application/pdf',
            size: result.pdfBuffer.length,
            buffer: result.pdfBuffer,
          }
        : null;

      try {
        await salvarAula({
          fase: payload.fase,
          conteudoGeral: payload.conteudoGeral,
          nomeAula: nomeAulaFinal,
          aulaTranscricao,
          aulaArquivo,
          aulaSourceType: result.tipo,
          videos,
        });
      } catch (saveError) {
        falhas.push({
          aula: nomeAulaFinal,
          url: item.url,
          erro: saveError.message || 'Falha ao salvar aula importada.',
        });
        continue;
      }

      importadas.push({
        nome: nomeAulaFinal,
        origemUrl: result.origemUrl,
        totalVideos: videos.length,
      });

      if (chaveAula) {
        chavesExistentes.add(chaveAula);
      }
    }

    return res.status(201).json({
      mensagem: 'Importacao de conteudo FIAP concluida.',
      conteudoFiap: alvoFiap.nome,
      totalAulasFiapOriginal: aulasFiap.length,
      totalAulasFiap: urls.length,
      totalProcessadas: resultadosLote.length,
      importadas,
      falhas,
      ignoradas,
    });
  } catch (error) {
    return res.status(400).json({ erro: error.message || 'Falha ao importar conteudo FIAP.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ erro: 'Rota nao encontrada.' });
});

ensureBaseFolders()
  .then(() => {
    app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Servidor iniciado em http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Erro ao iniciar servidor:', error);
    process.exit(1);
  });
