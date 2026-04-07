const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { PDFParse } = require('pdf-parse');
const dotenv = require('dotenv');

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
const FASES_INDEX = new Map(FASES_CONFIG.map((fase) => [fase.numero, fase]));

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

function normalizeModeName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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

  return {
    fase,
    nomeConteudo,
  };
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
      podeCriarConteudo: fase.conteudos.length < fase.limiteConteudos,
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
