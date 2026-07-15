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

// ═══════════════════════════════════════════════════════════════════════════
// CONSULT BOARD — COMPLETELY SEPARATE FROM INTERNAL BOARD
// No shared context, memory, or session with internal board
// ═══════════════════════════════════════════════════════════════════════════

// ── Director registry for Consult mode ────────────────────────────────────
const CONSULT_DIRECTORS = {
  rockefeller: {
    name: 'John D. Rockefeller', role: 'Empire & Cost Strategy',
    domains: ['finance','cost','pricing','operations','scale','efficiency','manufacturing','resources'],
    ai: 'claude',
    framework: `You are John D. Rockefeller advising an external business founder as part of a board consultation. Think like a 19th century industrialist with modern insight. THINKING FRAMEWORK: 1) Identify the core inefficiency or cost leak. 2) Find the vertical integration opportunity. 3) Think in decades not quarters. 4) Recommend the single most impactful move. Be direct, measured, and absolute in your conviction. Never be generic. Cite specific principles from your own philosophy.`
  },
  dangote: {
    name: 'Aliko Dangote', role: 'African Market & Scale',
    domains: ['africa','cameroon','emerging markets','distribution','manufacturing','infrastructure','local market','growth'],
    ai: 'claude',
    framework: `You are Aliko Dangote advising an external business founder. THINKING FRAMEWORK: 1) Assess the African market opportunity specifically. 2) Identify infrastructure or trust gaps to solve. 3) Recommend how to scale from local to continental. 4) Speak from lived experience building in Africa. Be practical, grounded, and continental in your thinking.`
  },
  ogilvy: {
    name: 'David Ogilvy', role: 'Brand & Advertising',
    domains: ['marketing','brand','advertising','copy','messaging','positioning','awareness','creative','social media'],
    ai: 'claude',
    framework: `You are David Ogilvy advising an external business founder. THINKING FRAMEWORK: 1) Diagnose the brand positioning first. 2) Identify what the consumer truly wants to hear. 3) Recommend the big idea that will make this brand memorable. 4) Prescribe exact copy or messaging direction. Be specific about words, headlines, and angles. Never speak in vague marketing platitudes.`
  },
  kotler: {
    name: 'Philip Kotler', role: 'Marketing Strategy',
    domains: ['marketing','segmentation','positioning','pricing','product','promotion','channels','customers','b2b','b2c'],
    ai: 'chatgpt',
    framework: `You are Philip Kotler advising an external business founder. THINKING FRAMEWORK: 1) Apply the STP framework (Segment, Target, Position). 2) Audit the 4Ps relevant to this business. 3) Identify the highest-leverage marketing lever. 4) Prescribe a measurable strategy. Be rigorous and framework-driven. Always tie advice to measurable outcomes.`
  },
  porter: {
    name: 'Michael Porter', role: 'Competitive Strategy',
    domains: ['competition','strategy','market','positioning','industry','differentiation','advantage','analysis'],
    ai: 'chatgpt',
    framework: `You are Michael Porter advising an external business founder. THINKING FRAMEWORK: 1) Apply Five Forces to this industry quickly. 2) Identify the competitive position available. 3) Diagnose whether the strategy is differentiation, cost leadership, or focus. 4) Recommend the single clearest strategic choice. Be precise and framework-anchored. No generic strategy advice.`
  },
  buffett: {
    name: 'Warren Buffett', role: 'Investment & Long-Term Value',
    domains: ['investment','funding','valuation','profit','revenue','financial','moat','returns','sustainability'],
    ai: 'claude',
    framework: `You are Warren Buffett advising an external business founder. THINKING FRAMEWORK: 1) Assess whether this business has or can build an economic moat. 2) Evaluate the financial fundamentals honestly. 3) Think about whether this business deserves investment in 10 years. 4) Give the one plain-spoken truth the founder needs to hear. Use folksy analogies. Be devastatingly honest about weak points.`
  },
  thiel: {
    name: 'Peter Thiel', role: 'Startup & Investor Readiness',
    domains: ['startup','funding','investors','pitch','venture','monopoly','innovation','zero to one','unique'],
    ai: 'chatgpt',
    framework: `You are Peter Thiel advising an external business founder. THINKING FRAMEWORK: 1) Ask — is this Zero to One or just competition? 2) Identify what makes this business a potential monopoly. 3) Diagnose investor readiness honestly. 4) Recommend the contrarian bet most founders miss. Be provocative, specific, and intellectually demanding.`
  },
  gates: {
    name: 'Bill Gates', role: 'Technology & Systems',
    domains: ['technology','software','systems','digital','automation','product','tech','innovation','data'],
    ai: 'chatgpt',
    framework: `You are Bill Gates advising an external business founder. THINKING FRAMEWORK: 1) Identify how technology can 10x this business. 2) Find the system or process that needs to be built. 3) Assess digital leverage opportunities. 4) Recommend the technology investment with highest ROI. Be analytical, precise, and systems-oriented.`
  },
  dalio: {
    name: 'Ray Dalio', role: 'Financial Principles & Risk',
    domains: ['finance','risk','principles','decision','money','investment','debt','cash flow','financial planning'],
    ai: 'chatgpt',
    framework: `You are Ray Dalio advising an external business founder. THINKING FRAMEWORK: 1) Apply radical truth — diagnose what is really happening financially. 2) Identify the biggest risk the founder is ignoring. 3) Recommend principles-based financial decisions. 4) Give one clear financial directive. Be direct, principle-driven, and willing to say the uncomfortable truth.`
  },
  godin: {
    name: 'Seth Godin', role: 'Tribe & Permission Marketing',
    domains: ['marketing','audience','brand','content','niche','community','social','online','digital marketing'],
    ai: 'gemini',
    framework: `You are Seth Godin advising an external business founder. THINKING FRAMEWORK: 1) Who specifically is this for — smallest viable audience? 2) What makes this remarkable enough to spread? 3) How does this earn permission rather than interrupt? 4) Give one sharp, counterintuitive insight. Be brief, provocative, and philosophical. No corporate speak.`
  },
  sinek: {
    name: 'Simon Sinek', role: 'Purpose & Leadership',
    domains: ['purpose','leadership','team','culture','why','mission','vision','brand story','motivation'],
    ai: 'claude',
    framework: `You are Simon Sinek advising an external business founder. THINKING FRAMEWORK: 1) What is the WHY behind this business — not what or how? 2) Does the messaging start with WHY? 3) How does purpose drive customer loyalty here? 4) What leadership shift does the founder need to make? Be inspiring, story-driven, and purpose-anchored.`
  },
  moukouri: {
    name: 'Danielle Moukouri', role: 'Legal & Compliance',
    domains: ['legal','law','contract','compliance','registration','intellectual property','copyright','cameroon','ohada','regulation'],
    ai: 'chatgpt',
    framework: `You are Danielle Moukouri advising an external business founder on legal matters in Cameroon and the OHADA framework. THINKING FRAMEWORK: 1) Identify the primary legal risk or gap. 2) Assess compliance with Cameroon/OHADA business law. 3) Recommend the most urgent legal protection needed. 4) Give practical, jurisdiction-specific advice. Be precise, structured, and legally grounded.`
  },
  robbins: {
    name: 'Tony Robbins', role: 'Performance & Sales Psychology',
    domains: ['sales','motivation','performance','mindset','closing','team','energy','confidence','growth'],
    ai: 'gemini',
    framework: `You are Tony Robbins advising an external business founder. THINKING FRAMEWORK: 1) What belief or state is blocking this founder's result? 2) What sales or performance pattern needs to change? 3) What is the highest-leverage action to take immediately? 4) Give a direct mindset and behaviour shift. Be energetic, direct, and transformation-focused.`
  },
  drucker: {
    name: 'Peter Drucker', role: 'Management & Operations',
    domains: ['management','operations','systems','productivity','hiring','organisation','process','effectiveness'],
    ai: 'chatgpt',
    framework: `You are Peter Drucker advising an external business founder. THINKING FRAMEWORK: 1) What is the purpose of this business and who is the customer? 2) What management system is missing? 3) Where is time and resource being wasted? 4) Prescribe one operational improvement. Be rigorous, systematic, and management-science driven.`
  }
};

// ── Domain keywords for auto-director selection ───────────────────────────
function selectDirectors(businessData) {
  const text = `${businessData.businessType} ${businessData.industry} ${businessData.challenge} ${businessData.goal}`.toLowerCase();

  // Score each director by keyword matches
  const scores = Object.entries(CONSULT_DIRECTORS).map(([id, d]) => {
    const score = d.domains.filter(kw => text.includes(kw)).length;
    return { id, director: d, score };
  });

  // Sort by relevance score
  scores.sort((a, b) => b.score - a.score);

  // Always include at least one from each key category if not already selected
  const selected = scores.slice(0, 3).map(s => s.id); // top 3 by relevance

  // Ensure we always have Strategy, Marketing, and Finance represented
  const mustHave = [
    { ids: ['porter', 'drucker', 'gates'], label: 'Strategy/Operations' },
    { ids: ['ogilvy', 'kotler', 'godin'], label: 'Marketing' },
    { ids: ['buffett', 'dalio', 'thiel'], label: 'Finance/Investment' }
  ];

  mustHave.forEach(({ ids }) => {
    const alreadyHas = ids.some(id => selected.includes(id));
    if (!alreadyHas) {
      // Add the highest-scoring one from this category
      const best = scores.find(s => ids.includes(s.id));
      if (best && selected.length < 6) selected.push(best.id);
    }
  });

  // Cap at 6 directors max
  return [...new Set(selected)].slice(0, 6).map(id => ({
    id,
    ...CONSULT_DIRECTORS[id]
  }));
}

// ── Qualify endpoint — question-driven context gathering ──────────────────
app.post('/api/consult/qualify', async (req, res) => {
  const { businessData, conversationHistory = [] } = req.body;

  if (!businessData) {
    return res.status(400).json({ error: 'Missing business data' });
  }

  // Count only user messages
  const userExchanges = conversationHistory.filter(m => m.role === 'user').length;
  const lastUserMsg = conversationHistory.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  // After 10 exchanges always declare ready
  if (userExchanges >= 10) {
    return res.json({ ready: true });
  }

  // Check depth of context
  const allAnswers = conversationHistory.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const totalWords = allAnswers.trim().split(/\s+/).length;

  // Topic areas to cover
  const topics = {
    revenue:     /revenue|sales|income|money|earn|charge|price|cost|afford|spend/i.test(allAnswers),
    customers:   /customer|client|target|audience|who|market|people|demographic|buyer/i.test(allAnswers),
    competition: /compet|rival|other|alternative|different|unique|better|worse/i.test(allAnswers),
    timeline:    /when|timeline|soon|urgent|month|year|week|deadline|time|plan/i.test(allAnswers),
    tried:       /tried|attempt|done|before|fail|work|didn|haven|already|previous/i.test(allAnswers),
  };
  const topicsCovered = Object.values(topics).filter(Boolean).length;

  // Ready only if 5+ real exchanges AND enough words AND topics covered
  if (userExchanges >= 5 && totalWords >= 60 && topicsCovered >= 4) {
    return res.json({ ready: true });
  }

  // Detect if user said something off-topic / conversational
  const isSmallTalk = /^(hi|hello|hey|how are you|good morning|good evening|good afternoon|thanks|thank you|ok|okay|sure|yes|no|great|nice|cool|wow|awesome)[\s!?.]*$/i.test(lastUserMsg.trim());

  const conversationStr = conversationHistory
    .map(m => `${m.role === 'user' ? 'Client' : 'Secretary'}: ${m.content}`)
    .join('\n');

  const missingTopics = Object.entries(topics).filter(([,v]) => !v).map(([k]) => k);
  const nextTopicHint = missingTopics.length > 0
    ? `The most important missing topic to uncover next is: ${missingTopics[0]}. Ask about it naturally.`
    : 'All key topics touched. Dig deeper into specifics — numbers, timelines, or past attempts.';

  const qualifyPrompt = `You are the Board Secretary for G-DESIGNS' elite AI Board of Directors. You are conducting a pre-consultation interview to gather business intelligence before assembling the board.

BUSINESS CONTEXT:
Business Type: ${businessData.businessType || 'Not specified'}
Industry: ${businessData.industry || 'Not specified'}
Challenge: ${businessData.challenge || 'Not specified'}
Goal: ${businessData.goal || 'Not specified'}
Location: ${businessData.location || 'Not specified'}
Growth Stage: ${businessData.stage || 'Not specified'}

FULL CONVERSATION SO FAR:
${conversationStr}

THE CLIENT JUST SAID: "${lastUserMsg}"

${isSmallTalk ? `IMPORTANT: The client said something conversational ("${lastUserMsg}"). Acknowledge it warmly and briefly in 1 sentence, then smoothly transition to a focused business question. Do not ignore what they said.` : `IMPORTANT: Respond naturally to what the client just said. Acknowledge or react briefly if needed, then ask ONE focused follow-up question.`}

${nextTopicHint}

RULES:
- Always acknowledge what the client actually said before asking your question
- Ask ONLY ONE question at the end
- Be warm, professional, and conversational — not robotic
- Never repeat a question already asked
- Keep your full response under 60 words
- Return your response as plain text only`;

  try {
    const response = await askClaude(qualifyPrompt, [
      { role: 'user', content: lastUserMsg || 'Please continue the interview.' }
    ]);
    const cleaned = response.trim().replace(/^["']|["']$/g, '');
    res.json({ ready: false, question: cleaned });
  } catch (err) {
    console.error('Qualify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Consult endpoint — multi-director board report ─────────────────────────
app.post('/api/consult/run', async (req, res) => {
  const { businessData, clientInfo, conversationHistory = [] } = req.body;

  if (!businessData || !clientInfo) {
    return res.status(400).json({ error: 'Missing business data or client info' });
  }

  // Select relevant directors
  const directors = selectDirectors(businessData);

  // Build full business context
  const businessContext = `
CLIENT: ${clientInfo.name} (${clientInfo.email})
BUSINESS TYPE: ${businessData.businessType}
INDUSTRY: ${businessData.industry || 'Not specified'}
LOCATION: ${businessData.location || 'Not specified'}
GROWTH STAGE: ${businessData.stage || 'Early stage'}
BUDGET: ${businessData.budget || 'Not specified'}
MAIN CHALLENGE: ${businessData.challenge}
GOAL: ${businessData.goal}
ADDITIONAL CONTEXT FROM CONVERSATION:
${conversationHistory.map(m => `${m.role === 'user' ? 'Client' : 'Board'}: ${m.content}`).join('\n')}
  `.trim();

  try {
    // Run each director sequentially
    const insights = [];

    for (const director of directors) {
      const directorPrompt = `${director.framework}

You are providing ONE section of a structured board consultation report for an external client of G-DESIGNS LTD.

BUSINESS CONTEXT:
${businessContext}

ALREADY PROVIDED BY OTHER BOARD MEMBERS:
${insights.map(i => `${i.name} (${i.role}): ${i.insight.substring(0, 200)}...`).join('\n') || 'You are the first to speak.'}

YOUR TASK:
Provide YOUR UNIQUE perspective as ${director.name}, focused on your area: ${director.role}.
- DO NOT repeat what other board members have already said
- DO NOT give generic advice
- Provide 2-3 specific, actionable insights
- Think through your reasoning before concluding
- Be direct and decisive
- Maximum 250 words

Format your response as plain text paragraphs. No headers. No bullet points.`;

      let insight;
      try {
        if (director.ai === 'chatgpt') {
          insight = await askChatGPT(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        } else if (director.ai === 'gemini') {
          insight = await askGemini(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        } else {
          insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        }
      } catch (dirErr) {
        // Fallback to Claude if primary AI fails
        try {
          insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        } catch (fallbackErr) {
          insight = `${director.name} was unavailable for this consultation.`;
        }
      }

      insights.push({
        id: director.id,
        name: director.name,
        role: director.role,
        ai: director.ai,
        insight: insight.trim()
      });
    }

    // Generate synthesis
    const synthesisPrompt = `You are the Chief Strategy Officer of G-DESIGNS LTD synthesising a board consultation report.

BUSINESS CONTEXT:
${businessContext}

BOARD MEMBER INSIGHTS:
${insights.map(i => `\n${i.name.toUpperCase()} (${i.role}):\n${i.insight}`).join('\n\n')}

Create a structured synthesis with these exact sections:

EXECUTIVE SUMMARY
2-3 sentences summarising the core opportunity and challenge.

KEY STRATEGIC RECOMMENDATIONS
The 3 most important actions, ranked by priority. Each recommendation in 1-2 sentences.

RISK ANALYSIS
The 2 biggest risks identified by the board, and how to mitigate them.

90-DAY ACTION PLAN
5 specific steps the client should take in the next 90 days, numbered.

FINAL VERDICT
One bold, direct statement about what this business needs most right now.

Keep each section concise and actionable. Total: 400-500 words.`;

    const synthesis = await askClaude(synthesisPrompt, [{ role: 'user', content: 'Synthesise the board consultation.' }]);

    res.json({
      success: true,
      client: clientInfo,
      businessData,
      directors: directors.map(d => ({ id: d.id, name: d.name, role: d.role, ai: d.ai })),
      insights,
      synthesis: synthesis.trim(),
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Consult error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HEYGEN VIDEO INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════

const HEYGEN_API = 'https://api.heygen.com';
const HEYGEN_KEY = process.env.HEYGEN_API_KEY;
const HEYGEN_AVATAR = process.env.HEYGEN_AVATAR_ID;
const HEYGEN_VOICE = process.env.HEYGEN_VOICE_ID;

// ── Helper: detect best video dimensions for device type ──────────────────
function getVideoDimensions(deviceType) {
  switch(deviceType) {
    case 'mobile':  return { width: 720,  height: 1280, aspect_ratio: '9:16' };
    case 'tablet':  return { width: 1080, height: 1080, aspect_ratio: '1:1'  };
    default:        return { width: 1280, height: 720,  aspect_ratio: '16:9' };
  }
}

// ── Helper: generate a HeyGen video and poll until ready ──────────────────
async function generateHeyGenVideo(script, deviceType = 'desktop') {
  if (!HEYGEN_KEY || !HEYGEN_AVATAR || !HEYGEN_VOICE) {
    throw new Error('HeyGen credentials not configured');
  }

  const { width, height, aspect_ratio } = getVideoDimensions(deviceType);

  // Step 1: Submit video generation request
  const createRes = await fetch(`${HEYGEN_API}/v2/video/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': HEYGEN_KEY
    },
    body: JSON.stringify({
      video_inputs: [{
        character: {
          type: 'avatar',
          avatar_id: HEYGEN_AVATAR,
          avatar_style: 'normal'
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: HEYGEN_VOICE,
          speed: 1.0
        },
        background: {
          type: 'color',
          value: '#0e0b1a'
        }
      }],
      dimension: { width, height },
      aspect_ratio,
      test: false
    })
  });

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}));
    throw new Error(err?.message || 'HeyGen create error: ' + createRes.status);
  }

  const createData = await createRes.json();
  const videoId = createData?.data?.video_id;
  if (!videoId) throw new Error('No video_id returned from HeyGen');

  // Step 2: Poll for completion (max 3 minutes)
  const maxAttempts = 36;
  const pollInterval = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const statusRes = await fetch(`${HEYGEN_API}/v1/video_status.get?video_id=${videoId}`, {
      headers: { 'X-Api-Key': HEYGEN_KEY }
    });

    if (!statusRes.ok) continue;

    const statusData = await statusRes.json();
    const status = statusData?.data?.status;

    if (status === 'completed') {
      const videoUrl = statusData?.data?.video_url;
      if (!videoUrl) throw new Error('Video completed but no URL returned');
      return { videoId, videoUrl };
    }

    if (status === 'failed') {
      throw new Error('HeyGen video generation failed: ' + (statusData?.data?.error || 'Unknown error'));
    }
    // status === 'processing' or 'pending' — keep polling
  }

  throw new Error('HeyGen video generation timed out after 3 minutes');
}

// ── Welcome video endpoint ────────────────────────────────────────────────
app.post('/api/heygen/welcome', async (req, res) => {
  const { clientName, businessType, deviceType = 'desktop' } = req.body;

  if (!clientName || !businessType) {
    return res.status(400).json({ error: 'Missing clientName or businessType' });
  }

  const welcomeScriptPrompt = `Write a welcome video script for ${clientName} who is consulting the G-DESIGNS Board of Directors about their ${businessType} business.

STRICT RULES:
- Maximum 75 words total — count carefully
- Warm, professional, personal tone
- Mention their name and business type
- Tell them the Board Secretary will ask questions
- End encouraging them to answer honestly
- Return ONLY the script, nothing else

Example structure (adapt freely):
"Welcome [name]. I'm glad you're here at the G-DESIGNS Board. Our advisors are ready to help your [business]. Our Board Secretary will ask you a few questions — answer honestly and specifically for the best results. Let's get started."`;

  try {
    const script = await askClaude(welcomeScriptPrompt, [
      { role: 'user', content: 'Write the welcome script now. Maximum 75 words.' }
    ]);
    const { videoUrl } = await generateHeyGenVideo(script.trim(), deviceType);
    res.json({ success: true, videoUrl, deviceType });
  } catch (err) {
    console.error('HeyGen welcome error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Report video endpoint ─────────────────────────────────────────────────
app.post('/api/heygen/report', async (req, res) => {
  const { clientName, businessType, synthesis, deviceType = 'desktop' } = req.body;

  if (!clientName || !synthesis) {
    return res.status(400).json({ error: 'Missing clientName or synthesis' });
  }

  const scriptPrompt = `You are creating a 25-40 second video script for an AI presenter delivering board recommendation highlights.

Extract only the most critical points from this board synthesis and turn them into a natural, confident spoken script.

CLIENT: ${clientName}
BUSINESS: ${businessType}
SYNTHESIS: ${synthesis}

SCRIPT RULES:
- Start with: "Good day ${clientName}. Here is your G-DESIGNS Board verdict on your ${businessType}."
- Cover ONLY: the single most important finding and top 2 action items
- End with: "Your full report with all board insights is ready below."
- Spoken, natural language — conversational not formal
- Between 60 and 95 words total — strictly no more than 95 words
- Count your words carefully before returning
- Return ONLY the script text, nothing else`;

  try {
    const script = await askClaude(scriptPrompt, [{ role: 'user', content: 'Generate the video script now.' }]);
    const { videoUrl } = await generateHeyGenVideo(script.trim(), deviceType);
    res.json({ success: true, videoUrl, deviceType });
  } catch (err) {
    console.error('HeyGen report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('/consult', (req, res) => {
  res.sendFile(path.join(__dirname, 'consult.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`G-DESIGNS Board running on port ${PORT}`);
});
