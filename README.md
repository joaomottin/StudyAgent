# Estudo Agent

Agente de estudos local com interface web (HTML/CSS/JS puro), backend em Node.js e integração com Gemini.

O sistema permite:
- cadastrar aulas com transcrição principal e transcrições de vídeos;
- salvar tudo em disco na pasta `aulas/`;
- aceitar material da aula em `.txt` ou `.pdf` (com extração automática de texto);
- gerar conteúdo com IA em 4 modos:
  - Resumo
  - Mapa Mental
  - Flashcards
  - Busca por Tema

## Stack

- Backend: Node.js + Express + Multer + CORS + dotenv
- Frontend: HTML, CSS e JavaScript puro
- IA: Google Gemini API (`gemini-3.1-pro-preview`)
- Persistência: arquivos `.txt` no disco

## Estrutura do projeto

```text
estudo-agent/
├── aulas/
│   ├── Aula1/
│   │   ├── VTranscritos/
│   │   └── ATranscritos/
│   └── ...
├── index.html
├── style.css
├── app.js
├── server.js
├── gemini.js
├── fileReader.js
├── .env
├── package.json
└── README.md
```

A pasta `aulas/` e subpastas são criadas automaticamente pelo servidor conforme você salva novas aulas.

## Requisitos

- Node.js 18+ (recomendado Node 20+)
- Chave da API Gemini

## Instalação

1. Abra o terminal na pasta do projeto.
2. Instale as dependências:

```bash
npm install
```

## Configuração da chave Gemini

Comece copiando o arquivo de exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Crie um arquivo `.env` na raiz do projeto com:

```env
GEMINI_API_KEY=sua_chave_aqui
PORT=3000
GEMINI_MAX_PDF_INLINE_BYTES=4500000
GEMINI_CACHE_TTL_SECONDS=86400
```

Observações:
- a chave fica somente no backend;
- o frontend nunca chama o Gemini diretamente.
- `GEMINI_MAX_PDF_INLINE_BYTES` controla o tamanho maximo do PDF enviado no modo multimodal.
- `GEMINI_CACHE_TTL_SECONDS` define por quantos segundos respostas do Gemini ficam em cache local.

## Como executar

Modo normal:

```bash
npm start
```

Modo desenvolvimento (watch):

```bash
npm run dev
```

Depois abra no navegador:

```text
http://localhost:3000
```

## Endpoints da API

### `GET /api/aulas`
Lista aulas disponíveis.

Exemplo de resposta:

```json
{
  "aulas": [
    { "nome": "Aula 1 - Aquisição de Dados", "totalVideos": 3 }
  ]
}
```

### `POST /api/aulas`
Cria nova aula com texto e/ou uploads `.txt`/`.pdf` (aula) e `.txt` (videos).

Payload esperado:
- `nomeAula` (string)
- `aulaTexto` (string opcional, se houver arquivo)
- `aulaArquivo` (arquivo `.txt` ou `.pdf`, opcional se houver texto)
- `videos` (JSON string com array de `{ "nome": "...", "texto": "..." }`)
- `videoArquivo_{index}` (arquivos opcionais por vídeo)

### `DELETE /api/aulas/:nome`
Remove uma aula pelo nome.

### `POST /api/gemini`
Recebe:

```json
{
  "modo": "resumo | mapa mental | flashcards | busca por tema",
  "aula": "nome da aula (quando aplicável)",
  "tema": "tema da busca (quando aplicável)"
}
```

Retorna:

```json
{
  "resposta": "texto gerado pela IA"
}
```

## Fluxo da interface

## 1) Painel de Aulas
- botão `+ Adicionar Aula`;
- lista de cards com nome da aula, total de vídeos, botão `Estudar` e `Excluir`.

## 2) Modal Adicionar Aula
- nome da aula;
- transcrição da aula por texto ou upload `.txt/.pdf`;
- múltiplos vídeos, cada um com nome + texto ou upload `.txt`;
- botão `Salvar e Processar Aula` com loader durante envio.

## 3) Tela Estudar
- modos:
  - `Resumo`
  - `Mapa Mental`
  - `Flashcards`
  - `Busca por Tema`
- comportamento:
  - Resumo/Mapa/Flashcards: botão `Gerar`;
  - Busca por Tema: input + botão `Buscar` e suporte a Enter.

## Modos de IA

### Resumo
Gera resumo estruturado em markdown com:
- Introdução
- Principais Conceitos
- Ferramentas e Tecnologias Mencionadas
- Dicas Importantes
- Conclusão

### Mapa Mental
Gera markdown hierárquico em bullets e renderiza como árvore colapsável na interface.

### Flashcards
Gera JSON com pares pergunta/resposta. A UI mostra:
- card com flip 3D (clique para virar)
- navegação `Anterior` / `Próximo`
- indicador de posição (`3/10`)
- botão `Embaralhar`

### Busca por Tema
Varre todas as aulas de `aulas/`, retorna explicações por aula e destaca origem com badges.

## Segurança

- `GEMINI_API_KEY` fica apenas no `.env`;
- a chamada ao Gemini é feita somente em `server.js` -> `gemini.js`;
- frontend não recebe nem expõe chave.

## Pipeline multimodal do PDF

- Ao salvar uma aula com PDF, o servidor extrai texto e salva o arquivo original em `aulas/<Aula>/MaterialOriginal/material.pdf`.
- Nos modos `Resumo`, `Mapa Mental` e `Flashcards`, o backend tenta enviar o PDF original como contexto multimodal para o Gemini.
- Se o PDF estiver acima do limite (`GEMINI_MAX_PDF_INLINE_BYTES`) ou a API rejeitar o payload multimodal, o sistema faz fallback automatico para modo texto sem interromper a resposta.

## Cache de respostas da IA

- O backend salva respostas do Gemini em cache local em `/.cache/gemini`.
- A chave do cache considera modelo, modo, aula/tema, hash do prompt e fingerprint do PDF (quando houver).
- Consultas repetidas com o mesmo contexto retornam do cache, reduzindo consumo de tokens e latencia.
- O tempo de validade do cache e controlado por `GEMINI_CACHE_TTL_SECONDS`.

## Solução de problemas

- Erro `GEMINI_API_KEY nao encontrada`: verifique o `.env` na raiz do projeto.
- Erro ao salvar aula: confirme se preencheu nome da aula, transcrição principal e pelo menos 1 vídeo com texto/arquivo.
- Resposta vazia do Gemini: tente novamente e valide se sua chave tem acesso ao modelo.

## Scripts disponíveis

```json
{
  "start": "node server.js",
  "dev": "node --watch server.js"
}
```

## Licença

MIT
