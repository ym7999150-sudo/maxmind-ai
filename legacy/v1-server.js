/**
 * MuxMind AI — Enterprise multi-provider AI chat backend
 * Pure Node.js + Express, zero AI-vendor SDKs. Uses native fetch (Node >=18).
 */

'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

/* --------------------------------------------------------------------- */
/*  Core middleware                                                       */
/* --------------------------------------------------------------------- */

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Structured request logger
app.use((req, res, next) => {
  const start = Date.now();
  const id = crypto.randomUUID();
  req.requestId = id;
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(
      JSON.stringify({
        id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms,
        ts: new Date().toISOString()
      })
    );
  });
  next();
});

/* --------------------------------------------------------------------- */
/*  Helpers                                                                */
/* --------------------------------------------------------------------- */

function sendError(res, status, message, details) {
  return res.status(status).json({
    error: {
      message: message || 'Unexpected error',
      status: status,
      details: details || null,
      timestamp: new Date().toISOString()
    }
  });
}

async function safeFetchJson(url, options) {
  let resp;
  try {
    resp = await fetch(url, options);
  } catch (networkErr) {
    const err = new Error(`Network error contacting provider: ${networkErr.message}`);
    err.status = 502;
    throw err;
  }

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_e) {
    data = { raw: text };
  }

  if (!resp.ok) {
    const message =
      (data && data.error && (data.error.message || data.error)) ||
      data.message ||
      `Provider returned HTTP ${resp.status}`;
    const err = new Error(message);
    err.status = resp.status;
    err.providerBody = data;
    throw err;
  }

  return data;
}

/* --------------------------------------------------------------------- */
/*  Provider adapters — each returns { content, raw }                     */
/* --------------------------------------------------------------------- */

async function callOpenAI({ apiKey, model, messages, temperature, maxTokens, baseUrl }) {
  if (!apiKey) throw Object.assign(new Error('Missing OpenAI API key'), { status: 400 });
  const url = `${baseUrl || 'https://api.openai.com/v1'}/chat/completions`;
  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      messages,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens || 2048
    })
  });
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data };
}

async function callGroq({ apiKey, model, messages, temperature, maxTokens }) {
  if (!apiKey) throw Object.assign(new Error('Missing Groq API key'), { status: 400 });
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'llama-3.3-70b-versatile',
      messages,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens || 2048
    })
  });
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data };
}

async function callDeepSeek({ apiKey, model, messages, temperature, maxTokens }) {
  if (!apiKey) throw Object.assign(new Error('Missing DeepSeek API key'), { status: 400 });
  const url = 'https://api.deepseek.com/chat/completions';
  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens || 2048
    })
  });
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data };
}

async function callCustom({ apiKey, model, messages, temperature, maxTokens, baseUrl }) {
  if (!baseUrl) throw Object.assign(new Error('Missing custom baseUrl'), { status: 400 });
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const data = await safeFetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || 'default',
      messages,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens || 2048
    })
  });
  const content = data?.choices?.[0]?.message?.content || '';
  return { content, raw: data };
}

async function callAnthropic({ apiKey, model, messages, temperature, maxTokens, systemPrompt }) {
  if (!apiKey) throw Object.assign(new Error('Missing Anthropic API key'), { status: 400 });
  const url = 'https://api.anthropic.com/v1/messages';

  // Split system message out, Anthropic wants it separate
  let system = systemPrompt || '';
  const convo = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
    } else {
      convo.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
    }
  }

  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-6',
      system: system || undefined,
      messages: convo,
      temperature: temperature != null ? temperature : 0.7,
      max_tokens: maxTokens || 2048
    })
  });

  const content = (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { content, raw: data };
}

async function callGemini({ apiKey, model, messages, temperature, maxTokens, systemPrompt }) {
  if (!apiKey) throw Object.assign(new Error('Missing Gemini API key'), { status: 400 });
  const chosenModel = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${chosenModel}:generateContent?key=${apiKey}`;

  let system = systemPrompt || '';
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? `${system}\n${m.content}` : m.content;
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: temperature != null ? temperature : 0.7,
      maxOutputTokens: maxTokens || 2048
    }
  };
  if (system) {
    body.systemInstruction = { parts: [{ text: system }] };
  }

  const data = await safeFetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const content =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  return { content, raw: data };
}

const PROVIDERS = {
  openai: callOpenAI,
  anthropic: callAnthropic,
  gemini: callGemini,
  groq: callGroq,
  deepseek: callDeepSeek,
  custom: callCustom
};

/* --------------------------------------------------------------------- */
/*  Routes                                                                 */
/* --------------------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'muxmind-ai',
    time: new Date().toISOString(),
    providers: Object.keys(PROVIDERS)
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      provider,
      apiKey,
      model,
      messages,
      temperature,
      maxTokens,
      systemPrompt,
      baseUrl
    } = req.body || {};

    if (!provider || !PROVIDERS[provider]) {
      return sendError(
        res,
        400,
        `Unknown or missing provider. Supported: ${Object.keys(PROVIDERS).join(', ')}`
      );
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return sendError(res, 400, 'messages[] is required and must be non-empty');
    }

    // Prepend system prompt for OpenAI-style providers
    let finalMessages = messages;
    if (
      systemPrompt &&
      ['openai', 'groq', 'deepseek', 'custom'].includes(provider) &&
      !messages.some((m) => m.role === 'system')
    ) {
      finalMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    }

    const handler = PROVIDERS[provider];
    const result = await handler({
      apiKey,
      model,
      messages: finalMessages,
      temperature,
      maxTokens,
      systemPrompt,
      baseUrl
    });

    res.json({
      provider,
      model: model || null,
      content: result.content,
      requestId: req.requestId
    });
  } catch (err) {
    console.error('[chat error]', err.message);
    return sendError(res, err.status || 500, err.message, err.providerBody || null);
  }
});

/* --------------------------------------------------------------------- */
/*  Fallback + error handling                                             */
/* --------------------------------------------------------------------- */

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  sendError(res, 404, `Route not found: ${req.method} ${req.path}`);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err);
  sendError(res, 500, 'Internal server error', process.env.NODE_ENV === 'development' ? err.stack : null);
});

/* --------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`MuxMind AI server running on port ${PORT}`);
});