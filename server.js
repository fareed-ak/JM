import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Groq from 'groq-sdk';
import { pipeline } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const knowledgeDirectory = resolve(here, 'data');
const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const embeddingModel = process.env.EMBEDDING_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const origins = (process.env.ALLOWED_ORIGINS || '*').split(',').map((x) => x.trim()).filter(Boolean);
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;

const corsOptions = origins.includes('*') ? { origin: true } : {
  origin(origin, callback) {
    if (!origin || origins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '32kb' }));
app.set('trust proxy', 1);
app.use('/chat', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

const langs = ['en', 'hi', 'ur'];
const humanize = (value) => String(value).replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const localized = (value, fallback = '') => {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return fallback;
  return langs.map((lang) => value[lang] ? `${lang.toUpperCase()}: ${value[lang]}` : '').filter(Boolean).join('\n');
};
const primitives = (value, path = []) => {
  if (typeof value === 'string' || typeof value === 'number') return [`${path.map(humanize).join(' > ')}: ${value}`];
  if (Array.isArray(value)) return value.flatMap((item, index) => primitives(item, [...path, String(index + 1)]));
  if (!value || typeof value !== 'object') return [];
  if (langs.some((lang) => typeof value[lang] === 'string')) return [localized(value)];
  return Object.entries(value).flatMap(([key, item]) => {
    if (['id', 'icon'].includes(key)) return [];
    return primitives(item, [...path, key]);
  });
};

function readKnowledgeBase() {
  const files = [
    ['aboutData.js', 'About'], ['bnssData.js', 'Bharatiya Nyaya Suraksha Sanhita'],
    ['casesData.js', 'Landmark cases'], ['constitutionData.js', 'Constitution'],
    ['cyberCrimesData.js', 'Cyber crimes'], ['faqData.js', 'Frequently asked questions'],
    ['helplineData.js', 'Helplines'], ['marriageOffensesData.js', 'Marriage offences'],
    ['otherOffencesData.js', 'Other offences'], ['privacyData.js', 'Privacy'],
    ['reproductiveRightsData.js', 'Reproductive rights'], ['sexualCrimesData.js', 'Sexual crimes'],
  ];
  const docs = [];
  for (const [file, label] of files) {
    try {
      const modulePath = resolve(knowledgeDirectory, file);
      const source = readFileSync(modulePath, 'utf8');
      const keys = [...source.matchAll(/^export\s+const\s+(\w+)\s*=/gm)].map((match) => match[1]);
      const executable = source.replace(/^export\s+const\s+/gm, 'const ') +
        `\nmodule.exports = { ${keys.join(', ')} };`;
      const sandbox = { module: { exports: {} } };
      vm.runInNewContext(executable, sandbox, { filename: modulePath, timeout: 1000 });
      const data = sandbox.module.exports;
      const chunks = keys.flatMap((key) => primitives(data[key], [key]));
      chunks.forEach((body, i) => {
        const normalized = body.replace(/\s+/g, ' ').trim();
        if (normalized.length > 30) docs.push({ id: `${file}:${i}`, source: label, text: normalized });
      });
    } catch (error) {
      console.warn(`Skipping ${file}: ${error.message}`);
    }
  }
  return docs;
}

const documents = readKnowledgeBase();
let embedder = null;
let documentEmbeddings = [];
let embeddingStatus = 'loading';
const tokenize = (text) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function lexicalRetrieve(question, limit = 5) {
  const query = new Set(tokenize(question));
  const scored = documents.map((doc) => {
    const terms = tokenize(doc.text);
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
    let score = 0;
    for (const term of query) {
      if (counts.has(term)) score += Math.log(1 + terms.length / (counts.get(term) + 1));
    }
    return { ...doc, score };
  });
  return scored.filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

const cosineSimilarity = (a, b) => {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) dot += a[i] * b[i];
  return dot;
};

async function embed(texts) {
  const output = await embedder(texts, { pooling: 'mean', normalize: true });
  const rows = output.tolist();
  return Array.isArray(rows[0]) ? rows : [rows];
}

async function buildEmbeddings() {
  if (!documents.length) {
    embeddingStatus = 'no_documents';
    return;
  }
  try {
    console.log(`Loading multilingual embedding model ${embeddingModel}`);
    embedder = await pipeline('feature-extraction', embeddingModel);
    documentEmbeddings = [];
    for (let i = 0; i < documents.length; i += 16) {
      const batch = documents.slice(i, i + 16);
      documentEmbeddings.push(...await embed(batch.map((doc) => doc.text)));
    }
    embeddingStatus = 'ready';
    console.log(`Built ${documentEmbeddings.length} document embeddings`);
  } catch (error) {
    embeddingStatus = 'unavailable';
    embedder = null;
    console.error('Embedding model unavailable; using lexical retrieval:', error.message);
  }
}

async function retrieve(question, limit = 5) {
  if (embedder && documentEmbeddings.length === documents.length) {
    try {
      const [queryVector] = await embed([question]);
      return documents
        .map((doc, index) => ({ ...doc, score: cosineSimilarity(queryVector, documentEmbeddings[index]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch (error) {
      console.error('Query embedding failed; using lexical retrieval:', error.message);
    }
  }
  return lexicalRetrieve(question, limit);
}

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'jagruk-mahila-rag' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', indexedDocuments: documents.length, embeddingStatus, embeddedDocuments: documentEmbeddings.length }));
app.post('/chat', async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    return res.status(400).json({ errorCode: 'bad_request', error: 'Please provide a question under 4,000 characters.' });
  }
  if (!groq) return res.status(503).json({ errorCode: 'service_unavailable', error: 'The chat service is not configured.' });
  const sources = await retrieve(question.trim());
  try {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: 'You are Jagruk Mahila, a legal-awareness assistant for women in India. Answer in the language used by the user. Prefer the supplied app context and clearly say when it does not cover the question. If no context is supplied, provide cautious general legal-awareness information based on your knowledge and explicitly say the app sources did not cover it; do not invent specific laws, deadlines, rights, or procedures. For immediate danger, say to call 112. Do not claim to be a lawyer or provide individualized legal advice. Finish with a brief reminder to verify important legal information with an authoritative source or qualified professional.' },
        { role: 'user', content: `Question:\n${question.trim()}\n\nRetrieved app context:\n${sources.length ? sources.map((s, i) => `[${i + 1}] ${s.source}: ${s.text}`).join('\n\n') : '[No relevant passage was retrieved from the app knowledge base. Answer the user cautiously without claiming that the app provided supporting source material.]'}` },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error('Model returned an empty answer');
    const sourceLine = sources.length ? `\n\nApp sources: ${[...new Set(sources.map((s) => s.source))].join(', ')}` : '\n\nNote: No relevant app source was retrieved; verify this general information with an authoritative source.';
    return res.json({ answer: `${answer}${sourceLine}` });
  } catch (error) {
    console.error('Groq request failed:', error.message);
    return res.status(502).json({ errorCode: 'service_unavailable', error: 'The chat service is not available right now.' });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Jagruk Mahila RAG listening on port ${port}; indexed ${documents.length} passages`);
  buildEmbeddings();
});
