// ==============================
// CONFIG / DATA
// ==============================

const DIRECTORS = [
  {
    id: "rockefeller",
    name: "John D. Rockefeller",
    short: "Rockefeller",
    init: "JR",
    role: "Oil, Monopoly & Empire Building",
    bg: "#2a4a1a",
    fg: "#7fcc50",
    welcome: "Good. You've come to discuss business. I never waste time on pleasantries. State your challenge.",
    chips: [
      "How do I get my first paying client?",
      "How should I price my services?",
      "How do I build something lasting from nothing?"
    ],
    persona: `You are John D. Rockefeller — the world's first billionaire...`
  },

  {
    id: "drucker",
    name: "Peter Drucker",
    short: "Drucker",
    init: "PD",
    role: "Management, Strategy & Effectiveness",
    bg: "#0a0a1a",
    fg: "#8888ff",
    welcome: "The purpose of a business is to create a customer. So — who exactly is G-DESIGNS creating a customer for, and how?",
    chips: [
      "How do I manage myself as a solo founder?",
      "How do I focus on the right things?",
      "How do I build effective systems?"
    ],
    persona: `You are Peter Drucker — the father of modern management. You believe effectiveness is a discipline and management is about results. You are advising the founder of G-DESIGNS LTD — a digital agency in Buea, Cameroon. Respond in character, first person, precise and practical management advice, 2–4 paragraphs, no bullet points, no markdown headers.`
  }
];


// ==============================
// STATE MANAGEMENT
// ==============================

const state = {
  selectedAI: null,
  conversations: {}
};


// ==============================
// DOM HELPERS
// ==============================

const $ = (id) => document.getElementById(id);

function safeSetText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

function showError(message) {
  const errBar = $("errBar");
  if (!errBar) return;

  errBar.textContent = `⚠ ${message}`;
  errBar.classList.add("show");

  setTimeout(() => errBar.classList.remove("show"), 4000);
}


// ==============================
// UTILITIES
// ==============================

function timestamp() {
  return new Date().toISOString();
}

function validateInput(text) {
  return text && text.trim().length > 0;
}


// ==============================
// CHAT LOGIC
// ==============================

async function sendMessage(text) {
  if (!validateInput(text)) return;

  if (!state.selectedAI) {
    showError("Select a director first.");
    return;
  }

  const ai = state.selectedAI;

  addMessage("user", text);

  showTyping();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        persona: ai.persona,
        message: text
      })
    });

    if (!response.ok) {
      throw new Error("Failed to get response");
    }

    const data = await response.json();

    removeTyping();

    addMessage("ai", data.reply);

  } catch (err) {
    removeTyping();
    showError(err.message);
  }
}


// ==============================
// MESSAGE RENDERING
// ==============================

function addMessage(role, content) {
  const container = $("chat");

  if (!container) return;

  const msg = document.createElement("div");
  msg.className = `msg ${role}`;
  msg.textContent = content;

  container.appendChild(msg);

  container.scrollTop = container.scrollHeight;
}

function showTyping() {
  const container = $("chat");
  if (!container) return;

  const typing = document.createElement("div");
  typing.id = "typing";
  typing.className = "msg ai typing";
  typing.textContent = "Typing...";

  container.appendChild(typing);
}

function removeTyping() {
  const typing = $("typing");
  if (typing) typing.remove();
}


// ==============================
// DIRECTOR SELECTION
// ==============================

function selectDirector(id) {
  const director = DIRECTORS.find(d => d.id === id);

  if (!director) {
    showError("Director not found.");
    return;
  }

  state.selectedAI = director;

  safeSetText("directorName", director.name);
  safeSetText("directorRole", director.role);

  clearChat();
  addMessage("ai", director.welcome);
}

function clearChat() {
  const container = $("chat");
  if (container) container.innerHTML = "";
}


// ==============================
// EVENT LISTENERS
// ==============================

function init() {
  const input = $("textInput");
  const sendBtn = $("sendBtn");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      sendMessage(input.value);
      input.value = "";
    });
  }

  if (input) {
    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        sendMessage(input.value);
        input.value = "";
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
