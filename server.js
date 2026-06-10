const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Chat API endpoint ─────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { persona, messages } = req.body;

  if (!persona || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing persona or messages' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  try {
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
        messages: messages
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: errData?.error?.message || 'Anthropic API error'
      });
    }

    const data = await response.json();
    const reply = data.content?.find(b => b.type === 'text')?.text;

    if (!reply) {
      return res.status(500).json({ error: 'No reply from AI' });
    }

    res.json({ reply });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'Failed to reach AI service: ' + err.message });
  }
});

// ── Serve index.html for all other routes (SPA) ───────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`G-DESIGNS Board running on port ${PORT}`);
});
