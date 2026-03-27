const {
  readAulaByName,
  readAllAulas,
} = require('./fileReader');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_PDF_INLINE_BYTES = Number(process.env.GEMINI_MAX_PDF_INLINE_BYTES || 4500000);
const GEMINI_CACHE_TTL_SECONDS = Number(process.env.GEMINI_CACHE_TTL_SECONDS || 86400);
const GEMINI_CACHE_DIR = path.join(__dirname, '.cache', 'gemini');

function getApiKey() {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY nao encontrada no arquivo .env.');
  }

  return apiKey;
}

function normalizeMode(rawMode) {
  return String(rawMode || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function extractResponseText(payload) {
  const candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : [];

  if (candidates.length === 0) {
    return '';
  }

  const parts = candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function cleanJsonText(value) {
  const text = String(value || '').trim();

  if (!text) {
    return text;
  }

  if (text.startsWith('```')) {
    return text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
  }

  return text;
}

function toPrettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

async function ensureCacheDir() {
  await fs.mkdir(GEMINI_CACHE_DIR, { recursive: true });
}

function buildCacheKey({ modo, aula, tema, prompt, forceJson, pdfFingerprint }) {
  const payload = {
    model: GEMINI_MODEL,
    modo: String(modo || ''),
    aula: String(aula || ''),
    tema: String(tema || ''),
    forceJson: Boolean(forceJson),
    pdfFingerprint: String(pdfFingerprint || ''),
    promptHash: sha256(prompt),
  };

  return sha256(JSON.stringify(payload));
}

async function readFromCache(cacheKey) {
  if (!cacheKey) {
    return null;
  }

  const cacheFile = path.join(GEMINI_CACHE_DIR, `${cacheKey}.json`);

  try {
    const raw = await fs.readFile(cacheFile, 'utf-8');
    const data = JSON.parse(raw);

    if (!data || typeof data !== 'object') {
      return null;
    }

    const createdAt = Number(data.createdAt || 0);
    const ageMs = Date.now() - createdAt;
    const ttlMs = GEMINI_CACHE_TTL_SECONDS * 1000;

    if (ttlMs > 0 && ageMs > ttlMs) {
      return null;
    }

    return typeof data.response === 'string' ? data.response : null;
  } catch (error) {
    return null;
  }
}

async function saveToCache(cacheKey, responseText) {
  if (!cacheKey || !responseText) {
    return;
  }

  await ensureCacheDir();

  const cacheFile = path.join(GEMINI_CACHE_DIR, `${cacheKey}.json`);
  const payload = {
    createdAt: Date.now(),
    response: responseText,
  };

  await fs.writeFile(cacheFile, JSON.stringify(payload, null, 2), 'utf-8');
}

function sliceText(value, maxChars = 1800) {
  const text = String(value || '').trim();
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}...`;
}

function getStructuredAulaData(aulaData) {
  const schema = aulaData?.jsonEstruturado;

  if (schema && typeof schema === 'object') {
    return schema;
  }

  return {
    titulo: aulaData?.nome || '',
    disciplina: '',
    numero_aula: null,
    palavras_chave: [],
    ferramentas: [],
    codigo_hands_on: null,
    orientacao_pratica: null,
    introducao: '',
    saiba_mais: aulaData?.material?.text || '',
    mercado_cases: null,
    conclusao: '',
    referencias: [],
    resumo_necessario: false,
  };
}

function buildAulaContextPayload(aulaData) {
  const schema = getStructuredAulaData(aulaData);

  return {
    aula: {
      titulo: schema.titulo,
      disciplina: schema.disciplina,
      numero_aula: schema.numero_aula,
      palavras_chave: schema.palavras_chave,
      ferramentas: schema.ferramentas,
      resumo_necessario: schema.resumo_necessario,
      material_original_pdf: Boolean(aulaData?.materialOriginal?.hasPdf),
    },
    conteudo: {
      introducao: schema.introducao,
      saiba_mais: schema.saiba_mais,
      mercado_cases: schema.mercado_cases,
      conclusao: schema.conclusao,
      referencias: schema.referencias,
      codigo_hands_on: schema.codigo_hands_on,
      orientacao_pratica: schema.orientacao_pratica,
    },
    videos: aulaData?.videos?.files?.map((video) => ({
      arquivo: video.fileName,
      trecho: sliceText(video.text, 1400),
    })) || [],
  };
}

function buildSearchCorpusFromStructuredAulas(aulas) {
  const items = aulas.map((aulaData) => {
    const schema = getStructuredAulaData(aulaData);

    return {
      aula: schema.titulo || aulaData.nome,
      disciplina: schema.disciplina,
      numero_aula: schema.numero_aula,
      palavras_chave: schema.palavras_chave,
      ferramentas: schema.ferramentas,
      resumo_necessario: schema.resumo_necessario,
      material_original_pdf: Boolean(aulaData?.materialOriginal?.hasPdf),
      introducao: sliceText(schema.introducao, 1200),
      saiba_mais: sliceText(schema.saiba_mais, 1800),
      mercado_cases: sliceText(schema.mercado_cases, 1000),
      conclusao: sliceText(schema.conclusao, 900),
      codigo_hands_on: sliceText(schema.codigo_hands_on, 900),
      orientacao_pratica: sliceText(schema.orientacao_pratica, 900),
      referencias: schema.referencias,
      videos: (aulaData?.videos?.files || []).map((video) => ({
        arquivo: video.fileName,
        trecho: sliceText(video.text, 700),
      })),
    };
  });

  return toPrettyJson(items);
}

function buildResumoNecessarioHint(schema) {
  if (!schema?.resumo_necessario) {
    return '';
  }

  return [
    'IMPORTANTE: esta aula possui resumo_necessario=true.',
    'Antes da resposta final, sintetize internamente secoes longas para reduzir redundancia e manter fidelidade conceitual.',
  ].join('\n');
}

async function buildPdfInlinePart(aulaData) {
  const pdfPath = aulaData?.materialOriginal?.pdfAbsolutePath;

  if (!pdfPath) {
    return {
      part: null,
      note: 'Nenhum PDF original disponivel para esta aula.',
      fingerprint: 'no-pdf',
    };
  }

  const stat = await fs.stat(pdfPath);
  const fingerprint = `${pdfPath}|${stat.size}|${Math.floor(stat.mtimeMs)}`;

  if (stat.size > MAX_PDF_INLINE_BYTES) {
    return {
      part: null,
      note: `PDF ignorado por tamanho (${stat.size} bytes). Limite atual: ${MAX_PDF_INLINE_BYTES} bytes.`,
      fingerprint: `skipped:${fingerprint}`,
    };
  }

  const buffer = await fs.readFile(pdfPath);

  return {
    part: {
      inlineData: {
        mimeType: 'application/pdf',
        data: buffer.toString('base64'),
      },
    },
    note: `PDF original incluido para analise visual (${stat.size} bytes).`,
    fingerprint,
  };
}

async function callGeminiApi(
  prompt,
  { forceJson = false, extraParts = [], cacheKey = null } = {}
) {
  const cached = await readFromCache(cacheKey);
  if (cached) {
    return cached;
  }

  const apiKey = getApiKey();
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;

  async function executeCall(parts) {
    const body = {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        temperature: 0.3,
      },
    };

    if (forceJson) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.temperature = 0.2;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const apiMessage = data?.error?.message || `Erro HTTP ${response.status}`;
      throw new Error(`Falha na chamada Gemini: ${apiMessage}`);
    }

    const text = extractResponseText(data);

    if (!text) {
      throw new Error('A API Gemini retornou resposta vazia.');
    }

    return text;
  }

  const partsWithExtras = [{ text: prompt }, ...extraParts];

  try {
    const text = await executeCall(partsWithExtras);
    await saveToCache(cacheKey, text);
    return text;
  } catch (error) {
    if (!extraParts.length) {
      throw error;
    }

    const message = String(error?.message || '').toLowerCase();
    const maybeMultimodalError =
      message.includes('inline') ||
      message.includes('mime') ||
      message.includes('part') ||
      message.includes('payload') ||
      message.includes('request');

    if (!maybeMultimodalError) {
      throw error;
    }

    const text = await executeCall([{ text: prompt }]);
    await saveToCache(cacheKey, text);
    return text;
  }
}

function buildPromptResumo(contexto, multimodalHint) {
  return [
    'Com base no JSON estruturado da aula e trechos dos videos, gere um resumo estruturado em markdown com: Introducao, Principais Conceitos, Ferramentas e Tecnologias Mencionadas, Dicas Importantes e Conclusao.',
    multimodalHint,
    '',
    buildResumoNecessarioHint(contexto.aula),
    '',
    'Contexto da aula (JSON):',
    toPrettyJson(contexto),
  ].join('\n');
}

function buildPromptMapaMental(contexto, multimodalHint) {
  return [
    'Com base no JSON estruturado da aula e trechos dos videos, gere um mapa mental hierarquico em markdown usando bullets e sub-bullets. O tema central deve ser o assunto principal da aula. Use no maximo 4 niveis de hierarquia.',
    multimodalHint,
    '',
    buildResumoNecessarioHint(contexto.aula),
    '',
    'Contexto da aula (JSON):',
    toPrettyJson(contexto),
  ].join('\n');
}

function buildPromptFlashcards(contexto, multimodalHint) {
  return [
    'Com base no JSON estruturado da aula e trechos dos videos, gere entre 8 e 12 pares de pergunta e resposta para revisao de estudo. Retorne SOMENTE um JSON valido, sem markdown, no formato: [{"pergunta": "...", "resposta": "..."}]',
    multimodalHint,
    '',
    buildResumoNecessarioHint(contexto.aula),
    '',
    'Contexto da aula (JSON):',
    toPrettyJson(contexto),
  ].join('\n');
}

function buildPromptBuscaTema(corpus, tema) {
  return [
    `Abaixo estao dados estruturados de multiplas aulas. Encontre e explique tudo relacionado ao tema: '${tema}'. Para cada trecho relevante, indique de qual aula ele veio. Organize por aula e seja especifico.`,
    'Se encontrar aulas com resumo_necessario=true, priorize consolidacao objetiva sem perder informacao importante.',
    '',
    'Dados das aulas (JSON):',
    corpus,
  ].join('\n');
}

function ensureAulaName(aula) {
  const nomeAula = String(aula || '').trim();

  if (!nomeAula) {
    throw new Error('Campo aula e obrigatorio para este modo.');
  }

  return nomeAula;
}

function ensureTema(tema) {
  const temaLimpo = String(tema || '').trim();

  if (!temaLimpo) {
    throw new Error('Campo tema e obrigatorio para busca por tema.');
  }

  return temaLimpo;
}

function parseFlashcards(jsonText) {
  const cleaned = cleanJsonText(jsonText);
  const parsed = JSON.parse(cleaned);

  if (!Array.isArray(parsed)) {
    throw new Error('Formato de flashcards invalido: esperado array JSON.');
  }

  const normalized = parsed
    .map((item) => ({
      pergunta: String(item?.pergunta || '').trim(),
      resposta: String(item?.resposta || '').trim(),
    }))
    .filter((item) => item.pergunta && item.resposta);

  if (normalized.length === 0) {
    throw new Error('Nenhum flashcard valido foi retornado pela IA.');
  }

  return JSON.stringify(normalized, null, 2);
}

async function gerarResumo({ aula, aulasDir }) {
  const nomeAula = ensureAulaName(aula);
  const aulaData = await readAulaByName(aulasDir, nomeAula);
  const contexto = buildAulaContextPayload(aulaData);
  const pdfInput = await buildPdfInlinePart(aulaData);

  if (!aulaData.fullText && !contexto?.conteudo?.saiba_mais) {
    throw new Error(`A aula '${nomeAula}' nao possui transcricoes para resumir.`);
  }

  const prompt = buildPromptResumo(contexto, `Contexto multimodal PDF: ${pdfInput.note}`);
  const cacheKey = buildCacheKey({
    modo: 'resumo',
    aula: nomeAula,
    tema: '',
    prompt,
    forceJson: false,
    pdfFingerprint: pdfInput.fingerprint,
  });

  return callGeminiApi(prompt, {
    extraParts: pdfInput.part ? [pdfInput.part] : [],
    cacheKey,
  });
}

async function gerarMapaMental({ aula, aulasDir }) {
  const nomeAula = ensureAulaName(aula);
  const aulaData = await readAulaByName(aulasDir, nomeAula);
  const contexto = buildAulaContextPayload(aulaData);
  const pdfInput = await buildPdfInlinePart(aulaData);

  if (!aulaData.fullText && !contexto?.conteudo?.saiba_mais) {
    throw new Error(`A aula '${nomeAula}' nao possui transcricoes para mapa mental.`);
  }

  const prompt = buildPromptMapaMental(contexto, `Contexto multimodal PDF: ${pdfInput.note}`);
  const cacheKey = buildCacheKey({
    modo: 'mapa mental',
    aula: nomeAula,
    tema: '',
    prompt,
    forceJson: false,
    pdfFingerprint: pdfInput.fingerprint,
  });

  return callGeminiApi(prompt, {
    extraParts: pdfInput.part ? [pdfInput.part] : [],
    cacheKey,
  });
}

async function gerarFlashcards({ aula, aulasDir }) {
  const nomeAula = ensureAulaName(aula);
  const aulaData = await readAulaByName(aulasDir, nomeAula);
  const contexto = buildAulaContextPayload(aulaData);
  const pdfInput = await buildPdfInlinePart(aulaData);

  if (!aulaData.fullText && !contexto?.conteudo?.saiba_mais) {
    throw new Error(`A aula '${nomeAula}' nao possui transcricoes para flashcards.`);
  }

  const prompt = buildPromptFlashcards(contexto, `Contexto multimodal PDF: ${pdfInput.note}`);
  const cacheKey = buildCacheKey({
    modo: 'flashcards',
    aula: nomeAula,
    tema: '',
    prompt,
    forceJson: true,
    pdfFingerprint: pdfInput.fingerprint,
  });

  const raw = await callGeminiApi(prompt, {
    forceJson: true,
    extraParts: pdfInput.part ? [pdfInput.part] : [],
    cacheKey,
  });
  return parseFlashcards(raw);
}

async function gerarBuscaPorTema({ tema, aulasDir }) {
  const temaLimpo = ensureTema(tema);
  const aulas = await readAllAulas(aulasDir);

  if (aulas.length === 0) {
    throw new Error('Nenhuma aula encontrada para realizar a busca.');
  }

  const corpus = buildSearchCorpusFromStructuredAulas(aulas);
  const prompt = buildPromptBuscaTema(corpus, temaLimpo);
  const cacheKey = buildCacheKey({
    modo: 'busca por tema',
    aula: '',
    tema: temaLimpo,
    prompt,
    forceJson: false,
    pdfFingerprint: 'search-text-only',
  });

  return callGeminiApi(prompt, { cacheKey });
}

async function gerarRespostaGemini({ modo, aula, tema, aulasDir }) {
  const normalizedMode = normalizeMode(modo);

  if (normalizedMode === 'resumo') {
    return gerarResumo({ aula, aulasDir });
  }

  if (normalizedMode === 'mapa' || normalizedMode === 'mapa mental' || normalizedMode === 'mapamental') {
    return gerarMapaMental({ aula, aulasDir });
  }

  if (normalizedMode === 'flashcards' || normalizedMode === 'flashcard') {
    return gerarFlashcards({ aula, aulasDir });
  }

  if (
    normalizedMode === 'busca' ||
    normalizedMode === 'busca por tema' ||
    normalizedMode === 'tema'
  ) {
    return gerarBuscaPorTema({ tema, aulasDir });
  }

  throw new Error(
    'Modo invalido. Use: resumo, mapa mental, flashcards ou busca por tema.'
  );
}

module.exports = {
  gerarRespostaGemini,
};
