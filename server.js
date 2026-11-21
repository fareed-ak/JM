import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import Groq from 'groq-sdk';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const app = express();
const port = Number(process.env.PORT || 3001);
const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
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
      const modulePath = resolve(projectRoot, 'constants', file);
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
const tokenize = (text) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function retrieve(question, limit = 5) {
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

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'jagruk-mahila-rag' }));
app.get('/health', (_req, res) => res.json({ status: 'ok', indexedDocuments: documents.length }));
app.post('/chat', async (req, res) => {
  const question = req.body?.question;
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    return res.status(400).json({ errorCode: 'bad_request', error: 'Please provide a question under 4,000 characters.' });
  }
  if (!groq) return res.status(503).json({ errorCode: 'service_unavailable', error: 'The chat service is not configured.' });
  const sources = retrieve(question.trim());
  if (!sources.length) return res.json({ answer: 'I could not find relevant information in the app’s current legal awareness content. Please try asking in another way or consult a qualified legal professional.' });
  try {
    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: 'system', content: 'You are Jagruk Mahila, a legal-awareness assistant for women in India. Answer in the language used by the user. Use only the supplied app context; do not invent laws, deadlines, rights, or procedures. If context is insufficient, say so. Give clear, supportive general information, not individualized legal advice. For immediate danger, say to call 112. Finish with a brief reminder that this is awareness information, not legal advice.' },
        { role: 'user', content: `Question:\n${question.trim()}\n\nRetrieved app context:\n${sources.map((s, i) => `[${i + 1}] ${s.source}: ${s.text}`).join('\n\n')}` },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim();
    if (!answer) throw new Error('Model returned an empty answer');
    return res.json({ answer: `${answer}\n\nSources: ${[...new Set(sources.map((s) => s.source))].join(', ')}` });
  } catch (error) {
    console.error('Groq request failed:', error.message);
    return res.status(502).json({ errorCode: 'service_unavailable', error: 'The chat service is not available right now.' });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`Jagruk Mahila RAG listening on port ${port}; indexed ${documents.length} passages`));
