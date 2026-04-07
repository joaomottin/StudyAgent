const fs = require('fs/promises');
const path = require('path');

const SECTION_MAX_CHARS = 3000;

const SECTION_LABELS = {
  capa: 'capa',
  sumario: 'sumario',
  introducao: 'o que vem por ai',
  hands_on: 'hands on',
  saiba_mais: 'saiba mais',
  mercado_cases: 'mercado cases e tendencias',
  conclusao: 'o que voce viu nesta aula',
  referencias: 'referencias',
  palavras_chave: 'palavras chave',
};

const FERRAMENTAS_KEYWORDS = [
  'Pandas',
  'Matplotlib',
  'Seaborn',
  'Plotly',
  'NumPy',
  'Google Colab',
  'Jupyter',
  'Tableau',
  'Power BI',
  'Qlik',
  'Looker',
  'Google Data Studio',
  'Python',
  'DATASUS',
  'TabNet',
];

function normalizeText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function normalizeHeading(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeListItem(value) {
  return String(value || '')
    .replace(/^[-*•]\s*/, '')
    .replace(/^\d+[.)-]?\s*/, '')
    .trim();
}

function splitListValues(value) {
  return String(value || '')
    .split(/[,;\n]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function inferNumeroAula(nomeAula, materialText) {
  const source = `${nomeAula || ''}\n${materialText || ''}`;
  const match = source.match(/aula\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

function inferDisciplina(nomeAula, materialText) {
  const disciplinaLine = String(materialText || '').match(/disciplina\s*[:\-]\s*([^\n]+)/i);
  if (disciplinaLine && disciplinaLine[1]) {
    return disciplinaLine[1].trim();
  }

  const nome = String(nomeAula || '').trim();
  const beforeAula = nome.split(/aula\s*\d+/i)[0].trim();
  const cleaned = beforeAula.replace(/[-:|]+$/g, '').trim();
  return cleaned;
}

function extractFerramentas(texto) {
  const haystack = normalizeHeading(texto);

  return FERRAMENTAS_KEYWORDS.filter((tool) => {
    const needle = normalizeHeading(tool);
    const pattern = new RegExp(`(^|\\s)${needle.replace(/\s+/g, '\\s+')}($|\\s)`, 'i');
    return pattern.test(haystack);
  });
}

function truncateSection(text) {
  const value = String(text || '');
  if (value.length <= SECTION_MAX_CHARS) {
    return { text: value, truncated: false };
  }

  return {
    text: value.slice(0, SECTION_MAX_CHARS),
    truncated: true,
  };
}

function detectHandsOnCode(text) {
  const raw = String(text || '');
  const hasIndentCode = /^\s{4,}\S+/m.test(raw);
  const hasCommonCodeTokens = /\bimport\b|\bdef\b|pd\.|plt\./i.test(raw);
  return hasIndentCode || hasCommonCodeTokens;
}

function parseSectionBuckets(materialText) {
  const lines = String(materialText || '').replace(/\r\n/g, '\n').split('\n');

  const buckets = {
    introducao: [],
    hands_on: [],
    saiba_mais: [],
    mercado_cases: [],
    conclusao: [],
    referencias: [],
    palavras_chave: [],
  };

  const headingToKey = {
    [SECTION_LABELS.capa]: 'ignore',
    [SECTION_LABELS.sumario]: 'ignore',
    [SECTION_LABELS.introducao]: 'introducao',
    [SECTION_LABELS.hands_on]: 'hands_on',
    [SECTION_LABELS.saiba_mais]: 'saiba_mais',
    [SECTION_LABELS.mercado_cases]: 'mercado_cases',
    [SECTION_LABELS.conclusao]: 'conclusao',
    [SECTION_LABELS.referencias]: 'referencias',
    [SECTION_LABELS.palavras_chave]: 'palavras_chave',
  };

  let current = null;

  lines.forEach((line) => {
    const normalized = normalizeHeading(line);
    const directMatch = headingToKey[normalized];

    if (directMatch) {
      current = directMatch;
      return;
    }

    if (!current || current === 'ignore') {
      return;
    }

    buckets[current].push(line);
  });

  return {
    introducao: normalizeText(buckets.introducao.join('\n')),
    hands_on: normalizeText(buckets.hands_on.join('\n')),
    saiba_mais: normalizeText(buckets.saiba_mais.join('\n')),
    mercado_cases: normalizeText(buckets.mercado_cases.join('\n')),
    conclusao: normalizeText(buckets.conclusao.join('\n')),
    referencias: normalizeText(buckets.referencias.join('\n')),
    palavras_chave: normalizeText(buckets.palavras_chave.join('\n')),
  };
}

function buildAulaJsonSchema(nomeAula, materialText, videosText) {
  const sections = parseSectionBuckets(materialText);
  let resumoNecessario = false;

  const introducao = truncateSection(sections.introducao);
  const saibaMais = truncateSection(sections.saiba_mais);
  const mercadoCases = truncateSection(sections.mercado_cases);
  const conclusao = truncateSection(sections.conclusao);

  resumoNecessario =
    introducao.truncated || saibaMais.truncated || mercadoCases.truncated || conclusao.truncated;

  const handsOnRaw = sections.hands_on;
  let codigoHandsOn = null;
  let orientacaoPratica = null;

  if (handsOnRaw) {
    if (detectHandsOnCode(handsOnRaw)) {
      const truncated = truncateSection(handsOnRaw);
      codigoHandsOn = truncated.text;
      resumoNecessario = resumoNecessario || truncated.truncated;
    } else {
      const truncated = truncateSection(handsOnRaw);
      orientacaoPratica = truncated.text;
      resumoNecessario = resumoNecessario || truncated.truncated;
    }
  }

  const referencias = sections.referencias
    ? sections.referencias
        .split('\n')
        .map(normalizeListItem)
        .filter(Boolean)
    : [];

  const palavrasChave = sections.palavras_chave
    ? splitListValues(sections.palavras_chave).map(normalizeListItem).filter(Boolean)
    : [];

  const joinedForTools = [materialText, videosText].filter(Boolean).join('\n\n');
  const ferramentas = extractFerramentas(joinedForTools);

  return {
    titulo: String(nomeAula || '').trim(),
    disciplina: inferDisciplina(nomeAula, materialText),
    numero_aula: inferNumeroAula(nomeAula, materialText),
    palavras_chave: palavrasChave,
    ferramentas,
    codigo_hands_on: codigoHandsOn,
    orientacao_pratica: orientacaoPratica,
    introducao: introducao.text,
    saiba_mais: saibaMais.text,
    mercado_cases: mercadoCases.text || null,
    conclusao: conclusao.text,
    referencias,
    resumo_necessario: resumoNecessario,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    return false;
  }
}

async function readTextFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf-8');
  return normalizeText(raw);
}

async function listTxtFiles(dirPath) {
  if (!(await pathExists(dirPath))) {
    return [];
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.txt'))
    .map((entry) => ({
      name: entry.name,
      absolutePath: path.join(dirPath, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function readAulaMaterial(aulaDir) {
  const materialDir = path.join(aulaDir, 'ATranscritos');
  const txtFiles = await listTxtFiles(materialDir);

  if (txtFiles.length === 0) {
    return {
      text: '',
      files: [],
    };
  }

  const files = [];
  for (const file of txtFiles) {
    const content = await readTextFile(file.absolutePath);
    files.push({
      fileName: file.name,
      text: content,
    });
  }

  const joined = files
    .map((item) => `Arquivo: ${item.fileName}\n${item.text}`)
    .join('\n\n');

  return {
    text: joined,
    files,
  };
}

async function readAulaVideos(aulaDir) {
  const videosDir = path.join(aulaDir, 'VTranscritos');
  const txtFiles = await listTxtFiles(videosDir);

  const files = [];
  for (const file of txtFiles) {
    const content = await readTextFile(file.absolutePath);
    files.push({
      fileName: file.name,
      text: content,
    });
  }

  const joined = files
    .map((item) => `Video: ${item.fileName}\n${item.text}`)
    .join('\n\n');

  return {
    text: joined,
    files,
  };
}

async function readMaterialOriginalInfo(aulaDir) {
  const materialOriginalDir = path.join(aulaDir, 'MaterialOriginal');
  const files = await listTxtFiles(materialOriginalDir);

  // listTxtFiles filtra apenas .txt; para material original precisamos ler quaisquer arquivos.
  let allEntries = [];
  try {
    allEntries = await fs.readdir(materialOriginalDir, { withFileTypes: true });
  } catch (error) {
    return {
      hasPdf: false,
      pdfFileName: null,
      pdfAbsolutePath: null,
      files: files.map((f) => f.name),
    };
  }

  const realFiles = allEntries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const pdfEntry = realFiles.find((name) => name.toLowerCase().endsWith('.pdf'));

  return {
    hasPdf: Boolean(pdfEntry),
    pdfFileName: pdfEntry || null,
    pdfAbsolutePath: pdfEntry ? path.join(materialOriginalDir, pdfEntry) : null,
    files: realFiles,
  };
}

function buildAulaCombinedText(nomeAula, materialText, videosText) {
  const blocks = [];

  if (materialText) {
    blocks.push(`### Material da aula (${nomeAula})\n${materialText}`);
  }

  if (videosText) {
    blocks.push(`### Videos da aula (${nomeAula})\n${videosText}`);
  }

  return blocks.join('\n\n');
}

function normalizePortablePath(value) {
  return String(value || '').replace(/\\/g, '/');
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

async function listAulas(baseDir) {
  if (!(await pathExists(baseDir))) {
    return [];
  }

  const topLevelDirs = await listSubdirectories(baseDir);
  const aulas = [];

  for (const topLevelName of topLevelDirs) {
    const topLevelPath = path.join(baseDir, topLevelName);
    const isFaseDir = /^fase\s*\d+/i.test(topLevelName);

    if (!isFaseDir) {
      if (await pathExists(path.join(topLevelPath, 'ATranscritos'))) {
        aulas.push({
          nome: topLevelName,
          caminho: topLevelName,
          fase: null,
          conteudoGeral: null,
        });
      }

      continue;
    }

    const conteudos = await listSubdirectories(topLevelPath);

    for (const conteudoGeral of conteudos) {
      const conteudoPath = path.join(topLevelPath, conteudoGeral);
      const nomesAulas = await listSubdirectories(conteudoPath);

      for (const nomeAula of nomesAulas) {
        const aulaPath = path.join(conteudoPath, nomeAula);

        if (!(await pathExists(path.join(aulaPath, 'ATranscritos')))) {
          continue;
        }

        aulas.push({
          nome: nomeAula,
          caminho: normalizePortablePath(path.join(topLevelName, conteudoGeral, nomeAula)),
          fase: topLevelName,
          conteudoGeral,
        });
      }
    }
  }

  aulas.sort((a, b) => String(a.caminho || '').localeCompare(String(b.caminho || ''), 'pt-BR'));
  return aulas;
}

async function readAulaByName(baseDir, nomeAula) {
  const aulaIdentifier = normalizePortablePath(String(nomeAula || '').trim());

  if (!aulaIdentifier) {
    throw new Error('Nome da aula nao informado.');
  }

  const parts = aulaIdentifier.split('/').filter(Boolean);
  let aulaMeta = null;

  if (parts.length >= 3) {
    aulaMeta = {
      nome: parts[parts.length - 1],
      caminho: parts.join('/'),
      fase: parts[0],
      conteudoGeral: parts[1],
    };
  } else {
    const catalogo = await listAulas(baseDir);
    const matches = catalogo.filter(
      (item) => item.nome === aulaIdentifier || item.caminho === aulaIdentifier
    );

    if (matches.length === 0) {
      throw new Error(`Aula nao encontrada: ${aulaIdentifier}`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Existem multiplas aulas com o nome '${aulaIdentifier}'. Informe o caminho completo Fase/Conteudo/Aula.`
      );
    }

    aulaMeta = matches[0];
  }

  const aulaDir = path.join(baseDir, aulaMeta.caminho);

  if (!(await pathExists(aulaDir))) {
    throw new Error(`Aula nao encontrada: ${aulaIdentifier}`);
  }

  const [material, videos, materialOriginal] = await Promise.all([
    readAulaMaterial(aulaDir),
    readAulaVideos(aulaDir),
    readMaterialOriginalInfo(aulaDir),
  ]);

  const jsonEstruturado = buildAulaJsonSchema(aulaMeta.nome, material.text, videos.text);

  return {
    nome: aulaMeta.nome,
    caminho: aulaMeta.caminho,
    fase: aulaMeta.fase,
    conteudoGeral: aulaMeta.conteudoGeral,
    material,
    materialOriginal,
    videos,
    jsonEstruturado,
    totalVideos: videos.files.length,
    fullText: buildAulaCombinedText(aulaMeta.nome, material.text, videos.text),
  };
}

async function readAllAulas(baseDir, options = {}) {
  const aulas = await listAulas(baseDir);
  const allowedPaths = Array.isArray(options.allowedPaths) ? options.allowedPaths : null;
  const allowedSet =
    allowedPaths && allowedPaths.length
      ? new Set(allowedPaths.map((item) => normalizePortablePath(item).trim()).filter(Boolean))
      : null;

  const result = [];
  for (const aulaMeta of aulas) {
    if (allowedSet && !allowedSet.has(normalizePortablePath(aulaMeta.caminho).trim())) {
      continue;
    }

    const aula = await readAulaByName(baseDir, aulaMeta.caminho);
    result.push(aula);
  }

  return result;
}

function buildCorpusFromAulas(aulas) {
  return aulas
    .map((aula) => {
      if (!aula.fullText) {
        return `## Aula: ${aula.nome}\nSem transcricoes disponiveis.`;
      }

      return `## Aula: ${aula.nome}\n${aula.fullText}`;
    })
    .join('\n\n');
}

module.exports = {
  listAulas,
  readAulaByName,
  readAllAulas,
  buildCorpusFromAulas,
  buildAulaJsonSchema,
};
