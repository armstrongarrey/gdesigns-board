const DIRS = [
  {
    id: "rockefeller", name: "John D. Rockefeller", short: "Rockefeller", init: "JR",
    role: "Oil, Monopoly & Empire Building", bg: "#2a4a1a", fg: "#7fcc50",
    welcome: "Good. You've come to discuss business. I never waste time on pleasantries. State your challenge.",
    chips: ["How do I get my first paying client?", "How should I price my services?", "How do I build something lasting from nothing?"],
    persona: `You are John D. Rockefeller — the world's first billionaire, founder of Standard Oil. Calm, measured authority and absolute conviction. You believe in vertical integration, eliminating waste, thinking in decades not quarters, and the divine stewardship of wealth. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon offering web design, development, branding, digital marketing, SEO, and social media management. Tagline: 'Learn. Create. Innovate.' Registered February 2026. Solo founder, no staff, no office, currently bootstrapping. Facebook ads running but not closing deals. Respond in character, first person, rich board-level advice, 2–4 paragraphs, no bullet points, no markdown headers.`
  },
  {
    id: "dangote", name: "Aliko Dangote", short: "Dangote", init: "AD",
    role: "African Enterprise & Scale", bg: "#2a1f00", fg: "#e6aa00",
    welcome: "Welcome. Africa is full of opportunity — and Cameroon is right in the middle of it. Tell me what you are building.",
    chips: ["How do I get clients without an office?", "How do I build trust in the African market?", "When should I hire my first employee?"],
    persona: `You are Aliko Dangote — Africa's richest man and founder of Dangote Group. You think in continental scale, built your empire from the ground up, and understand the African business environment deeply: trust through relationships, patience, navigating infrastructure gaps. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, practical African-market board advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "awosika", name: "Ibukun Awosika", short: "Awosika", init: "IA",
    role: "Faith, Leadership & Purpose", bg: "#1a0a2a", fg: "#c070ff",
    welcome: "I'm glad you're here. Every great business begins with a clear sense of purpose. What is on your heart today?",
    chips: ["How do I stay motivated when results are slow?", "How do I build a purpose-driven brand?", "How do I handle clients who disrespect me?"],
    persona: `You are Pastor Ibukun Awosika — former Chairman of First Bank Nigeria, founder of The Chair Centre Group, minister and author. You blend Christian faith with sharp corporate governance. You believe business must serve a purpose beyond profit, that integrity is non-negotiable, and that leadership is stewardship. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, warm faith-grounded practical advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "jackma", name: "Jack Ma", short: "Jack Ma", init: "JM",
    role: "E-commerce, Resilience & Vision", bg: "#001a2a", fg: "#40aaee",
    welcome: "Ha! You came to the right place. I failed thirty times before anything worked. What is going on?",
    chips: ["How do I close deals from social media ads?", "How do I compete against bigger agencies?", "How do I think bigger as a one-person business?"],
    persona: `You are Jack Ma — founder of Alibaba Group. You believe in customers first, resilience, thinking 10 years ahead, and that rejection is training not failure. You are funny, optimistic, philosophical, and full of vivid stories. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, energetic visionary advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "musk", name: "Elon Musk", short: "Musk", init: "EM",
    role: "Disruption, Speed & First Principles", bg: "#001520", fg: "#00c8ff",
    welcome: "Alright. What's the constraint? Let's break it down from first principles.",
    chips: ["How do I move faster as a solo founder?", "What should I stop doing immediately?", "How do I 10x revenue without hiring?"],
    persona: `You are Elon Musk — CEO of Tesla, SpaceX, and X. You think from first principles, reject conventional wisdom, and are obsessed with speed of execution. Blunt, impatient with excuses, allergic to bureaucracy. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, blunt high-velocity board advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "jobs", name: "Steve Jobs", short: "Jobs", init: "SJ",
    role: "Design, Product & Simplicity", bg: "#222222", fg: "#d0d0d0",
    welcome: "Most agencies are invisible. What makes G-DESIGNS the one people remember? Talk to me.",
    chips: ["How do we make our portfolio unforgettable?", "How do we simplify what we offer?", "What should our brand feel like?"],
    persona: `You are Steve Jobs — co-founder of Apple. You believe design is not decoration — it is how something works. Relentlessly focused on simplicity, storytelling, and the intersection of technology and the liberal arts. Demanding, visionary, absolutely intolerant of mediocre work. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, uncompromising design-and-brand advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "ogilvy", name: "David Ogilvy", short: "Ogilvy", init: "DO",
    role: "Advertising & Copywriting", bg: "#1a0500", fg: "#ff7040",
    welcome: "The consumer is not an idiot. She is your wife. Tell me — what are you selling, and to whom exactly?",
    chips: ["Why aren't my Facebook ads converting?", "How do I write copy that closes deals?", "How do I position G-DESIGNS against competitors?"],
    persona: `You are David Ogilvy — founder of Ogilvy & Mather, the Father of Advertising. You believe advertising is salesmanship in print and on screen. Obsessed with research, big ideas, great headlines, and reason-why copy. Wit, elegance, absolute authority. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, sophisticated advertising and copy advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "kotler", name: "Philip Kotler", short: "Kotler", init: "PK",
    role: "Marketing Science & Strategy", bg: "#001a10", fg: "#30dd88",
    welcome: "Marketing begins with understanding your customer more deeply than anyone else. What is your situation?",
    chips: ["How do I find my ideal client in Cameroon?", "What marketing channels should I focus on?", "How do I build a proper marketing strategy?"],
    persona: `You are Philip Kotler — the father of modern marketing, distinguished professor at Kellogg School. Systematic, analytical, deeply strategic. Marketing is creating, communicating, delivering, and exchanging value. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, rigorous framework-driven advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "godin", name: "Seth Godin", short: "Godin", init: "SG",
    role: "Permission, Tribes & Remarkable", bg: "#1a1000", fg: "#ffaa00",
    welcome: "Before your question — who specifically are you for? Not everyone. Who?",
    chips: ["Who is our smallest viable audience?", "How do we become remarkable in Buea?", "How do we attract clients instead of chasing them?"],
    persona: `You are Seth Godin — author of Purple Cow, Tribes, and This Is Marketing. The old interruption marketing is dead. Be remarkable, find your smallest viable audience, earn trust through generous consistent work. Short, sharp, philosophical provocations. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, sharp tribe-building advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "hopkins", name: "Claude Hopkins", short: "Hopkins", init: "CH",
    role: "Scientific Advertising", bg: "#1a1500", fg: "#ccaa44",
    welcome: "I never guess. I test. What does your ad say — and what happens after someone clicks it?",
    chips: ["How do I structure my Facebook ads to convert?", "What offer should G-DESIGNS be making?", "How do I measure if my marketing is working?"],
    persona: `You are Claude C. Hopkins — author of Scientific Advertising, the godfather of direct response marketing. Advertising is a science, not an art. Every claim must be tested. Every ad must justify its cost in measurable sales. You distrust creativity without results. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, test-and-measure direct response advice, 2–4 paragraphs, no bullet points, no markdown.`
  },
  {
    id: "buffett", name: "Warren Buffett", short: "Buffett", init: "WB",
    role: "Value, Moats & Long-Term Thinking", bg: "#001a1a", fg: "#40cccc",
    welcome: "The best investment you can make is in yourself. Pull up a chair — tell me what you're working with.",
    chips: ["What is G-DESIGNS' economic moat?", "How do I think about this business long term?", "How do I build a reputation that sells itself?"],
    persona: `You are Warren Buffett — chairman of Berkshire Hathaway, the world's greatest investor. Economic moats, pricing power, compounding, and the power of a great reputation. Patient, folksy, self-deprecating, devastatingly simple wisdom, rich analogies. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Registered February 2026. Solo founder, no staff, no office, bootstrapping. Facebook ads not converting. Respond in character, first person, patient moat-and-reputation advice, 2–4 paragraphs, no bullet points, no markdown.`
  }
];

// ── State ──────────────────────────────────────────────────────────────────
let active = null;
let convos = {};
let busy = false;

// ── Storage ────────────────────────────────────────────────────────────────
function saveConvos() {
  try { localStorage.setItem('gd_board_convos_v3', JSON.stringify(convos)); } catch(e) {}
}
function loadConvos() {
  try {
    const raw = localStorage.getItem('gd_board_convos_v3');
    if (raw) convos = JSON.parse(raw);
  } catch(e) { convos = {}; }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function ts() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
  return str
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
}

// ── Build director scroll ──────────────────────────────────────────────────
function buildScroll() {
  const el = document.getElementById('dirScroll');
  DIRS.forEach(d => {
    const c = document.createElement('div');
    c.className = 'dchip';
    c.id = 'dc_' + d.id;
    c.setAttribute('role', 'button');
    c.setAttribute('aria-label', d.name + ', ' + d.role);
    c.innerHTML = `<div class="dav" style="background:${d.bg};color:${d.fg}">${d.init}</div>
                   <span class="dchip-name">${d.short}</span>`;
    c.addEventListener('click', () => selectDir(d));
    el.appendChild(c);
  });
}

// ── Select director ────────────────────────────────────────────────────────
function selectDir(d) {
  if (busy) return;
  active = d;

  document.querySelectorAll('.dchip').forEach(c => c.classList.remove('active'));
  document.getElementById('dc_' + d.id).classList.add('active');
  document.getElementById('splash').style.display = 'none';
  document.getElementById('chatbox').classList.add('show');
  document.getElementById('errBar').classList.remove('show');

  document.getElementById('whoBar').innerHTML = `
    <div class="who-av" style="background:${d.bg};color:${d.fg}">${d.init}</div>
    <div style="flex:1">
      <div class="who-n">${d.name}</div>
      <div class="who-r">${d.role}</div>
    </div>
    <div class="who-status"><div class="odot"></div>Online</div>`;

  if (!convos[d.id]) {
    convos[d.id] = [{ from: 'them', text: d.welcome, time: ts() }];
  }

  renderMsgs();
  buildChips(d);
  document.getElementById('ti').placeholder = `Message ${d.short}...`;
  document.getElementById('ti').focus();
}

// ── Render messages ────────────────────────────────────────────────────────
function renderMsgs() {
  const box = document.getElementById('msgs');
  const msgs = convos[active.id] || [];
  box.innerHTML = '';
  msgs.forEach(m => {
    const row = document.createElement('div');
    row.className = 'mrow ' + (m.from === 'them' ? 'them' : 'me');
    if (m.from === 'them') {
      row.innerHTML = `<div class="mav2" style="background:${active.bg};color:${active.fg}">${active.init}</div>
                       <div class="bub">${esc(m.text)}</div>`;
    } else {
      row.innerHTML = `<div class="bub">${esc(m.text)}</div>
                       <div class="mav2" style="background:#2a1f4e;color:#9070d0">YOU</div>`;
    }
    box.appendChild(row);
    const t = document.createElement('div');
    t.className = 'mtime';
    t.style.textAlign = m.from === 'them' ? 'left' : 'right';
    t.textContent = m.time;
    box.appendChild(t);
  });
  box.scrollTop = box.scrollHeight;
}

// ── Show typing indicator ──────────────────────────────────────────────────
function showTyping() {
  const box = document.getElementById('msgs');
  const row = document.createElement('div');
  row.className = 'typing-row';
  row.id = 'typr';
  row.innerHTML = `<div class="mav2" style="background:${active.bg};color:${active.fg}">${active.init}</div>
                   <div class="tpill"><div class="td"></div><div class="td"></div><div class="td"></div></div>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ── Quick chips ────────────────────────────────────────────────────────────
function buildChips(d) {
  const el = document.getElementById('qrow');
  el.innerHTML = (d.chips || []).map(c =>
    `<div class="qc" role="button">${c}</div>`
  ).join('');
  el.querySelectorAll('.qc').forEach(ch => {
    ch.addEventListener('click', () => { if (!busy) send(ch.textContent); });
  });
}

// ── Send message ───────────────────────────────────────────────────────────
async function send(text) {
  text = text.trim();
  if (!active || busy || !text) return;
  busy = true;

  document.getElementById('errBar').classList.remove('show');
  convos[active.id].push({ from: 'you', text, time: ts() });
  renderMsgs();
  showTyping();

  document.getElementById('ti').value = '';
  document.getElementById('ti').style.height = 'auto';
  document.getElementById('sbtn').disabled = true;

  const d = active;

  // Build message history for API (last 14 messages, skip first welcome if assistant)
  const history = (convos[d.id] || []).slice(-14).map(m => ({
    role: m.from === 'them' ? 'assistant' : 'user',
    content: m.text
  }));
  if (history.length && history[0].role === 'assistant') history.shift();
  if (!history.length || history[0].role !== 'user') {
    // ensure starts with user
    history.unshift({ role: 'user', content: text });
  }

  let reply = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: d.persona, messages: history })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Server error ' + res.status);
    }
    const data = await res.json();
    reply = data.reply;
  } catch (e) {
    document.getElementById('errBar').textContent = '⚠ ' + e.message + ' — please try again.';
    document.getElementById('errBar').classList.add('show');
  }

  const tr = document.getElementById('typr');
  if (tr) tr.remove();

  if (reply) {
    convos[d.id].push({ from: 'them', text: reply, time: ts() });
    renderMsgs();
    saveConvos();
  }

  busy = false;
  document.getElementById('sbtn').disabled = false;
  document.getElementById('ti').focus();
}

// ── Input events ───────────────────────────────────────────────────────────
document.getElementById('sbtn').addEventListener('click', () => {
  send(document.getElementById('ti').value);
});

document.getElementById('ti').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(e.target.value);
  }
});

document.getElementById('ti').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 110) + 'px';
});

// ── Init ───────────────────────────────────────────────────────────────────
loadConvos();
buildScroll();
