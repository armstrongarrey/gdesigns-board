const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Password auth ─────────────────────────────────────────────────────────
const BOARD_PASSWORD = process.env.BOARD_PASSWORD || 'gdesigns2026';
app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password === BOARD_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Incorrect password' });
  }
});

// ── Claude (Anthropic) ────────────────────────────────────────────────────
async function askClaude(persona, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Anthropic API key not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: persona,
      messages
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Claude API error ' + response.status);
  }

  const data = await response.json();
  const reply = data.content?.find(b => b.type === 'text')?.text;
  if (!reply) throw new Error('No reply from Claude');
  return reply;
}

// ── ChatGPT (OpenAI) ──────────────────────────────────────────────────────
async function askChatGPT(persona, messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured on server');

  // Convert messages format — OpenAI uses system differently
  const openaiMessages = [
    { role: 'system', content: persona },
    ...messages
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1024,
      messages: openaiMessages
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'OpenAI API error ' + response.status);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) throw new Error('No reply from ChatGPT');
  return reply;
}

// ── Gemini (Google) ───────────────────────────────────────────────────────
async function askGemini(persona, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured on server');

  // Build Gemini contents format
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: persona }] },
        contents,
        generationConfig: { maxOutputTokens: 1024 }
      })
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Gemini API error ' + response.status);
  }

  const data = await response.json();
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!reply) throw new Error('No reply from Gemini');
  return reply;
}

// ── Main chat endpoint ────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { persona, messages, ai } = req.body;

  if (!persona || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing persona or messages' });
  }

  try {
    let reply;
    const model = ai || 'claude';

    if (model === 'chatgpt') {
      reply = await askChatGPT(persona, messages);
    } else if (model === 'gemini') {
      reply = await askGemini(persona, messages);
    } else {
      reply = await askClaude(persona, messages);
    }

    res.json({ reply, ai: model });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`G-DESIGNS Board running on port ${PORT}`);
});
