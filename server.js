const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs/promises');
const { PDFParse } = require('pdf-parse');
const config = require('./config');

const app = express();
const PORT = config.PORT;
const ROOT_DIR = __dirname;
const AULAS_DIR = path.join(ROOT_DIR, 'aulas');

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
  const aulaTexto = normalizeLineBreaks(req.body.aulaTexto || req.body.transcricaoAula);
  const aulaArquivo = getSingleFileByField(req, 'aulaArquivo');
  const videos = parseVideosJson(req.body.videos);

  const aulaData = await extractAulaText(aulaArquivo, aulaTexto);
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
    nomeAula,
    aulaTranscricao,
    aulaArquivo,
    aulaSourceType: aulaData.sourceType,
    videos: videosNormalizados.filter((item) => item.transcricao),
  };
}

async function ensureBaseFolders() {
  await fs.mkdir(AULAS_DIR, { recursive: true });
}

async function listarAulas() {
  await ensureBaseFolders();

  const entradas = await fs.readdir(AULAS_DIR, { withFileTypes: true });
  const aulas = [];

  for (const entrada of entradas) {
    if (!entrada.isDirectory()) {
      continue;
    }

    const nomeAula = entrada.name;
    const videosDir = path.join(AULAS_DIR, nomeAula, 'VTranscritos');
    let totalVideos = 0;

    try {
      const videos = await fs.readdir(videosDir, { withFileTypes: true });
      totalVideos = videos.filter((item) => item.isFile() && item.name.endsWith('.txt')).length;
    } catch (error) {
      totalVideos = 0;
    }

    aulas.push({
      nome: nomeAula,
      totalVideos,
    });
  }

  aulas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  return aulas;
}

async function salvarAula(payload) {
  const { nomeAula, aulaTranscricao, videos, aulaArquivo } = payload;

  if (!nomeAula) {
    throw new Error('Nome da aula e obrigatorio.');
  }

  if (!aulaTranscricao) {
    throw new Error('Transcricao da aula e obrigatoria.');
  }

  const pastaAula = path.join(AULAS_DIR, nomeAula);
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

async function removerAula(nomeAula) {
  const nomeSeguro = sanitizeName(nomeAula);

  if (!nomeSeguro) {
    throw new Error('Nome da aula invalido.');
  }

  const destino = path.join(AULAS_DIR, nomeSeguro);
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
    res.json({ aulas });
  } catch (error) {
    res.status(500).json({ erro: 'Nao foi possivel listar as aulas.' });
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
    await removerAula(req.params.nome);
    res.json({ mensagem: 'Aula removida com sucesso.' });
  } catch (error) {
    res.status(400).json({ erro: error.message || 'Falha ao remover aula.' });
  }
});

app.post('/api/gemini', async (req, res) => {
  try {
    const { modo, aula, tema } = req.body || {};

    if (!modo) {
      return res.status(400).json({ erro: 'Campo modo e obrigatorio.' });
    }

    const geminiHandler = loadGeminiHandler();
    if (!geminiHandler) {
      return res.status(501).json({
        erro: 'Integracao Gemini ainda nao configurada. Crie gemini.js na etapa seguinte.',
      });
    }

    const resposta = await geminiHandler({ modo, aula, tema, aulasDir: AULAS_DIR });
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
