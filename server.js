const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const dns = require('dns').promises;
const PDFDocument = require('pdfkit');
const { Document: DocxDocument, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ImageRun } = require('docx');
// nodemailer removed — Render blocks outbound SMTP; using Resend HTTP API instead
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();

// ── CRASH PREVENTION — one bad request must never take down the whole service ──
// Without these, a single malformed request (e.g. a synchronous throw inside
// an async route handler, before its own try/catch takes effect) becomes an
// unhandled promise rejection that kills the entire Node process — dropping
// every in-flight request from every concurrent user, not just the one that
// triggered it. This is exactly what happened with the board-match crash.
// Logging and continuing is far safer than a full crash-and-restart cycle for
// a bug that's scoped to a single request.
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection (server stayed up):', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server stayed up):', err?.stack || err);
});

// ── DOMAIN REDIRECT: board.gdesignsme.com → consult.gdesignsme.com ─────────
// Runs first, before any other middleware, to redirect old domain visitors
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host === 'board.gdesignsme.com') {
    return res.redirect(301, `https://consult.gdesignsme.com${req.originalUrl}`);
  }
  next();
});

// ── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(session({
  secret: process.env.JWT_SECRET || 'arreyon-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ───────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── CONSTANTS ──────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'arreyon-jwt-secret-2026';

// ── Credential encryption (Phase 8 / Website Intelligence) ─────────────────
// A WordPress Application Password is a long-lived, static credential —
// closer to a raw API key than the short-lived, provider-revocable OAuth
// tokens used for Google/HubSpot/Zoho — so it's genuinely encrypted at
// rest here (AES-256-GCM, authenticated so tampering is detected, not
// just confidentiality), rather than relying on database access control
// alone. CREDENTIAL_ENCRYPTION_KEY must be set in production; the
// fallback below is for local development only.
const CREDENTIAL_ENCRYPTION_KEY = crypto.scryptSync(
  process.env.CREDENTIAL_ENCRYPTION_KEY || 'dev-only-fallback-key-set-CREDENTIAL_ENCRYPTION_KEY-in-production',
  'arreyon-credential-salt', 32
);
function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CREDENTIAL_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}
function decryptSecret(encoded) {
  const data = Buffer.from(encoded, 'base64');
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', CREDENTIAL_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
const GMAIL_USER = 'gdesignsme@gmail.com';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@gdesignsme.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';
const BASE_URL = process.env.BASE_URL || 'https://consult.gdesignsme.com';

const PLAN_LIMITS = {
  starter:  { consultations: 3,  directors: 5,   download: false, video: false, history: false, team: 1 },
  pro:      { consultations: 10, directors: 29,  download: true,  video: false, history: true,  team: 2 },
  business: { consultations: -1, directors: 29,  download: true,  video: true,  history: true,  team: 5 },
  expired:  { consultations: 0,  directors: 0,   download: false, video: false, history: false, team: 0 }
};

// Financial Tools: which calculators each plan can access. Starter gets the
// three most fundamental ones; Pro and Business get the full engine.
const FINANCIAL_TOOLS_ACCESS = {
  starter:  ['roi', 'breakeven', 'growth_projection'],
  pro:      ['revenue', 'profit_margin', 'breakeven', 'roi', 'cac', 'ltv', 'ltv_cac_ratio', 'roas', 'growth_projection', 'cashflow_projection', 'pricing', 'markup', 'runway', 'budget_variance', 'valuation', 'loan_payment', 'cost_of_hire', 'discount_impact'],
  business: ['revenue', 'profit_margin', 'breakeven', 'roi', 'cac', 'ltv', 'ltv_cac_ratio', 'roas', 'growth_projection', 'cashflow_projection', 'pricing', 'markup', 'runway', 'budget_variance', 'valuation', 'loan_payment', 'cost_of_hire', 'discount_impact'],
  expired:  []
};

const STARTER_DIRECTORS = ['rockefeller', 'ogilvy', 'buffett', 'dangote', 'kotler'];

// ── EMAIL (via Resend HTTP API — Render blocks outbound SMTP ports) ────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Arreyon Consult <onboarding@resend.dev>';

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.error('Email error: RESEND_API_KEY not configured');
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Email error:', res.status, err?.message || JSON.stringify(err));
      return;
    }
    console.log('Email sent successfully to:', to);
  } catch(e) {
    console.error('Email error:', e.message);
  }
}

// ── Bilingual transactional email templates ─────────────────────────────────
// Static, hand-written EN/FR pairs rather than AI translation — these are
// short, fixed-structure emails where a translated template reviewed once is
// more reliable and much cheaper than an AI call on every send.
const EMAIL_TEMPLATES = {
  verify: {
    en: (p) => ({
      subject: 'Verify your Arreyon Consult account',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Welcome to Arreyon Consult, ${p.firstName}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <a href="${p.verifyUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
        <p style="color:#666;font-size:12px;margin-top:20px">This link expires in 24 hours. If you did not create this account, ignore this email.</p>
        <hr>
        <p style="color:#999;font-size:11px">Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com</p>
      </div>`
    }),
    fr: (p) => ({
      subject: 'Vérifiez votre compte Arreyon Consult',
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Bienvenue sur Arreyon Consult, ${p.firstName} !</h2>
        <p>Veuillez vérifier votre adresse e-mail pour activer votre compte.</p>
        <a href="${p.verifyUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Vérifier l'e-mail</a>
        <p style="color:#666;font-size:12px;margin-top:20px">Ce lien expire dans 24 heures. Si vous n'êtes pas à l'origine de ce compte, ignorez cet e-mail.</p>
        <hr>
        <p style="color:#999;font-size:11px">Arreyon Consult par G-DESIGNS LTD · consult.gdesignsme.com</p>
      </div>`
    })
  },
  resendVerify: {
    en: (p) => ({
      subject: 'Verify your Arreyon Consult account',
      html: `<p>Click <a href="${p.verifyUrl}">here</a> to verify your email. Link expires in 24 hours.</p>`
    }),
    fr: (p) => ({
      subject: 'Vérifiez votre compte Arreyon Consult',
      html: `<p>Cliquez <a href="${p.verifyUrl}">ici</a> pour vérifier votre e-mail. Le lien expire dans 24 heures.</p>`
    })
  },
  resetPassword: {
    en: (p) => ({
      subject: 'Reset your Arreyon Consult password',
      html: `<p>Click <a href="${p.resetUrl}">here</a> to reset your password. Link expires in 1 hour.</p>`
    }),
    fr: (p) => ({
      subject: 'Réinitialisez votre mot de passe Arreyon Consult',
      html: `<p>Cliquez <a href="${p.resetUrl}">ici</a> pour réinitialiser votre mot de passe. Le lien expire dans 1 heure.</p>`
    })
  },
  planActive: {
    en: (p) => ({
      subject: 'Your Arreyon Consult plan is now active!',
      html: `<p>Hi ${p.firstName},</p>
        <p>Your <strong>${p.plan}</strong> plan has been activated. Welcome to the board.</p>
        <p><a href="${p.dashboardUrl}">Go to your dashboard</a></p>`
    }),
    fr: (p) => ({
      subject: 'Votre forfait Arreyon Consult est maintenant actif !',
      html: `<p>Bonjour ${p.firstName},</p>
        <p>Votre forfait <strong>${p.plan}</strong> a été activé. Bienvenue au conseil.</p>
        <p><a href="${p.dashboardUrl}">Accéder à votre tableau de bord</a></p>`
    })
  },
  teamInvite: {
    en: (p) => ({
      subject: `${p.ownerName} invited you to join their Arreyon Consult team`,
      html: `<p>${p.ownerName} has invited you to join their team on Arreyon Consult.</p>
       <p><a href="${p.inviteUrl}" style="background:#6C3BFF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Accept Invitation</a></p>
       <p>Or copy this link: ${p.inviteUrl}</p>
       <p style="color:#888;font-size:13px">This invitation expires in 7 days.</p>`
    }),
    fr: (p) => ({
      subject: `${p.ownerName} vous a invité à rejoindre son équipe Arreyon Consult`,
      html: `<p>${p.ownerName} vous a invité à rejoindre son équipe sur Arreyon Consult.</p>
       <p><a href="${p.inviteUrl}" style="background:#6C3BFF;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Accepter l'invitation</a></p>
       <p>Ou copiez ce lien : ${p.inviteUrl}</p>
       <p style="color:#888;font-size:13px">Cette invitation expire dans 7 jours.</p>`
    })
  },
  monitoringDigest: {
    en: (p) => ({
      subject: `${p.alertCount} new alert${p.alertCount > 1 ? 's' : ''} on Arreyon Consult`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Here's what changed</h2>
        <p>We spotted ${p.alertCount} thing${p.alertCount > 1 ? 's' : ''} worth your attention:</p>
        ${p.alertsHtml}
        <a href="${p.dashboardUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px">View in Dashboard</a>
        <hr style="margin-top:24px">
        <p style="color:#999;font-size:11px">Arreyon Consult by G-DESIGNS LTD · You can turn off any of these alert types from your dashboard settings.</p>
      </div>`
    }),
    fr: (p) => ({
      subject: `${p.alertCount} nouvelle${p.alertCount > 1 ? 's' : ''} alerte${p.alertCount > 1 ? 's' : ''} sur Arreyon Consult`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Voici ce qui a changé</h2>
        <p>Nous avons repéré ${p.alertCount} élément${p.alertCount > 1 ? 's' : ''} qui méritent votre attention :</p>
        ${p.alertsHtml}
        <a href="${p.dashboardUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:12px">Voir dans le tableau de bord</a>
        <hr style="margin-top:24px">
        <p style="color:#999;font-size:11px">Arreyon Consult par G-DESIGNS LTD · Vous pouvez désactiver n'importe quel type d'alerte depuis les paramètres de votre tableau de bord.</p>
      </div>`
    })
  },
  taskAssigned: {
    en: (p) => ({
      subject: `You've been assigned a task on Arreyon Consult`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>New task assigned to you</h2>
        <p><strong>${escapeHtmlEmail(p.assignerName)}</strong> assigned you a task on <strong>${escapeHtmlEmail(p.businessName)}</strong>:</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:14px 16px;margin:14px 0">
          <div style="font-weight:600">${escapeHtmlEmail(p.taskTitle)}</div>
          ${p.taskDescription ? `<div style="margin-top:8px;color:#555;white-space:pre-wrap">${escapeHtmlEmail(p.taskDescription)}</div>` : ''}
        </div>
        <a href="${p.dashboardUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">View in Action Center</a>
        <hr style="margin-top:24px">
        <p style="color:#999;font-size:11px">Arreyon Consult by G-DESIGNS LTD</p>
      </div>`
    }),
    fr: (p) => ({
      subject: `Une tâche vous a été assignée sur Arreyon Consult`,
      html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Nouvelle tâche qui vous est assignée</h2>
        <p><strong>${escapeHtmlEmail(p.assignerName)}</strong> vous a assigné une tâche sur <strong>${escapeHtmlEmail(p.businessName)}</strong> :</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:14px 16px;margin:14px 0">
          <div style="font-weight:600">${escapeHtmlEmail(p.taskTitle)}</div>
          ${p.taskDescription ? `<div style="margin-top:8px;color:#555;white-space:pre-wrap">${escapeHtmlEmail(p.taskDescription)}</div>` : ''}
        </div>
        <a href="${p.dashboardUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Voir dans le Centre d'action</a>
        <hr style="margin-top:24px">
        <p style="color:#999;font-size:11px">Arreyon Consult par G-DESIGNS LTD</p>
      </div>`
    })
  }
};

// Email HTML is built directly from user-entered text (task titles,
// descriptions) — escape it so a task containing HTML or a stray link can't
// alter the email's structure in a recipient's mail client.
function escapeHtmlEmail(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildEmail(type, lang, params) {
  const langKey = lang === 'fr' ? 'fr' : 'en';
  return EMAIL_TEMPLATES[type][langKey](params);
}

// ── GOOGLE OAUTH ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${BASE_URL}/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value.trim().toLowerCase();
    const firstName = profile.name.givenName;
    const lastName = profile.name.familyName;
    const googleId = profile.id;
    const avatar = profile.photos[0]?.value;

    let result = await pool.query('SELECT * FROM users WHERE google_id = $1 OR LOWER(email) = LOWER($2)', [googleId, email]);
    let user = result.rows[0];

    if (!user) {
      const insert = await pool.query(
        `INSERT INTO users (email, google_id, first_name, last_name, avatar_url, email_verified, plan)
         VALUES ($1, $2, $3, $4, $5, true, 'starter') RETURNING *`,
        [email, googleId, firstName, lastName, avatar]
      );
      user = insert.rows[0];
    } else if (!user.google_id) {
      await pool.query('UPDATE users SET google_id = $1, avatar_url = $2, email_verified = true WHERE id = $3',
        [googleId, avatar, user.id]);
    }
    return done(null, user);
  } catch(e) { return done(e, null); }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0]);
  } catch(e) { done(e, null); }
});

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const token = req.cookies.arreyon_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userPlan = decoded.plan;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ── Team accounts: resolve the EFFECTIVE account for plan/limits purposes ──
// A team member has their own login, but their plan tier, consultation usage,
// director access, and feature gating (Financial Tools, downloads, etc.) all
// come from the OWNER's account, not their own — they're operating inside a
// shared account, not a separate subscription. req.userId always stays the
// actual logged-in person (for attribution); req.accountId/req.account are
// the resolved owner-or-self record everything else should check against.
async function resolveAccount(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  const user = result.rows[0];
  if (!user) return null;

  let account = user;
  if (user.team_owner_id) {
    const ownerResult = await pool.query('SELECT * FROM users WHERE id = $1', [user.team_owner_id]);
    if (ownerResult.rows[0]) account = ownerResult.rows[0];
  }

  // Subscription lifecycle enforcement — checked on the RESOLVED account
  // (the owner, for team members), since a team member inherits the
  // owner's plan entirely and should see the same locked state if the
  // owner's subscription lapses, not their own separate (nonexistent)
  // expiry. A lapsed free trial or paid subscription moves to an explicit
  // 'expired' state rather than silently reverting to starter, so the
  // frontend can show a real "subscribe to continue" lockout instead of
  // quietly treating expiration as equivalent to the free tier.
  if (account.plan !== 'expired' && account.plan_expires_at && new Date(account.plan_expires_at) < new Date()) {
    const updated = await pool.query(
      `UPDATE users SET plan = 'expired', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [account.id]
    );
    account = updated.rows[0];
  }

  return account;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS WORKSPACE — Phase 1, Step 3
// A single place that assembles whatever's known about a business, so future
// AI features read from here instead of each separately re-fetching (or
// re-asking the user for) the same context. Deliberately returns RAW English
// data with no translation-on-read — that's a presentation-layer concern for
// whichever feature displays it, not something baked into a shared data
// helper multiple future callers will depend on.
//
// Ownership is checked INSIDE this function (against the resolved account),
// not left to the caller to remember — every future consumer of this helper
// gets that protection automatically.
//
// Honest current limitation: there is no persisted financial-calculation
// history table (Financial Tools calculations are ephemeral, computed
// client-side and never saved), so no financial history is included yet.
// This will need its own schema work in a later phase, not invented here.
// ═══════════════════════════════════════════════════════════════════════════
async function getBusinessContext(businessId, accountId) {
  const bizResult = await pool.query('SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [businessId, accountId]);
  if (!bizResult.rows.length) return null;
  const business = bizResult.rows[0];

  const factsResult = await pool.query(
    `SELECT DISTINCT ON (fact_key) fact_key, fact_value, source_type, created_at
     FROM business_facts WHERE business_id = $1 ORDER BY fact_key, created_at DESC`,
    [businessId]
  );

  const researchResult = await pool.query(
    `SELECT structured_data, verification_data, scope, created_at FROM research_sessions
     WHERE business_id = $1 AND structured_data IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    [businessId]
  );

  const entrepreneurResult = await pool.query(
    `SELECT id, mode, research_backed, business_plan IS NOT NULL AS has_business_plan, created_at
     FROM entrepreneur_sessions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [businessId]
  );

  return {
    business: {
      id: business.id, name: business.name, website: business.website, industry: business.industry,
      country: business.country, region: business.region, city: business.city, currency: business.currency,
      businessModel: business.business_model, stage: business.stage,
      goals: business.goals, challenges: business.challenges, opportunities: business.opportunities,
      strategySummary: business.strategy_summary
    },
    facts: factsResult.rows,
    latestResearch: researchResult.rows[0] || null,
    entrepreneurSessions: entrepreneurResult.rows,
    financialHistory: null // not yet available — see function comment above
  };
}

// Proof-of-concept endpoint for Step 3 — exercises getBusinessContext() in
// isolation. Nothing else in the application calls this yet; it exists so
// the helper can be verified against real data before Step 4 wires any
// actual feature to it.
app.get('/api/business/:id/workspace-context', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    res.json(context);
  } catch (e) {
    console.error('Workspace context error:', e.message);
    res.status(500).json({ error: 'Failed to load business context' });
  }
});

// Condenses a full business context into a short paragraph suitable for
// appending to an AI persona — deliberately brief (a few sentences, not a
// JSON dump) since this gets re-sent on every single chat turn in an active
// conversation, and token cost compounds quickly in a multi-turn session.
function summarizeBusinessContextForAI(context) {
  if (!context) return '';
  const b = context.business;
  const parts = [];
  parts.push(`${b.name || 'This business'}${b.industry ? ', a ' + b.industry + ' business' : ''}.`);

  const hasLocation = !!(b.city || b.region || b.country);
  const locationStr = [b.city, b.region, b.country].filter(Boolean).join(', ');
  const scope = b.market_scope || 'local';

  if (hasLocation) {
    if (scope === 'international') {
      parts.push(`Based in ${locationStr}, but this business has explicitly said it wants an INTERNATIONAL/GLOBAL market perspective, not one scoped to its home location alone. Keep ${locationStr} in mind for logistics, currency, and regulatory context where relevant, but do not artificially narrow market size, competitor, or opportunity analysis to that location only.`);
    } else if (scope === 'national') {
      parts.push(`Based in ${locationStr}. This business wants a NATIONAL-level view — ground your analysis in the ${b.country || locationStr} market as a whole, not narrowed to one city/region, and not defaulting to any other country's market norms, currency, or competitive landscape.`);
    } else {
      parts.push(`Based in ${locationStr}. This business operates LOCALLY — ground every recommendation, competitor assumption, market-size estimate, and cultural/regulatory reference specifically in ${locationStr}. Do not default to generic, US-centric, or any other market's assumptions (pricing norms, platform popularity, consumer behavior, currency, regulations) unless they genuinely apply to ${locationStr}.`);
    }
  } else {
    // This exact gap — silently defaulting to a generic (frequently
    // US-centric) market when location was never actually known — is
    // what caused a Buea, Cameroon business to receive USA-centric
    // analysis. An explicit instruction here is the safeguard for any
    // business whose location genuinely wasn't provided, rather than
    // letting the model quietly fill the gap with its own default.
    parts.push(`This business's location has not been provided. Do NOT assume any specific country or market (especially not the USA) when location would materially affect your answer — competitor landscape, market size, pricing norms, currency, platform popularity, and regulations all vary hugely by location. Where location matters, say plainly that it isn't known rather than guessing a market.`);
  }

  if (context.facts.length) {
    const topFacts = context.facts.slice(0, 3).map(f => f.fact_value).filter(Boolean);
    if (topFacts.length) parts.push(`Known about the business: ${topFacts.join('; ')}.`);
  }
  if (context.latestResearch) parts.push(`Market research has already been done for this business — you don't need to guess at their competitive landscape from scratch.`);
  if (b.challenges && b.challenges.length) parts.push(`Stated challenges: ${b.challenges.join(', ')}.`);
  if (b.goals && b.goals.length) parts.push(`Stated goals: ${JSON.stringify(b.goals)}.`);
  if (!parts.length) return '';
  return `\n\nBUSINESS CONTEXT (use this naturally — the founder shouldn't need to re-explain their business to you): ${parts.join(' ')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS INTELLIGENCE — Phase 2, Step 1
// A deterministic score measuring how much is actually known and documented
// about a business — NOT a qualitative "how healthy is this business"
// judgment. That distinction matters: this number is 100% computed from data
// presence, fully explainable via its breakdown, and can never be an AI
// hallucination masquerading as fact. A qualitative AI-inferred assessment
// (SWOT) is a separate, clearly-labeled concept — see Step 2.
// ═══════════════════════════════════════════════════════════════════════════
function computeBusinessCompletenessScore(context) {
  const b = context.business;
  const breakdown = {};

  const coreFields = [b.name, b.industry, b.country, b.businessModel, b.stage];
  const coreFilled = coreFields.filter(Boolean).length;
  breakdown.coreIdentity = { points: coreFilled * 4, max: 20, detail: `${coreFilled}/5 core fields filled` };

  const factCount = context.facts.length;
  const factPoints = Math.min(factCount, 10) * 2.5;
  breakdown.businessFacts = { points: Math.round(factPoints), max: 25, detail: `${factCount} fact${factCount === 1 ? '' : 's'} documented` };

  breakdown.marketResearch = { points: context.latestResearch ? 20 : 0, max: 20, detail: context.latestResearch ? 'Research on file' : 'No research yet' };

  breakdown.entrepreneurEngagement = { points: context.entrepreneurSessions.length ? 15 : 0, max: 15, detail: context.entrepreneurSessions.length ? `${context.entrepreneurSessions.length} session(s) linked` : 'No linked sessions' };

  const strategicFields = [b.goals?.length > 0, b.challenges?.length > 0, b.opportunities?.length > 0, !!b.strategySummary];
  const strategicFilled = strategicFields.filter(Boolean).length;
  breakdown.strategicPlanning = { points: strategicFilled * 5, max: 20, detail: `${strategicFilled}/4 strategic fields filled` };

  const score = Math.round(Object.values(breakdown).reduce((sum, v) => sum + v.points, 0));
  return { score, breakdown };
}

// Deterministic funding readiness score — built entirely from objective,
// verifiable signals already tracked elsewhere in the platform (has a plan,
// has verified financials, tracks growth over time, etc.), never an
// AI-invented number. Profile completeness reuses the existing Phase 2
// score rather than a separate calculation.
function computeFundingReadinessScore({
  hasBusinessPlan,
  hasVerifiedFinancials,
  hasGrowthTracking,
  hasBusinessIntelligence,
  hasMarketContext,
  trackedCompetitorCount,
  profileCompletenessPct
}) {
  let score = 0;
  const breakdown = [];
  const add = (points, key, met) => {
    if (met) score += points;
    breakdown.push({ key, points: met ? points : 0, maxPoints: points, met: !!met });
  };

  add(20, 'has_business_plan', hasBusinessPlan);
  add(20, 'has_verified_financials', hasVerifiedFinancials);
  add(15, 'has_growth_tracking', hasGrowthTracking);
  add(15, 'has_business_intelligence', hasBusinessIntelligence);
  add(10, 'has_market_context', hasMarketContext);
  add(10, 'has_tracked_competitor', trackedCompetitorCount > 0);

  const profilePoints = Math.round((profileCompletenessPct / 100) * 10);
  score += profilePoints;
  breakdown.push({ key: 'profile_completeness', points: profilePoints, maxPoints: 10, met: profileCompletenessPct >= 80 });

  return { score: Math.min(score, 100), breakdown };
}

// Proof-of-concept endpoint, isolated from any real feature — same pattern
// used for getBusinessContext() in Phase 1. Nothing else calls this yet.
app.get('/api/business/:id/completeness-score', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    res.json(computeBusinessCompletenessScore(context));
  } catch (e) {
    console.error('Completeness score error:', e.message);
    res.status(500).json({ error: 'Failed to compute completeness score' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS INTELLIGENCE — Phase 2, Step 2
// Qualitative, AI-INFERRED analysis — genuinely different in kind from
// Step 1's deterministic score, and must always be presented as such (an
// "AI-inferred" label, never as verified fact — see the AI Trust
// Architecture principle in the Phase 0 audit). Grounded in the same
// getBusinessContext() used everywhere else, so this reflects actual known
// facts rather than generic business-advice platitudes.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/intelligence', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });

    const completeness = computeBusinessCompletenessScore(context);
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    const prompt = `You are a business intelligence analyst. Based on everything actually known about this business, provide a grounded, specific qualitative analysis — not generic business advice that could apply to any business.
${contextSummary}

DATA COMPLETENESS: ${completeness.score}/100. ${completeness.score < 40 ? 'This is LOW — be explicitly humble and tentative in your analysis rather than inventing specifics the data does not support.' : 'Use this as a general sense of how much is actually known.'}

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "strengths": ["specific strength grounded in what's actually known, or state there isn't enough data for this yet"],
  "weaknesses": ["..."],
  "opportunities": ["..."],
  "threats": ["..."],
  "critical_bottleneck": "the single most limiting factor right now, one sentence — or state that there isn't enough data to identify one confidently",
  "priority_problems": ["the 2-3 most urgent problems to address, in order"],
  "opportunity_score": "high|medium|low",
  "competitive_position": "strong|moderate|weak|unclear",
  "growth_readiness": "high|medium|low",
  "confidence_note": "one honest sentence about how much this analysis can be trusted given the data actually available"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Provide the analysis now, as JSON only.' }], complexity: 'complex', context: { feature: 'business_intelligence', userId: req.userId }, maxTokens: 2000 });

    let intelligence;
    try {
      intelligence = extractJSON(raw);
    } catch (e) {
      console.error('Business intelligence JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate business intelligence — please try again');
    }
    for (const field of ['strengths', 'weaknesses', 'opportunities', 'threats', 'priority_problems']) {
      if (!Array.isArray(intelligence[field])) {
        console.error(`Business intelligence field "${field}" was not an array:`, typeof intelligence[field]);
        throw new Error('Could not generate business intelligence — please try again');
      }
    }

    await pool.query(
      'UPDATE businesses SET intelligence_snapshot = $1, intelligence_snapshot_fr = NULL, intelligence_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(intelligence), req.params.id]
    );

    res.json({ intelligence, completeness, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Business intelligence error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate business intelligence. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BUSINESS X-RAY — Phase 2 completion (consolidates BI-01, BI-04, BX-01, BX-02)
// Same pattern as Business Intelligence above: qualitative-turned-numeric,
// AI-ASSESSED per axis (never presented as verified fact), grounded in the
// same getBusinessContext(). The overall health score is NOT asked of the
// AI — it's computed deterministically as the average of the 8 AI-assessed
// axes, so it can never disagree with the breakdown it's summarizing.
// ═══════════════════════════════════════════════════════════════════════════
const XRAY_AXES = ['strategy', 'marketing', 'sales', 'finance', 'operations', 'customer_experience', 'brand', 'digital'];

function computeXRayOverall(scores) {
  const values = XRAY_AXES.map(axis => {
    const v = Number(scores?.[axis]);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
  }).filter(v => v !== null);
  if (!values.length) return null;
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

app.post('/api/business/:id/business-xray', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });

    const completeness = computeBusinessCompletenessScore(context);
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    const prompt = `You are a business diagnostics analyst. Based on everything actually known about this business, score it across 8 specific dimensions and identify the single biggest bottleneck holding it back.
${contextSummary}

DATA COMPLETENESS: ${completeness.score}/100. ${completeness.score < 40 ? 'This is LOW — be explicitly conservative with scores rather than inventing confidence the data does not support. Scores in the 40-60 range reflect genuine uncertainty, not necessarily mediocre performance.' : 'Use this as a general sense of how much is actually known.'}

Score each dimension 0-100, where 0 is critically weak/nonexistent and 100 is excellent and fully optimized. Base every score on what is actually known — do not default to a "safe middle" score out of caution; a genuinely strong or weak area should be scored accordingly.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "scores": {
    "strategy": 0-100,
    "marketing": 0-100,
    "sales": 0-100,
    "finance": 0-100,
    "operations": 0-100,
    "customer_experience": 0-100,
    "brand": 0-100,
    "digital": 0-100
  },
  "axis_notes": {
    "strategy": "one sentence justifying this score",
    "marketing": "...",
    "sales": "...",
    "finance": "...",
    "operations": "...",
    "customer_experience": "...",
    "brand": "...",
    "digital": "..."
  },
  "bottleneck_axis": "the single axis name above that is most limiting the business right now",
  "bottleneck_reasoning": "2-3 sentences on why this is the primary bottleneck and what fixing it would unlock",
  "confidence_note": "one honest sentence about how much this assessment can be trusted given the data actually available"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Provide the Business X-Ray now, as JSON only.' }], complexity: 'complex', context: { feature: 'business_xray', userId: req.userId }, maxTokens: 2200 });

    let xray;
    try {
      xray = extractJSON(raw);
    } catch (e) {
      console.error('Business X-Ray JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate Business X-Ray — please try again');
    }
    if (!xray.scores || typeof xray.scores !== 'object') {
      console.error('Business X-Ray missing scores object');
      throw new Error('Could not generate Business X-Ray — please try again');
    }
    for (const axis of XRAY_AXES) {
      if (typeof xray.scores[axis] !== 'number') {
        console.error(`Business X-Ray axis "${axis}" was not a number:`, typeof xray.scores[axis]);
        throw new Error('Could not generate Business X-Ray — please try again');
      }
    }
    if (!XRAY_AXES.includes(xray.bottleneck_axis)) {
      console.error('Business X-Ray bottleneck_axis was not a recognized axis:', xray.bottleneck_axis);
      throw new Error('Could not generate Business X-Ray — please try again');
    }

    const overallHealthScore = computeXRayOverall(xray.scores);
    const businessXray = { ...xray, overall_health_score: overallHealthScore };

    await pool.query(
      'UPDATE businesses SET business_xray = $1, business_xray_fr = NULL, business_xray_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(businessXray), req.params.id]
    );

    res.json({ businessXray, completeness, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Business X-Ray error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate Business X-Ray. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROWTH CENTER — Phase 3, Step 1
// Deterministic progress tracking, same trust principle as the Financial
// Tools and Business Intelligence completeness score — this number is never
// AI-estimated, it's plain math against real user-reported figures.
// ═══════════════════════════════════════════════════════════════════════════
function computeGrowthProgress(startingValue, currentValue, targetValue) {
  if (targetValue === startingValue) return null; // no actual change was requested — can't compute a meaningful percentage
  const raw = (currentValue - startingValue) / (targetValue - startingValue);
  return { pct: Math.max(0, Math.min(100, Math.round(raw * 100))), rawPct: Math.round(raw * 100) };
}

// Creating a new objective retires any existing active one for this business
// — a business has one active Growth Objective at a time in this first
// version, keeping the concept simple rather than juggling several at once.
app.post('/api/business/:id/growth-objective', authRequired, async (req, res) => {
  const { metricName, unit, startingValue, targetValue, targetDate } = req.body;
  if (!metricName || startingValue === undefined || targetValue === undefined) {
    return res.status(400).json({ error: 'Please provide a metric name, starting value, and target value.' });
  }
  const startNum = parseFloat(startingValue), targetNum = parseFloat(targetValue);
  if (isNaN(startNum) || isNaN(targetNum)) return res.status(400).json({ error: 'Starting and target values must be numbers.' });
  if (startNum === targetNum) return res.status(400).json({ error: 'Target value must be different from the starting value.' });

  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const inserted = await pool.query(
      `INSERT INTO growth_objectives (business_id, owner_id, metric_name, unit, starting_value, current_value, target_value, target_date)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7) RETURNING *`,
      [req.params.id, account.id, metricName, unit || null, startNum, targetNum, targetDate || null]
    );
    await pool.query('INSERT INTO growth_progress_history (objective_id, value) VALUES ($1, $2)', [inserted.rows[0].id, startNum]);

    res.json({ success: true, objective: inserted.rows[0], progress: computeGrowthProgress(startNum, startNum, targetNum) });
  } catch (e) {
    console.error('Create growth objective error:', e.message);
    res.status(500).json({ error: 'Failed to create growth objective' });
  }
});

// Lists every active goal for a business — the new entry point now that a
// business can have more than one at once. Kept intentionally lightweight
// (no plan/milestones/translation) since this only needs to power a list of
// compact cards; the full detail loads separately once a specific goal is opened.
app.get('/api/business/:id/growth-objectives', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const result = await pool.query(
      `SELECT * FROM growth_objectives WHERE business_id = $1 AND status = 'active' ORDER BY created_at DESC`,
      [req.params.id]
    );
    const objectives = result.rows.map(obj => ({
      ...obj,
      progress: computeGrowthProgress(parseFloat(obj.starting_value), parseFloat(obj.current_value), parseFloat(obj.target_value))
    }));
    res.json({ objectives });
  } catch (e) {
    console.error('List growth objectives error:', e.message);
    res.status(500).json({ error: 'Failed to load growth objectives' });
  }
});

app.get('/api/business/:id/growth-objective/:objectiveId', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const result = await pool.query(
      `SELECT * FROM growth_objectives WHERE id = $1 AND business_id = $2`,
      [req.params.objectiveId, req.params.id]
    );
    if (!result.rows.length) return res.json({ objective: null });

    const obj = result.rows[0];

    // Same "translate once, cache, never regenerate" discipline as
    // intelligence_snapshot — this is what was missing before, which is why
    // switching to French either showed stale English or required
    // regenerating the whole plan from scratch.
    if (lang === 'fr' && obj.strategic_plan && !obj.strategic_plan_fr) {
      try {
        const translated = await translateStructuredContent(obj.strategic_plan, 'growth plan');
        await pool.query('UPDATE growth_objectives SET strategic_plan_fr = $1 WHERE id = $2', [JSON.stringify(translated), obj.id]);
        obj.strategic_plan_fr = translated;
      } catch (e) {
        console.error('Growth plan auto-translate failed (non-fatal, falling back to English):', e.message);
      }
    }
    if (lang === 'fr' && obj.strategic_plan_fr) obj.strategic_plan = obj.strategic_plan_fr;

    const progress = computeGrowthProgress(parseFloat(obj.starting_value), parseFloat(obj.current_value), parseFloat(obj.target_value));
    const milestones = await pool.query('SELECT * FROM growth_milestones WHERE objective_id = $1 ORDER BY created_at ASC', [obj.id]);
    res.json({ objective: obj, progress, milestones: milestones.rows });
  } catch (e) {
    console.error('Get growth objective error:', e.message);
    res.status(500).json({ error: 'Failed to load growth objective' });
  }
});

app.put('/api/business/:id/growth-objective/:objectiveId/progress', authRequired, async (req, res) => {
  const { currentValue } = req.body;
  if (currentValue === undefined) return res.status(400).json({ error: 'Current value is required' });
  const currentNum = parseFloat(currentValue);
  if (isNaN(currentNum)) return res.status(400).json({ error: 'Current value must be a number' });

  try {
    const account = await resolveAccount(req.userId);
    const objResult = await pool.query(
      `SELECT go.* FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
       WHERE go.id = $1 AND go.business_id = $2 AND b.user_id = $3`,
      [req.params.objectiveId, req.params.id, account.id]
    );
    if (!objResult.rows.length) return res.status(404).json({ error: 'Growth objective not found' });
    const obj = objResult.rows[0];

    const progress = computeGrowthProgress(parseFloat(obj.starting_value), currentNum, parseFloat(obj.target_value));
    // Auto-detect achievement rather than requiring the user to remember to
    // mark it — deterministic (>= 100% raw, correctly handling both growth
    // and reduction goals since computeGrowthProgress already normalizes
    // direction), never an AI guess about whether "close enough" counts.
    const newStatus = (progress && progress.rawPct >= 100) ? 'achieved' : obj.status;

    const updated = await pool.query(
      `UPDATE growth_objectives SET current_value = $1, status = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [currentNum, newStatus, obj.id]
    );
    await pool.query('INSERT INTO growth_progress_history (objective_id, value) VALUES ($1, $2)', [obj.id, currentNum]);

    // Auto-detect numeric milestones just crossed by this update — reuses
    // the same directional progress math as the objective itself, so a
    // milestone on a reduction goal (e.g. "costs down to 75") is detected
    // correctly without special-casing. Non-numeric milestones (target_value
    // IS NULL) are never touched here — those can only be checked off manually.
    const pendingMilestones = await pool.query(
      'SELECT * FROM growth_milestones WHERE objective_id = $1 AND achieved_at IS NULL AND target_value IS NOT NULL',
      [obj.id]
    );
    const newlyAchieved = [];
    for (const m of pendingMilestones.rows) {
      const milestoneProgress = computeGrowthProgress(parseFloat(obj.starting_value), currentNum, parseFloat(m.target_value));
      if (milestoneProgress && milestoneProgress.rawPct >= 100) {
        const marked = await pool.query('UPDATE growth_milestones SET achieved_at = NOW() WHERE id = $1 RETURNING *', [m.id]);
        newlyAchieved.push(marked.rows[0]);
      }
    }

    res.json({ success: true, objective: updated.rows[0], progress, newlyAchievedMilestones: newlyAchieved });
  } catch (e) {
    console.error('Update growth progress error:', e.message);
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

app.get('/api/business/:id/growth-objective/:objectiveId/progress-history', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const objResult = await pool.query(
      `SELECT go.* FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
       WHERE go.id = $1 AND go.business_id = $2 AND b.user_id = $3`,
      [req.params.objectiveId, req.params.id, account.id]
    );
    if (!objResult.rows.length) return res.status(404).json({ error: 'Growth objective not found' });
    const obj = objResult.rows[0];

    const history = await pool.query(
      'SELECT value, recorded_at FROM growth_progress_history WHERE objective_id = $1 ORDER BY recorded_at ASC',
      [req.params.objectiveId]
    );

    res.json({
      history: history.rows,
      startingValue: parseFloat(obj.starting_value),
      targetValue: parseFloat(obj.target_value),
      unit: obj.unit
    });
  } catch (e) {
    console.error('Growth progress history error:', e.message);
    res.status(500).json({ error: 'Failed to load progress history' });
  }
});

// A unified, chronological activity log for a goal — built entirely from
// records that already exist and are never auto-deleted (progress
// check-ins, milestone creation/achievement, plan generation), rather than
// a separate log table. Nothing here can silently disappear on its own;
// each entry only goes away if its underlying record is explicitly removed
// (e.g. deleting a milestone).
app.get('/api/business/:id/growth-objective/:objectiveId/activity', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const objResult = await pool.query(
      `SELECT go.* FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
       WHERE go.id = $1 AND go.business_id = $2 AND b.user_id = $3`,
      [req.params.objectiveId, req.params.id, account.id]
    );
    if (!objResult.rows.length) return res.status(404).json({ error: 'Growth objective not found' });
    const obj = objResult.rows[0];

    const events = [];
    events.push({ type: 'goal_set', timestamp: obj.created_at, detail: { metricName: obj.metric_name, startingValue: obj.starting_value, targetValue: obj.target_value } });

    const progressRows = await pool.query('SELECT value, recorded_at FROM growth_progress_history WHERE objective_id = $1 ORDER BY recorded_at ASC', [obj.id]);
    // Skip the very first entry — it's the seed value recorded at creation,
    // already represented by the goal_set event above.
    progressRows.rows.slice(1).forEach(p => events.push({ type: 'progress_update', timestamp: p.recorded_at, detail: { value: p.value } }));

    const milestoneRows = await pool.query('SELECT * FROM growth_milestones WHERE objective_id = $1', [obj.id]);
    milestoneRows.rows.forEach(m => {
      events.push({ type: 'milestone_added', timestamp: m.created_at, detail: { label: m.label } });
      if (m.achieved_at) events.push({ type: 'milestone_achieved', timestamp: m.achieved_at, detail: { label: m.label } });
    });

    if (obj.strategic_plan_generated_at) {
      events.push({ type: 'plan_generated', timestamp: obj.strategic_plan_generated_at, detail: {} });
    }

    if (obj.status === 'achieved') {
      events.push({ type: 'goal_achieved', timestamp: obj.updated_at, detail: { metricName: obj.metric_name } });
    }

    events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // most recent first
    res.json({ activity: events });
  } catch (e) {
    console.error('Growth activity error:', e.message);
    res.status(500).json({ error: 'Failed to load activity history' });
  }
});

app.post('/api/business/:id/growth-objective/:objectiveId/milestones', authRequired, async (req, res) => {
  const { label, targetValue, targetDate } = req.body;
  if (!label) return res.status(400).json({ error: 'Please give this milestone a name.' });
  try {
    const account = await resolveAccount(req.userId);
    const objResult = await pool.query(
      `SELECT go.id FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
       WHERE go.id = $1 AND go.business_id = $2 AND b.user_id = $3`,
      [req.params.objectiveId, req.params.id, account.id]
    );
    if (!objResult.rows.length) return res.status(404).json({ error: 'Growth objective not found' });

    const targetNum = targetValue !== undefined && targetValue !== '' ? parseFloat(targetValue) : null;
    const inserted = await pool.query(
      `INSERT INTO growth_milestones (objective_id, label, target_value, target_date) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.objectiveId, label, targetNum, targetDate || null]
    );
    res.json({ success: true, milestone: inserted.rows[0] });
  } catch (e) {
    console.error('Create milestone error:', e.message);
    res.status(500).json({ error: 'Failed to create milestone' });
  }
});

app.put('/api/business/:id/growth-objective/:objectiveId/milestones/:milestoneId/achieve', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `UPDATE growth_milestones SET achieved_at = NOW()
       WHERE id = $1 AND objective_id = $2 AND objective_id IN (
         SELECT go.id FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
         WHERE go.business_id = $3 AND b.user_id = $4
       ) RETURNING *`,
      [req.params.milestoneId, req.params.objectiveId, req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Milestone not found' });
    res.json({ success: true, milestone: result.rows[0] });
  } catch (e) {
    console.error('Mark milestone achieved error:', e.message);
    res.status(500).json({ error: 'Failed to update milestone' });
  }
});

app.delete('/api/business/:id/growth-objective/:objectiveId/milestones/:milestoneId', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `DELETE FROM growth_milestones
       WHERE id = $1 AND objective_id = $2 AND objective_id IN (
         SELECT go.id FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
         WHERE go.business_id = $3 AND b.user_id = $4
       ) RETURNING id`,
      [req.params.milestoneId, req.params.objectiveId, req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Milestone not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete milestone error:', e.message);
    res.status(500).json({ error: 'Failed to delete milestone' });
  }
});

// Generates strategic priorities and a 30/60/90-day plan FOR this specific
// objective — grounded in the real business context (Phase 1) and, where
// available, the existing Business Intelligence analysis (Phase 2's priority
// problems and critical bottleneck), rather than generic advice that could
// apply to any goal at any business.
app.post('/api/business/:id/growth-objective/:objectiveId/plan', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  const { startDate, endDate, months } = req.body || {};
  try {
    const account = await resolveAccount(req.userId);
    const objResult = await pool.query(
      `SELECT go.* FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
       WHERE go.id = $1 AND go.business_id = $2 AND b.user_id = $3`,
      [req.params.objectiveId, req.params.id, account.id]
    );
    if (!objResult.rows.length) return res.status(404).json({ error: 'Growth objective not found' });
    const objective = objResult.rows[0];

    // Resolve the plan's timeframe — either an explicit end date, or a
    // number of months from the start date. Falls back to a sensible 90-day
    // default only if the user genuinely supplied neither, so this stays
    // backward-compatible with a bare "just generate something" request.
    const planStart = startDate ? new Date(startDate) : new Date();
    let planEnd;
    if (endDate) {
      planEnd = new Date(endDate);
    } else if (months) {
      planEnd = new Date(planStart);
      planEnd.setMonth(planEnd.getMonth() + parseInt(months, 10));
    } else {
      planEnd = new Date(planStart);
      planEnd.setMonth(planEnd.getMonth() + 3);
    }
    if (isNaN(planStart.getTime()) || isNaN(planEnd.getTime()) || planEnd <= planStart) {
      return res.status(400).json({ error: 'Please provide a valid start date and a valid end date (or number of months) after it.' });
    }
    const totalMonths = Math.max(1, Math.round((planEnd - planStart) / (1000 * 60 * 60 * 24 * 30.44)));
    const suggestedCheckpoints = Math.min(totalMonths, 12); // caps a multi-year plan at 12 checkpoints rather than one per month indefinitely
    const planStartStr = planStart.toISOString().split('T')[0];
    const planEndStr = planEnd.toISOString().split('T')[0];

    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    // Pull the existing Business Intelligence analysis directly, if one
    // exists — getBusinessContext() (Phase 1) predates this field and
    // deliberately isn't being modified here to add it, to avoid touching a
    // shared helper other features already depend on and have been tested
    // against; a small direct query is simpler and safer for this one use.
    const bizRow = await pool.query('SELECT intelligence_snapshot FROM businesses WHERE id = $1', [req.params.id]);
    const intelligence = bizRow.rows[0]?.intelligence_snapshot;
    const intelligenceSummary = intelligence
      ? `\n\nEXISTING BUSINESS INTELLIGENCE ANALYSIS (ground your plan in this — don't ignore known problems):\nCritical bottleneck: ${intelligence.critical_bottleneck || 'none identified'}\nPriority problems: ${(intelligence.priority_problems || []).join('; ') || 'none identified'}`
      : '';

    const progress = computeGrowthProgress(parseFloat(objective.starting_value), parseFloat(objective.current_value), parseFloat(objective.target_value));

    const prompt = `You are a business growth strategist. Build a concrete, specific plan to help this founder reach a specific goal — not generic business advice.

THE GOAL: Move "${objective.metric_name}" from ${objective.starting_value}${objective.unit || ''} to ${objective.target_value}${objective.unit || ''}${objective.target_date ? ` by ${objective.target_date}` : ''}.
CURRENT PROGRESS: ${objective.current_value}${objective.unit || ''} (${progress ? progress.pct + '% of the way there' : 'just starting'}).
PLANNING WINDOW: ${planStartStr} to ${planEndStr} (about ${totalMonths} month${totalMonths === 1 ? '' : 's'}).

BUSINESS CONTEXT:
${contextSummary}${intelligenceSummary}

YOUR TASK:
Produce 2-3 strategic priorities specifically aimed at closing the gap between where they are now and this goal. Then build a timeline of exactly ${suggestedCheckpoints} checkpoint${suggestedCheckpoints === 1 ? '' : 's'} spanning the full planning window above — each checkpoint should cover a real, calendar-dated stretch of time (e.g. actual month ranges, not "Phase 1"), and each action needs a specific reason it should move THIS metric, not generic "grow your business" advice.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "strategic_priorities": ["specific priority 1, tied directly to the gap", "priority 2", "priority 3 (optional)"],
  "timeline": [
    {
      "period_label": "a real calendar range for this checkpoint, e.g. 'Feb 15 - Mar 15, 2026'",
      "focus": "the one main theme of this checkpoint, one sentence",
      "actions": [
        { "action": "a specific, concrete action", "reason": "why this specific action should move the metric" }
      ]
    }
  ],
  "reasoning_note": "one honest sentence on why this plan should move the needle, or what assumption it depends on"
}
Each checkpoint's "actions" array should have 3-5 entries.`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the plan now, as JSON only.' }], complexity: 'complex', context: { feature: 'growth_center', userId: req.userId }, maxTokens: 3500 });

    let plan;
    try {
      plan = extractJSON(raw);
    } catch (e) {
      console.error('Growth plan JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a growth plan — please try again');
    }
    if (!Array.isArray(plan.strategic_priorities) || !Array.isArray(plan.timeline)) {
      console.error('Growth plan malformed shape:', typeof plan.strategic_priorities, typeof plan.timeline);
      throw new Error('Could not generate a growth plan — please try again');
    }
    for (const checkpoint of plan.timeline) {
      if (!Array.isArray(checkpoint.actions)) {
        console.error('Growth plan checkpoint missing actions array:', checkpoint);
        throw new Error('Could not generate a growth plan — please try again');
      }
    }

    await pool.query(
      'UPDATE growth_objectives SET strategic_plan = $1, strategic_plan_fr = NULL, strategic_plan_generated_at = NOW(), plan_start_date = $2, plan_end_date = $3 WHERE id = $4',
      [JSON.stringify(plan), planStartStr, planEndStr, objective.id]
    );

    res.json({ plan, generatedAt: new Date().toISOString(), planStartDate: planStartStr, planEndDate: planEndStr });
  } catch (err) {
    console.error('Growth plan generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate growth plan. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTION CENTER — Phase 4, Step 1
// Task CRUD for a business — team-shared like everything else scoped by
// resolveAccount(). source/sourceDetail let a task record where it came from
// (a manual entry vs. a Business Intelligence priority problem or a Growth
// Center plan action) without being required.
// ═══════════════════════════════════════════════════════════════════════════

// Who a task can be assigned to — the account owner plus every active team
// member. Deliberately separate from GET /api/team, which is owner-only;
// assigning a task is something any team member should be able to do, not
// just the owner, so this needs to work for everyone on the team.
app.get('/api/business/:id/assignable-members', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const members = [{ id: account.id, name: `${account.first_name} ${account.last_name}`.trim(), email: account.email }];
    const teamResult = await pool.query(
      `SELECT u.id, u.first_name, u.last_name, u.email FROM team_members tm
       JOIN users u ON u.id = tm.member_id
       WHERE tm.owner_id = $1 AND tm.status = 'active'`,
      [account.id]
    );
    teamResult.rows.forEach(m => members.push({ id: m.id, name: `${m.first_name} ${m.last_name}`.trim(), email: m.email }));

    res.json({ members });
  } catch (e) {
    console.error('Assignable members error:', e.message);
    res.status(500).json({ error: 'Failed to load team members' });
  }
});

// Fires both an in-app Alert and an immediate email when a task is assigned
// — deliberately not batched into the daily digest like other alerts, since
// being assigned a task is the kind of thing someone should hear about
// promptly, not find in tomorrow's summary.
async function notifyTaskAssignment(assignedUserId, taskTitle, taskDescription, businessId, assignerUserId) {
  try {
    const [assignedUser, assigner, business] = await Promise.all([
      pool.query('SELECT email, first_name, last_name, preferred_language FROM users WHERE id = $1', [assignedUserId]),
      pool.query('SELECT first_name, last_name FROM users WHERE id = $1', [assignerUserId]),
      pool.query('SELECT name FROM businesses WHERE id = $1', [businessId])
    ]);
    if (!assignedUser.rows.length) return;
    const user = assignedUser.rows[0];
    const assignerName = assigner.rows[0] ? `${assigner.rows[0].first_name} ${assigner.rows[0].last_name}`.trim() : 'A teammate';
    const businessName = business.rows[0]?.name || 'a business';

    const { title, message } = alertText('taskAssigned', user.preferred_language, taskTitle, businessName, assignerName);
    await createAlert(assignedUserId, businessId, 'task_assigned', 'info', title, message, { taskTitle, businessName, assignerName });

    const { subject, html } = buildEmail('taskAssigned', user.preferred_language, { taskTitle, taskDescription, businessName, assignerName, dashboardUrl: `${BASE_URL}/dashboard` });
    await sendEmail(user.email, subject, html);
  } catch (e) {
    console.error('Task assignment notification failed (non-fatal — the task itself was still created/updated):', e.message);
  }
}

app.post('/api/business/:id/tasks', authRequired, async (req, res) => {
  const { title, description, priority, dueDate, category, source, sourceDetail, assignedTo } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Please give this task a title.' });
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const validPriority = ['high', 'medium', 'low'].includes(priority) ? priority : 'medium';
    const inserted = await pool.query(
      `INSERT INTO action_tasks (business_id, owner_id, title, description, priority, due_date, category, source, source_detail, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [req.params.id, account.id, title.trim(), description?.trim() || null, validPriority, dueDate || null, category || null, source || 'manual', sourceDetail || null, assignedTo || null]
    );

    if (assignedTo) notifyTaskAssignment(assignedTo, title.trim(), description?.trim(), req.params.id, req.userId);

    res.json({ success: true, task: inserted.rows[0] });
  } catch (e) {
    console.error('Create task error:', e.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.get('/api/business/:id/tasks', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const conditions = ['business_id = $1'];
    const params = [req.params.id];
    if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }
    if (req.query.priority) { params.push(req.query.priority); conditions.push(`priority = $${params.length}`); }

    const result = await pool.query(
      `SELECT * FROM action_tasks WHERE ${conditions.join(' AND ')} ORDER BY
       CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       CASE status WHEN 'done' THEN 1 ELSE 0 END,
       created_at DESC`,
      params
    );
    const tasks = result.rows;

    // Same "translate once, cache, never regenerate" discipline used
    // everywhere else — batched into a single AI call for however many
    // tasks need it, rather than one call per task, which would be
    // wasteful for a list.
    if (lang === 'fr') {
      const missing = tasks.filter(t => t.title && !t.title_fr);
      if (missing.length) {
        try {
          const toTranslate = Object.fromEntries(missing.map(t => [t.id, t.title]));
          const translated = await translateBusinessFacts(toTranslate);
          for (const t of missing) {
            const frTitle = translated[t.id];
            if (frTitle) {
              await pool.query('UPDATE action_tasks SET title_fr = $1 WHERE id = $2', [frTitle, t.id]);
              t.title_fr = frTitle;
            }
          }
        } catch (e) {
          console.error('Task title auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      tasks.forEach(t => { if (t.title_fr) t.title = t.title_fr; });

      const missingDesc = tasks.filter(t => t.description && !t.description_fr);
      if (missingDesc.length) {
        try {
          const toTranslate = Object.fromEntries(missingDesc.map(t => [t.id, t.description]));
          const translated = await translateBusinessFacts(toTranslate);
          for (const t of missingDesc) {
            const frDesc = translated[t.id];
            if (frDesc) {
              await pool.query('UPDATE action_tasks SET description_fr = $1 WHERE id = $2', [frDesc, t.id]);
              t.description_fr = frDesc;
            }
          }
        } catch (e) {
          console.error('Task description auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      tasks.forEach(t => { if (t.description_fr) t.description = t.description_fr; });
    }

    res.json({ tasks });
  } catch (e) {
    console.error('List tasks error:', e.message);
    res.status(500).json({ error: 'Failed to load tasks' });
  }
});

app.put('/api/business/:id/tasks/:taskId', authRequired, async (req, res) => {
  const { title, description, priority, status, dueDate, notes, assignedTo } = req.body;
  try {
    const account = await resolveAccount(req.userId);
    const existing = await pool.query(
      `SELECT t.* FROM action_tasks t JOIN businesses b ON b.id = t.business_id
       WHERE t.id = $1 AND t.business_id = $2 AND b.user_id = $3`,
      [req.params.taskId, req.params.id, account.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Task not found' });
    const task = existing.rows[0];

    const newTitle = title !== undefined ? title.trim() : task.title;
    const titleChanged = newTitle !== task.title;
    const newDescription = description !== undefined ? (description.trim() || null) : task.description;
    const descriptionChanged = newDescription !== task.description;
    const newPriority = ['high', 'medium', 'low'].includes(priority) ? priority : task.priority;
    const newStatus = ['not_started', 'in_progress', 'done'].includes(status) ? status : task.status;
    const newDueDate = dueDate !== undefined ? (dueDate || null) : task.due_date;
    const newNotes = notes !== undefined ? notes : task.notes;
    // completed_at reflects the CURRENT transition, not just "is it done" —
    // set the moment it becomes done, cleared if it's moved back off done,
    // so re-completing later gets an accurate new timestamp rather than a stale one.
    const completedAt = newStatus === 'done' ? (task.status === 'done' ? task.completed_at : new Date()) : null;
    const newTitleFr = titleChanged ? null : task.title_fr;
    const newDescriptionFr = descriptionChanged ? null : task.description_fr;
    const newAssignedTo = assignedTo !== undefined ? (assignedTo || null) : task.assigned_to;
    // Notify only on a genuine reassignment to someone new — not on every
    // save, and not if the field wasn't even part of this request.
    const isNewAssignment = newAssignedTo && newAssignedTo !== task.assigned_to;

    const updated = await pool.query(
      `UPDATE action_tasks SET title = $1, title_fr = $2, description = $3, description_fr = $4, priority = $5, status = $6, due_date = $7, notes = $8, completed_at = $9, assigned_to = $10, updated_at = NOW() WHERE id = $11 RETURNING *`,
      [newTitle, newTitleFr, newDescription, newDescriptionFr, newPriority, newStatus, newDueDate, newNotes, completedAt, newAssignedTo, task.id]
    );

    if (isNewAssignment) notifyTaskAssignment(newAssignedTo, newTitle, newDescription, req.params.id, req.userId);

    res.json({ success: true, task: updated.rows[0] });
  } catch (e) {
    console.error('Update task error:', e.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

app.delete('/api/business/:id/tasks/:taskId', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `DELETE FROM action_tasks WHERE id = $1 AND business_id = $2 AND business_id IN (
         SELECT id FROM businesses WHERE user_id = $3
       ) RETURNING id`,
      [req.params.taskId, req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Task not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete task error:', e.message);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5 — MARKET + COMPETITOR INTELLIGENCE (Step 1: Named Competitor Tracking)
// Distinct from the AI-inferred competitors already surfaced by a general
// business analysis — these are specific competitors the user names
// themselves, tracked over time with an optional AI-generated positioning
// comparison against their own business.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/competitors', authRequired, async (req, res) => {
  const { name, website, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please give this competitor a name.' });
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const inserted = await pool.query(
      `INSERT INTO tracked_competitors (business_id, owner_id, name, website, notes) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.params.id, account.id, name.trim(), website?.trim() || null, notes?.trim() || null]
    );
    res.json({ success: true, competitor: inserted.rows[0] });
  } catch (e) {
    console.error('Create competitor error:', e.message);
    res.status(500).json({ error: 'Failed to add competitor' });
  }
});

app.get('/api/business/:id/competitors', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const result = await pool.query('SELECT * FROM tracked_competitors WHERE business_id = $1 ORDER BY created_at ASC', [req.params.id]);
    const competitors = result.rows;

    // Same "translate once, cache, never regenerate" discipline as
    // everywhere else, one AI call per competitor still needing it (these
    // are relatively rare writes compared to something like task lists, so
    // batching isn't worth the added complexity here).
    if (lang === 'fr') {
      for (const c of competitors) {
        if (c.positioning_analysis && !c.positioning_analysis_fr) {
          try {
            const translated = await translateStructuredContent(c.positioning_analysis, 'competitor positioning analysis');
            await pool.query('UPDATE tracked_competitors SET positioning_analysis_fr = $1 WHERE id = $2', [JSON.stringify(translated), c.id]);
            c.positioning_analysis_fr = translated;
          } catch (e) {
            console.error('Competitor analysis auto-translate failed (non-fatal, falling back to English):', e.message);
          }
        }
        if (c.positioning_analysis_fr) c.positioning_analysis = c.positioning_analysis_fr;
      }
    }

    res.json({ competitors });
  } catch (e) {
    console.error('List competitors error:', e.message);
    res.status(500).json({ error: 'Failed to load competitors' });
  }
});

app.put('/api/business/:id/competitors/:competitorId', authRequired, async (req, res) => {
  const { name, website, notes } = req.body;
  try {
    const account = await resolveAccount(req.userId);
    const existing = await pool.query(
      `SELECT c.* FROM tracked_competitors c JOIN businesses b ON b.id = c.business_id
       WHERE c.id = $1 AND c.business_id = $2 AND b.user_id = $3`,
      [req.params.competitorId, req.params.id, account.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Competitor not found' });
    const comp = existing.rows[0];

    const newName = name !== undefined ? name.trim() : comp.name;
    const newWebsite = website !== undefined ? (website.trim() || null) : comp.website;
    const newNotes = notes !== undefined ? (notes.trim() || null) : comp.notes;

    const updated = await pool.query(
      `UPDATE tracked_competitors SET name = $1, website = $2, notes = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [newName, newWebsite, newNotes, comp.id]
    );
    res.json({ success: true, competitor: updated.rows[0] });
  } catch (e) {
    console.error('Update competitor error:', e.message);
    res.status(500).json({ error: 'Failed to update competitor' });
  }
});

app.delete('/api/business/:id/competitors/:competitorId', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `DELETE FROM tracked_competitors WHERE id = $1 AND business_id = $2 AND business_id IN (
         SELECT id FROM businesses WHERE user_id = $3
       ) RETURNING id`,
      [req.params.competitorId, req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Competitor not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete competitor error:', e.message);
    res.status(500).json({ error: 'Failed to delete competitor' });
  }
});

app.post('/api/business/:id/competitors/:competitorId/analyze', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const existing = await pool.query(
      `SELECT c.* FROM tracked_competitors c JOIN businesses b ON b.id = c.business_id
       WHERE c.id = $1 AND c.business_id = $2 AND b.user_id = $3`,
      [req.params.competitorId, req.params.id, account.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Competitor not found' });
    const comp = existing.rows[0];

    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    // Best-effort research on the competitor — if Perplexity isn't
    // configured or the search fails, proceed with whatever the user typed
    // in notes plus general reasoning rather than blocking the whole
    // analysis on it. Uses Perplexity specifically (not the Tavily-backed
    // researchSearch() used elsewhere) since its synthesized, cited answers
    // fit this kind of targeted competitor lookup better.
    let researchSummary = '';
    try {
      const query = comp.website ? `${comp.name} ${comp.website}` : comp.name;
      const results = await perplexitySearch(query, { maxResults: 4 });
      if (results.length) {
        researchSummary = '\n\nWEB RESEARCH ON THIS COMPETITOR:\n' + results.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
      }
    } catch (e) {
      console.error('Competitor web research failed (non-fatal, proceeding without it):', e.message);
    }

    const prompt = `You are a competitive strategy analyst. Compare this business against a specific named competitor.

THE USER'S BUSINESS:
${contextSummary}

THE COMPETITOR: ${comp.name}${comp.website ? ` (${comp.website})` : ''}
${comp.notes ? `User's notes on this competitor: ${comp.notes}` : ''}${researchSummary}

Produce a grounded, specific comparison — not generic competitive-analysis advice. If the web research above is thin or absent, say so plainly in your confidence_note rather than inventing specifics about the competitor.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "our_advantages": ["specific advantage 1", "specific advantage 2"],
  "their_advantages": ["specific advantage 1", "specific advantage 2"],
  "biggest_threat": "the single most important thing this competitor could do to hurt this business",
  "biggest_opportunity": "the single most important gap or weakness in this competitor worth exploiting",
  "recommended_actions": ["specific action 1", "specific action 2"],
  "confidence_note": "one honest sentence on how much this analysis can actually be trusted given the research available"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the analysis now, as JSON only.' }], complexity: 'complex', context: { feature: 'competitor_tracking', userId: req.userId }, maxTokens: 2000 });

    let analysis;
    try {
      analysis = extractJSON(raw);
    } catch (e) {
      console.error('Competitor analysis JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a competitor analysis — please try again');
    }
    for (const field of ['our_advantages', 'their_advantages', 'recommended_actions']) {
      if (!Array.isArray(analysis[field])) {
        console.error(`Competitor analysis field "${field}" was not an array:`, typeof analysis[field]);
        throw new Error('Could not generate a competitor analysis — please try again');
      }
    }

    await pool.query(
      'UPDATE tracked_competitors SET positioning_analysis = $1, positioning_analysis_fr = NULL, last_analyzed_at = NOW() WHERE id = $2',
      [JSON.stringify(analysis), comp.id]
    );

    // A genuine finding worth surfacing immediately, not waiting for the
    // next periodic monitoring sweep — matches how checkCompetitorChanges()
    // already flags a real signal the moment it's detected.
    if (analysis.biggest_threat) {
      try {
        const bizRow = await pool.query('SELECT name FROM businesses WHERE id = $1', [req.params.id]);
        const businessName = bizRow.rows[0]?.name || 'your business';
        const { title, message } = alertText('competitorThreatIdentified', language, comp.name, businessName, analysis.biggest_threat);
        await createAlert(account.id, req.params.id, 'competitor_threat', 'warning', title, message, { competitorName: comp.name, businessName, threat: analysis.biggest_threat });
      } catch (e) {
        console.error('Competitor threat alert creation failed (non-fatal — the analysis itself was still saved):', e.message);
      }
    }

    // Opportunity Radar counterpart — the exact same immediate-fire
    // reasoning, but for the positive finding rather than the risk.
    if (analysis.biggest_opportunity) {
      try {
        const bizRow = await pool.query('SELECT name FROM businesses WHERE id = $1', [req.params.id]);
        const businessName = bizRow.rows[0]?.name || 'your business';
        const { title, message } = alertText('competitorOpportunityIdentified', language, comp.name, businessName, analysis.biggest_opportunity);
        await createAlert(account.id, req.params.id, 'competitor_opportunity', 'opportunity', title, message, { competitorName: comp.name, businessName, opportunity: analysis.biggest_opportunity });
        await pool.query('UPDATE tracked_competitors SET opportunity_radar_sent_at = NOW() WHERE id = $1', [comp.id]);
      } catch (e) {
        console.error('Competitor opportunity radar item creation failed (non-fatal — the analysis itself was still saved):', e.message);
      }
    }

    res.json({ analysis, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Competitor analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate competitor analysis. Please try again.' });
  }
});

// Broader industry-level intelligence — market size, growth trend,
// seasonality — as opposed to the specific named competitors tracked above.
// One snapshot per business, regenerated on demand.
app.post('/api/business/:id/market-context', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    // Best-effort industry research — proceed with general reasoning if
    // Perplexity isn't configured or the search comes back thin, same as
    // the competitor analysis above. Uses Perplexity specifically, not the
    // Tavily-backed researchSearch() used elsewhere.
    let researchSummary = '';
    try {
      const scope = context.business?.market_scope || 'local';
      const locationForSearch = scope === 'local' ? [context.business?.city, context.business?.country].filter(Boolean).join(' ') : (context.business?.country || '');
      const industryQuery = context.business?.industry ? `${context.business.industry} market size trends ${locationForSearch}`.trim() : null;
      if (industryQuery) {
        const results = await perplexitySearch(industryQuery, { maxResults: 4 });
        if (results.length) {
          researchSummary = '\n\nWEB RESEARCH ON THIS INDUSTRY:\n' + results.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
        }
      }
    } catch (e) {
      console.error('Market context web research failed (non-fatal, proceeding without it):', e.message);
    }

    const prompt = `You are a market analyst. Assess the broader industry/market context this business operates in — not the business itself, and not specific named competitors, but the bigger picture backdrop: how big the market is, whether it's growing, and any seasonal patterns that matter.

THE BUSINESS:
${contextSummary}${researchSummary}

If the web research above is thin or absent, be honest about that in your confidence_note rather than inventing specific numbers.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "market_size_estimate": "a grounded description of the market size, or an honest statement that this can't be estimated with confidence",
  "growth_trend": "growing | stable | declining | unclear, with one sentence of explanation",
  "seasonality": "any seasonal patterns relevant to this market, or 'No strong seasonal pattern identified' if none",
  "key_industry_trends": ["trend 1", "trend 2", "trend 3 (optional)"],
  "opportunities_from_context": ["specific opportunity tied to this market context", "opportunity 2 (optional)"],
  "risks_from_context": ["specific risk tied to this market context", "risk 2 (optional)"],
  "confidence_note": "one honest sentence on how much this analysis can be trusted given the research available"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the analysis now, as JSON only.' }], complexity: 'complex', context: { feature: 'market_context', userId: req.userId }, maxTokens: 2000 });

    let marketContext;
    try {
      marketContext = extractJSON(raw);
    } catch (e) {
      console.error('Market context JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate market context — please try again');
    }
    for (const field of ['key_industry_trends', 'opportunities_from_context', 'risks_from_context']) {
      if (!Array.isArray(marketContext[field])) {
        console.error(`Market context field "${field}" was not an array:`, typeof marketContext[field]);
        throw new Error('Could not generate market context — please try again');
      }
    }

    await pool.query(
      'UPDATE businesses SET market_context = $1, market_context_fr = NULL, market_context_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(marketContext), req.params.id]
    );

    // A genuine finding worth surfacing immediately — same reasoning as the
    // competitor threat alert above, not waiting for a periodic sweep.
    if (marketContext.growth_trend && /declin/i.test(marketContext.growth_trend)) {
      try {
        const businessName = context.business?.name || 'your business';
        const { title, message } = alertText('marketDeclining', language, businessName, marketContext.growth_trend);
        await createAlert(account.id, req.params.id, 'market_decline', 'warning', title, message, { businessName, growthTrend: marketContext.growth_trend });
      } catch (e) {
        console.error('Market decline alert creation failed (non-fatal — the analysis itself was still saved):', e.message);
      }
    }

    // Opportunity Radar counterpart — surfaces only the first (most
    // prominent) opportunity rather than one alert per item, since the
    // model typically orders these by importance and several separate
    // alerts for one analysis would be noisy rather than useful.
    if (marketContext.opportunities_from_context?.length) {
      try {
        const businessName = context.business?.name || 'your business';
        const { title, message } = alertText('marketOpportunityIdentified', language, businessName, marketContext.opportunities_from_context[0]);
        await createAlert(account.id, req.params.id, 'market_opportunity', 'opportunity', title, message, { businessName, opportunity: marketContext.opportunities_from_context[0] });
        await pool.query('UPDATE businesses SET market_opportunity_radar_sent_at = NOW() WHERE id = $1', [req.params.id]);
      } catch (e) {
        console.error('Market opportunity radar item creation failed (non-fatal — the analysis itself was still saved):', e.message);
      }
    }

    res.json({ marketContext, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Market context generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate market context. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — MARKETING & SALES (Step 1: Standalone Marketing Strategy)
// Same marketing_plan shape a full Business Plan already produces, but as
// its own regenerable feature — no need to run the whole business-plan
// flow just for marketing help.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/marketing-strategy', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    // Ground this in whatever else is already known about the business —
    // Business Intelligence's priority problems and Market Context's
    // opportunities are directly relevant to what a marketing strategy
    // should actually focus on, not just the raw business facts.
    const bizRow = await pool.query('SELECT intelligence_snapshot, market_context FROM businesses WHERE id = $1', [req.params.id]);
    const intelligence = bizRow.rows[0]?.intelligence_snapshot;
    const marketContext = bizRow.rows[0]?.market_context;
    let additionalContext = '';
    if (intelligence?.priority_problems?.length) {
      additionalContext += `\n\nKNOWN PRIORITY PROBLEMS (from Business Intelligence): ${intelligence.priority_problems.join('; ')}`;
    }
    if (marketContext?.opportunities_from_context?.length) {
      additionalContext += `\n\nKNOWN MARKET OPPORTUNITIES: ${marketContext.opportunities_from_context.join('; ')}`;
    }

    // Real, current research into how businesses like this one actually
    // reach customers — without this, the model has nothing but its own
    // generic training-data defaults to reason from, and tends to
    // over-suggest one "safe" platform (LinkedIn) regardless of whether it
    // actually fits this business's real customers.
    let researchSummary = '';
    try {
      const industryQuery = context.business?.industry
        ? `how do small businesses in ${context.business.industry} reach and market to customers in ${context.business.country || 'their local market'} — which social platforms and channels actually work`
        : null;
      if (industryQuery) {
        const results = await perplexitySearch(industryQuery, { maxResults: 4 });
        if (results.length) {
          researchSummary = '\n\nWEB RESEARCH ON HOW BUSINESSES LIKE THIS ONE ACTUALLY REACH CUSTOMERS:\n' + results.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
        }
      }
    } catch (e) {
      console.error('Marketing strategy web research failed (non-fatal, proceeding without it):', e.message);
    }

    const prompt = `You are a senior marketing strategist. Produce an advanced, specific marketing strategy for this business — not generic marketing advice that could apply to any business, and not a default "safe" answer.

THE BUSINESS:
${contextSummary}${additionalContext}${researchSummary}

CRITICAL INSTRUCTION ON CHANNELS: Do not default to LinkedIn or any other single "safe" professional platform unless it is genuinely where this specific business's actual customers spend their time. Reason concretely from who the customer actually is: a local, consumer-facing business in a market like Cameroon is far more likely reached through WhatsApp Business, Instagram, Facebook, and TikTok than LinkedIn, which mainly serves B2B and professional-networking audiences. A B2B or professional-services business may genuinely warrant LinkedIn. Justify each channel choice by who it actually reaches for this business, and prefer a mix of channels over repeating the same one.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "target_audience": "the specific customer profile marketing should focus on",
  "key_messaging": "the core message or hook that should appear in all marketing",
  "marketing_channels": ["specific channel 1, with a brief reason it fits this business's actual customers", "specific channel 2, with its reason"],
  "content_strategy": "what kind of content to post and how often, concretely",
  "promotional_tactics": ["specific tactic 1 (e.g. referral discount, launch offer)", "specific tactic 2"],
  "customer_acquisition_funnel": "the step-by-step path from stranger to paying customer, specific to this business",
  "marketing_budget_estimate": "realistic monthly marketing spend given what's known about this business",
  "confidence_note": "one honest sentence on what this strategy assumes or where it's less certain"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the strategy now, as JSON only.' }], complexity: 'complex', context: { feature: 'marketing_strategy', userId: req.userId }, maxTokens: 2000 });

    let strategy;
    try {
      strategy = extractJSON(raw);
    } catch (e) {
      console.error('Marketing strategy JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a marketing strategy — please try again');
    }
    for (const field of ['marketing_channels', 'promotional_tactics']) {
      if (!Array.isArray(strategy[field])) {
        console.error(`Marketing strategy field "${field}" was not an array:`, typeof strategy[field]);
        throw new Error('Could not generate a marketing strategy — please try again');
      }
    }

    await pool.query(
      'UPDATE businesses SET marketing_strategy = $1, marketing_strategy_fr = NULL, marketing_strategy_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(strategy), req.params.id]
    );

    res.json({ strategy, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Marketing strategy generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate marketing strategy. Please try again.' });
  }
});

function buildMarketingStrategyDOCX(strategy, businessName) {
  const children = [];
  children.push(new Paragraph({ text: businessName || 'Marketing Strategy', heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Marketing Strategy · Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult by G-DESIGNS LTD`, italics: true, size: 18, color: '777777' })]
  }));
  children.push(new Paragraph({ text: '' }));

  function heading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 })); }
  function para(text) { children.push(new Paragraph({ text: text || '', spacing: { after: 150 } })); }
  function bullet(text) { children.push(new Paragraph({ text, bullet: { level: 0 } })); }

  if (strategy.confidence_note) {
    children.push(new Paragraph({ children: [new TextRun({ text: strategy.confidence_note, italics: true, size: 18, color: '888888' })], spacing: { after: 200 } }));
  }

  heading('Target Audience'); para(strategy.target_audience);
  heading('Key Messaging'); para(strategy.key_messaging);
  heading('Marketing Channels'); (strategy.marketing_channels || []).forEach(bullet); children.push(new Paragraph({ text: '' }));
  heading('Content Strategy'); para(strategy.content_strategy);
  heading('Promotional Tactics'); (strategy.promotional_tactics || []).forEach(bullet); children.push(new Paragraph({ text: '' }));
  heading('Customer Acquisition Funnel'); para(strategy.customer_acquisition_funnel);
  heading('Estimated Monthly Budget'); para(strategy.marketing_budget_estimate);

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This strategy was AI-generated and should be reviewed before major marketing spend.', size: 15, color: 'AAAAAA', italics: true })],
    alignment: AlignmentType.CENTER
  }));

  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

app.get('/api/business/:id/marketing-strategy/download', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT name, website, marketing_strategy FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];
    if (!business.marketing_strategy) return res.status(404).json({ error: 'No marketing strategy has been generated yet for this business.' });

    const buffer = await buildMarketingStrategyDOCX(business.marketing_strategy, business.name || business.website);
    const filename = sanitizeFilename(business.name || business.website);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}-marketing-strategy.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Marketing strategy download error:', err.message);
    res.status(500).json({ error: 'Failed to generate the download. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — MARKETING & SALES (Step 2: Content Calendar / Campaign Planner)
// Builds directly on Marketing Strategy's target audience and channels when
// it exists, so post ideas are tied to the business's actual strategy
// rather than generic content suggestions.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/content-calendar', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  const { startDate, endDate } = req.body || {};
  try {
    const account = await resolveAccount(req.userId);

    const calStart = startDate ? new Date(startDate) : new Date();
    const calEnd = endDate ? new Date(endDate) : (() => { const d = new Date(calStart); d.setDate(d.getDate() + 30); return d; })();
    if (isNaN(calStart.getTime()) || isNaN(calEnd.getTime()) || calEnd <= calStart) {
      return res.status(400).json({ error: 'Please provide a valid start date and an end date after it.' });
    }
    const daysInRange = Math.round((calEnd - calStart) / (1000 * 60 * 60 * 24));
    // Roughly 3-4 posts/week is a realistic cadence for a small business —
    // capped so a multi-month range doesn't produce an overwhelming response.
    const suggestedPostCount = Math.min(Math.round(daysInRange / 7 * 3.5), 30);
    const calStartStr = calStart.toISOString().split('T')[0];
    const calEndStr = calEnd.toISOString().split('T')[0];

    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    const bizRow = await pool.query('SELECT marketing_strategy FROM businesses WHERE id = $1', [req.params.id]);
    const strategy = bizRow.rows[0]?.marketing_strategy;
    const strategyContext = strategy
      ? `\n\nEXISTING MARKETING STRATEGY (ground content ideas in this — use the actual target audience, channels, and messaging, don't invent different ones):\nTarget audience: ${strategy.target_audience || 'not specified'}\nKey messaging: ${strategy.key_messaging || 'not specified'}\nChannels: ${(strategy.marketing_channels || []).join(', ') || 'not specified'}\nContent strategy: ${strategy.content_strategy || 'not specified'}`
      : '\n\nNo marketing strategy has been generated for this business yet — reason concretely about who this business\'s actual customers are and where they actually spend time online, rather than defaulting to a generic professional platform like LinkedIn regardless of business type.';

    const prompt = `You are a senior content marketing planner. Produce an advanced, concrete content calendar for this business covering ${calStartStr} to ${calEndStr} (about ${daysInRange} days).

THE BUSINESS:
${contextSummary}${strategyContext}

YOUR TASK: Produce exactly ${suggestedPostCount} post ideas spread sensibly across the date range above (not clustered on one day) — a realistic posting cadence, not one post every single day. Each post needs a real calendar date within the range, a specific platform, a content type, and a concrete topic/idea specific to this business — not generic content marketing filler. Do not repeat the same single platform for every post unless that is genuinely where this specific business's customers are — vary platforms across the calendar the way a real multi-channel plan would, reflecting the actual mix of channels this business's customers use.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "posts": [
    { "date": "YYYY-MM-DD", "platform": "specific platform, e.g. Instagram", "content_type": "specific format, e.g. Reel, carousel, WhatsApp status", "topic": "the specific idea for this post", "caption_hook": "a short opening line or hook for the caption" }
  ],
  "confidence_note": "one honest sentence on what this calendar assumes"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the calendar now, as JSON only.' }], complexity: 'complex', context: { feature: 'content_calendar', userId: req.userId }, maxTokens: 3000 });

    let calendar;
    try {
      calendar = extractJSON(raw);
    } catch (e) {
      console.error('Content calendar JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a content calendar — please try again');
    }
    if (!Array.isArray(calendar.posts)) {
      console.error('Content calendar "posts" was not an array:', typeof calendar.posts);
      throw new Error('Could not generate a content calendar — please try again');
    }
    for (const post of calendar.posts) {
      if (!post.date || !post.platform || !post.topic) {
        console.error('Content calendar post missing required fields:', post);
        throw new Error('Could not generate a content calendar — please try again');
      }
    }

    await pool.query(
      'UPDATE businesses SET content_calendar = $1, content_calendar_fr = NULL, content_calendar_generated_at = NOW(), content_calendar_start_date = $2, content_calendar_end_date = $3 WHERE id = $4',
      [JSON.stringify(calendar), calStartStr, calEndStr, req.params.id]
    );

    res.json({ calendar, generatedAt: new Date().toISOString(), startDate: calStartStr, endDate: calEndStr });
  } catch (err) {
    console.error('Content calendar generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate content calendar. Please try again.' });
  }
});

// Shared date-grid math for the visual month calendar — used here for the
// Word download's table, and mirrored in the frontend for the on-screen
// grid, so both present the exact same layout.
function getMonthsInRange(startDateStr, endDateStr) {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  const months = [];
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    months.push({ year: cursor.getFullYear(), month: cursor.getMonth() });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return months;
}

function buildMonthGrid(year, month) {
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = firstDay.getDay();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// Matches the frontend's PLATFORM_STYLES exactly (docx colors omit the '#'
// prefix Web CSS uses) so the downloaded document visually agrees with
// what's shown on screen.
const DOCX_PLATFORM_STYLES = [
  { match: /instagram/i, color: 'E1306C' },
  { match: /facebook/i, color: '1877F2' },
  { match: /whatsapp/i, color: '25D366' },
  { match: /tiktok/i, color: '010101' },
  { match: /linkedin/i, color: '0A66C2' },
  { match: /twitter|x\.com|\bx\b/i, color: '1DA1F2' },
  { match: /youtube/i, color: 'FF0000' },
  { match: /email|newsletter/i, color: '8b87b8' }
];
function getDocxPlatformColor(platformName) {
  return (DOCX_PLATFORM_STYLES.find(p => p.match.test(platformName || '')) || { color: '6C3Bff' }).color;
}

function buildContentCalendarDOCX(calendar, businessName, startDate, endDate) {
  const children = [];
  children.push(new Paragraph({ text: `${businessName || 'Content Calendar'}`, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Content Calendar · ${startDate} to ${endDate} · Arreyon Consult by G-DESIGNS LTD`, italics: true, size: 18, color: '777777' })]
  }));
  children.push(new Paragraph({ text: '' }));
  if (calendar.confidence_note) {
    children.push(new Paragraph({ children: [new TextRun({ text: calendar.confidence_note, italics: true, size: 18, color: '888888' })], spacing: { after: 200 } }));
  }

  // Index posts by their exact date string for quick lookup while building
  // each day cell below.
  const postsByDate = {};
  (calendar.posts || []).forEach(p => {
    if (!postsByDate[p.date]) postsByDate[p.date] = [];
    postsByDate[p.date].push(p);
  });

  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = getMonthsInRange(startDate, endDate);

  months.forEach(({ year, month }) => {
    const monthName = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    children.push(new Paragraph({ text: monthName, heading: HeadingLevel.HEADING_1 }));

    const headerRow = new TableRow({ children: dayLabels.map(d => new TableCell({ children: [new Paragraph({ text: d, bold: true, alignment: AlignmentType.CENTER })] })) });
    const weeks = buildMonthGrid(year, month);
    const bodyRows = weeks.map(week => new TableRow({
      children: week.map(dayNum => {
        if (dayNum === null) return new TableCell({ children: [new Paragraph({ text: '' })] });
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
        const dayPosts = postsByDate[dateStr] || [];
        const cellChildren = [new Paragraph({ children: [new TextRun({ text: String(dayNum), bold: true, size: 18 })] })];
        dayPosts.forEach(p => {
          cellChildren.push(new Paragraph({ children: [new TextRun({ text: `${p.platform || ''}${p.content_type ? ' · ' + p.content_type : ''}`, size: 14, bold: true, color: getDocxPlatformColor(p.platform) })] }));
          cellChildren.push(new Paragraph({ children: [new TextRun({ text: p.topic || '', size: 14 })] }));
        });
        return new TableCell({ children: cellChildren, width: { size: 14, type: WidthType.PERCENTAGE } });
      })
    }));

    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...bodyRows] }));
    children.push(new Paragraph({ text: '' }));
  });

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This calendar was AI-generated and should be reviewed before scheduling.', size: 15, color: 'AAAAAA', italics: true })],
    alignment: AlignmentType.CENTER
  }));

  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

app.get('/api/business/:id/content-calendar/download', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT name, website, content_calendar, content_calendar_start_date, content_calendar_end_date FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];
    if (!business.content_calendar) return res.status(404).json({ error: 'No content calendar has been generated yet for this business.' });

    const startStr = business.content_calendar_start_date.toISOString ? business.content_calendar_start_date.toISOString().split('T')[0] : business.content_calendar_start_date;
    const endStr = business.content_calendar_end_date.toISOString ? business.content_calendar_end_date.toISOString().split('T')[0] : business.content_calendar_end_date;

    const buffer = await buildContentCalendarDOCX(business.content_calendar, business.name || business.website, startStr, endStr);
    const filename = sanitizeFilename(business.name || business.website);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}-content-calendar.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Content calendar download error:', err.message);
    res.status(500).json({ error: 'Failed to generate the download. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 7 — MARKETING & SALES (Step 3: Simple Lead Tracking)
// Deliberately not a CRM — name, contact info, a simple status, and a
// follow-up date that stays in sync with a real Action Center task.
// ═══════════════════════════════════════════════════════════════════════════

// Keeps a lead's linked follow-up task in sync with its next_follow_up_date:
// creates one if none exists yet, updates the existing one if the date
// changed, or removes it entirely if the date was cleared — a lead with no
// scheduled follow-up shouldn't leave a stale, meaningless task behind.
async function syncLeadFollowUpTask(lead, ownerId, businessId) {
  const title = `Follow up with ${lead.name}`;
  if (lead.next_follow_up_date) {
    if (lead.linked_task_id) {
      await pool.query('UPDATE action_tasks SET title = $1, title_fr = NULL, due_date = $2, updated_at = NOW() WHERE id = $3', [title, lead.next_follow_up_date, lead.linked_task_id]);
      return lead.linked_task_id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO action_tasks (business_id, owner_id, title, priority, due_date, source, source_detail, lead_id) VALUES ($1, $2, $3, 'medium', $4, 'lead_tracking', $5, $6) RETURNING id`,
        [businessId, ownerId, title, lead.next_follow_up_date, lead.name, lead.id]
      );
      return inserted.rows[0].id;
    }
  } else if (lead.linked_task_id) {
    await pool.query('DELETE FROM action_tasks WHERE id = $1', [lead.linked_task_id]);
    return null;
  }
  return lead.linked_task_id || null;
}

app.post('/api/business/:id/leads', authRequired, async (req, res) => {
  const { name, contactInfo, phone, status, nextFollowUpDate, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Please give this lead a name.' });
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const validStatus = ['new', 'contacted', 'qualified', 'won', 'lost'].includes(status) ? status : 'new';
    const inserted = await pool.query(
      `INSERT INTO leads (business_id, owner_id, name, contact_info, phone, status, next_follow_up_date, notes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.params.id, account.id, name.trim(), contactInfo?.trim() || null, phone?.trim() || null, validStatus, nextFollowUpDate || null, notes?.trim() || null]
    );
    const lead = inserted.rows[0];
    await syncLeadFollowUpTask({ ...lead, linked_task_id: null }, account.id, req.params.id);

    res.json({ success: true, lead });
  } catch (e) {
    console.error('Create lead error:', e.message);
    res.status(500).json({ error: 'Failed to create lead' });
  }
});

app.get('/api/business/:id/leads', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const conditions = ['business_id = $1'];
    const params = [req.params.id];
    if (req.query.status) { params.push(req.query.status); conditions.push(`status = $${params.length}`); }

    const result = await pool.query(
      `SELECT * FROM leads WHERE ${conditions.join(' AND ')} ORDER BY
       CASE WHEN next_follow_up_date IS NULL THEN 1 ELSE 0 END, next_follow_up_date ASC, created_at DESC`,
      params
    );
    res.json({ leads: result.rows });
  } catch (e) {
    console.error('List leads error:', e.message);
    res.status(500).json({ error: 'Failed to load leads' });
  }
});

app.put('/api/business/:id/leads/:leadId', authRequired, async (req, res) => {
  const { name, contactInfo, phone, status, nextFollowUpDate, notes } = req.body;
  try {
    const account = await resolveAccount(req.userId);
    const existing = await pool.query(
      `SELECT l.* FROM leads l JOIN businesses b ON b.id = l.business_id
       WHERE l.id = $1 AND l.business_id = $2 AND b.user_id = $3`,
      [req.params.leadId, req.params.id, account.id]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Lead not found' });
    const lead = existing.rows[0];

    const newName = name !== undefined ? name.trim() : lead.name;
    const newContactInfo = contactInfo !== undefined ? (contactInfo.trim() || null) : lead.contact_info;
    const newPhone = phone !== undefined ? (phone.trim() || null) : lead.phone;
    const newStatus = ['new', 'contacted', 'qualified', 'won', 'lost'].includes(status) ? status : lead.status;
    const newFollowUpDate = nextFollowUpDate !== undefined ? (nextFollowUpDate || null) : lead.next_follow_up_date;
    const newNotes = notes !== undefined ? (notes.trim() || null) : lead.notes;
    // A follow-up that's freshly reset (date changed) is no longer overdue
    // in any meaningful sense — clear the alert-sent marker so a genuinely
    // new date can trigger its own reminder later if it, too, passes.
    const followUpChanged = String(newFollowUpDate) !== String(lead.next_follow_up_date);

    const updated = await pool.query(
      `UPDATE leads SET name = $1, contact_info = $2, phone = $3, status = $4, next_follow_up_date = $5, notes = $6, overdue_alert_sent_at = $7, updated_at = NOW() WHERE id = $8 RETURNING *`,
      [newName, newContactInfo, newPhone, newStatus, newFollowUpDate, newNotes, followUpChanged ? null : lead.overdue_alert_sent_at, lead.id]
    );
    const updatedLead = updated.rows[0];

    const existingTask = await pool.query('SELECT id FROM action_tasks WHERE lead_id = $1', [lead.id]);
    await syncLeadFollowUpTask({ ...updatedLead, linked_task_id: existingTask.rows[0]?.id || null }, account.id, req.params.id);

    res.json({ success: true, lead: updatedLead });
  } catch (e) {
    console.error('Update lead error:', e.message);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

app.delete('/api/business/:id/leads/:leadId', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `DELETE FROM leads WHERE id = $1 AND business_id = $2 AND business_id IN (
         SELECT id FROM businesses WHERE user_id = $3
       ) RETURNING id`,
      [req.params.leadId, req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ success: true });
  } catch (e) {
    console.error('Delete lead error:', e.message);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — BUSINESS PLAN + FUNDING (Step 2: Funding Readiness Score)
// The score is deterministic (computeFundingReadinessScore, computed from
// real signals already tracked elsewhere) — only the qualitative
// strengths/gaps/next-steps are AI-generated, and they're grounded in the
// computed breakdown, not free to invent their own assessment of readiness.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/funding-readiness', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    const hasBusinessPlan = context.entrepreneurSessions.some(s => s.has_business_plan);
    let hasVerifiedFinancials = false;
    if (hasBusinessPlan) {
      const latestPlanRow = await pool.query(
        `SELECT business_plan FROM entrepreneur_sessions WHERE business_id = $1 AND business_plan IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]
      );
      hasVerifiedFinancials = !!latestPlanRow.rows[0]?.business_plan?.computed_financials;
    }

    // "Real" growth tracking means at least one objective has been checked
    // in on beyond its initial seed value — not just that a goal exists.
    const growthTrackingRow = await pool.query(
      `SELECT go.id FROM growth_objectives go
       JOIN growth_progress_history gph ON gph.objective_id = go.id
       WHERE go.business_id = $1
       GROUP BY go.id HAVING COUNT(gph.id) > 1 LIMIT 1`,
      [req.params.id]
    );
    const hasGrowthTracking = growthTrackingRow.rows.length > 0;

    const bizRow = await pool.query('SELECT intelligence_snapshot, market_context FROM businesses WHERE id = $1', [req.params.id]);
    const hasBusinessIntelligence = !!bizRow.rows[0]?.intelligence_snapshot;
    const hasMarketContext = !!bizRow.rows[0]?.market_context;

    const competitorCountRow = await pool.query('SELECT COUNT(*) FROM tracked_competitors WHERE business_id = $1', [req.params.id]);
    const trackedCompetitorCount = parseInt(competitorCountRow.rows[0].count, 10);

    const completeness = computeBusinessCompletenessScore(context);
    const { score, breakdown } = computeFundingReadinessScore({
      hasBusinessPlan, hasVerifiedFinancials, hasGrowthTracking, hasBusinessIntelligence,
      hasMarketContext, trackedCompetitorCount, profileCompletenessPct: completeness.score
    });

    const BREAKDOWN_KEY_DESCRIPTIONS = {
      has_business_plan: 'Has a generated business plan',
      has_verified_financials: 'Has verified (not just estimated) financial data',
      has_growth_tracking: 'Has tracked growth progress over time',
      has_business_intelligence: 'Has a Business Intelligence analysis',
      has_market_context: 'Has a Market Context analysis',
      has_tracked_competitor: 'Tracks at least one named competitor',
      profile_completeness: 'Business profile completeness'
    };
    const prompt = `You are a startup funding advisor. This business has a COMPUTED, deterministic funding readiness score of ${score}/100 based on real signals (not your own estimate) — do not restate or recalculate this score, only explain and build on it.

THE COMPUTED BREAKDOWN (what's actually in place vs. missing):
${breakdown.map(b => `- ${b.met ? '✓' : '✗'} ${BREAKDOWN_KEY_DESCRIPTIONS[b.key] || b.key} (${b.points}/${b.maxPoints} points)`).join('\n')}

THE BUSINESS:
${contextSummary}

YOUR TASK: Explain what this score actually means for this specific business, grounded in the breakdown above — not generic fundraising advice. Identify genuine strengths already in place, the specific gaps that would most concern an investor, and concrete next steps to close them.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "readiness_summary": "one or two sentences on what this score means for this business specifically",
  "strengths": ["specific strength already in place, tied to the breakdown", "strength 2 (optional)"],
  "gaps": ["specific gap that would concern an investor, tied to what's missing in the breakdown", "gap 2"],
  "recommended_next_steps": ["specific, actionable step to close the biggest gap", "step 2", "step 3 (optional)"],
  "confidence_note": "one honest sentence on what this assessment assumes or where it's less certain"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the assessment now, as JSON only.' }], complexity: 'complex', context: { feature: 'funding_readiness', userId: req.userId }, maxTokens: 2000 });

    let assessment;
    try {
      assessment = extractJSON(raw);
    } catch (e) {
      console.error('Funding readiness JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a funding readiness assessment — please try again');
    }
    for (const field of ['strengths', 'gaps', 'recommended_next_steps']) {
      if (!Array.isArray(assessment[field])) {
        console.error(`Funding readiness field "${field}" was not an array:`, typeof assessment[field]);
        throw new Error('Could not generate a funding readiness assessment — please try again');
      }
    }

    const fundingReadiness = { score, breakdown, ...assessment };
    await pool.query(
      'UPDATE businesses SET funding_readiness = $1, funding_readiness_fr = NULL, funding_readiness_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(fundingReadiness), req.params.id]
    );

    // Opportunity Radar: only a genuine crossing into a stronger band fires
    // — staying in the same band, or dropping to a weaker one, never does.
    // The band is still updated either way, so a later re-crossing back up
    // is correctly detected as new rather than suppressed.
    const bandRank = { weak: 0, developing: 1, strong: 2 };
    const newBand = score >= 70 ? 'strong' : score >= 40 ? 'developing' : 'weak';
    const lastBandRow = await pool.query('SELECT funding_readiness_last_band, name FROM businesses WHERE id = $1', [req.params.id]);
    const lastBand = lastBandRow.rows[0]?.funding_readiness_last_band;
    const isUpgrade = !lastBand || bandRank[newBand] > bandRank[lastBand];
    if (isUpgrade) {
      const bandLabel = language === 'fr'
        ? { weak: 'faible', developing: 'en développement', strong: 'solide' }[newBand]
        : newBand;
      const { title, message } = alertText('fundingMilestoneReached', language, lastBandRow.rows[0]?.name || 'this business', bandLabel);
      await createAlert(account.id, req.params.id, 'funding_milestone_reached', 'opportunity', title, message, { band: newBand, score });
    }
    await pool.query('UPDATE businesses SET funding_readiness_last_band = $1 WHERE id = $2', [newBand, req.params.id]);

    res.json({ fundingReadiness, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Funding readiness generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate funding readiness assessment. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — BUSINESS PLAN + FUNDING (Step 3: Investor Materials)
// A structured pitch deck outline grounded in whatever real data already
// exists for this business (business plan, funding readiness, business
// intelligence) — the financial slide restates verified numbers rather
// than inventing new ones.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/pitch-deck', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });
    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';

    const bizRow = await pool.query('SELECT intelligence_snapshot, funding_readiness FROM businesses WHERE id = $1', [req.params.id]);
    const intelligence = bizRow.rows[0]?.intelligence_snapshot;
    const fundingReadiness = bizRow.rows[0]?.funding_readiness;

    const latestPlanRow = await pool.query(
      `SELECT business_plan FROM entrepreneur_sessions WHERE business_id = $1 AND business_plan IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );
    const businessPlan = latestPlanRow.rows[0]?.business_plan;

    let additionalContext = '';
    if (businessPlan) {
      additionalContext += `\n\nEXISTING BUSINESS PLAN (ground the deck in this, especially the financial slide — do not invent different figures than what's here):\n${JSON.stringify(businessPlan)}`;
    }
    if (fundingReadiness) {
      additionalContext += `\n\nFUNDING READINESS ASSESSMENT (score ${fundingReadiness.score}/100): Strengths: ${(fundingReadiness.strengths || []).join('; ')}. Gaps: ${(fundingReadiness.gaps || []).join('; ')}.`;
    }
    if (intelligence?.strengths?.length || intelligence?.threats?.length) {
      additionalContext += `\n\nBUSINESS INTELLIGENCE: Strengths: ${(intelligence.strengths || []).join('; ')}. Threats: ${(intelligence.threats || []).join('; ')}.`;
    }

    const prompt = `You are an investor-pitch consultant. Produce a structured pitch deck outline for this business — specific to this business, not a generic template with placeholder text.

THE BUSINESS:
${contextSummary}${additionalContext}

YOUR TASK: Produce exactly 9 slides in this order: Title, Problem, Solution, Market Opportunity, Business Model, Traction, Competition, Financial Highlights, The Ask. Each slide needs 3-5 concrete, specific bullet points — not generic pitch-deck filler. The Financial Highlights slide must restate only numbers that are actually known from the business plan or context above; if no verified numbers exist, say so honestly in that slide's content rather than inventing figures.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "slides": [
    { "slide_number": 1, "title": "Title Slide", "content": ["business name and one-line tagline", "founder name if known"] },
    { "slide_number": 2, "title": "Problem", "content": ["specific point 1", "specific point 2"] }
  ],
  "confidence_note": "one honest sentence on what this deck assumes or where the underlying data is thin"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the pitch deck outline now, as JSON only.' }], complexity: 'complex', context: { feature: 'pitch_deck', userId: req.userId }, maxTokens: 3000 });

    let pitchDeck;
    try {
      pitchDeck = extractJSON(raw);
    } catch (e) {
      console.error('Pitch deck JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate a pitch deck outline — please try again');
    }
    if (!Array.isArray(pitchDeck.slides)) {
      console.error('Pitch deck "slides" was not an array:', typeof pitchDeck.slides);
      throw new Error('Could not generate a pitch deck outline — please try again');
    }
    for (const slide of pitchDeck.slides) {
      if (!slide.title || !Array.isArray(slide.content)) {
        console.error('Pitch deck slide missing required fields:', slide);
        throw new Error('Could not generate a pitch deck outline — please try again');
      }
    }

    await pool.query(
      'UPDATE businesses SET pitch_deck = $1, pitch_deck_fr = NULL, pitch_deck_generated_at = NOW() WHERE id = $2',
      [JSON.stringify(pitchDeck), req.params.id]
    );

    res.json({ pitchDeck, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Pitch deck generation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate pitch deck outline. Please try again.' });
  }
});

function buildPitchDeckDOCX(pitchDeck, businessName) {
  const children = [];
  children.push(new Paragraph({ text: `${businessName || 'Pitch Deck'} — Investor Pitch Outline`, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult by G-DESIGNS LTD`, italics: true, size: 18, color: '777777' })]
  }));
  children.push(new Paragraph({ text: '' }));
  if (pitchDeck.confidence_note) {
    children.push(new Paragraph({ children: [new TextRun({ text: pitchDeck.confidence_note, italics: true, size: 18, color: '888888' })], spacing: { after: 200 } }));
  }

  (pitchDeck.slides || []).forEach(slide => {
    children.push(new Paragraph({ text: `Slide ${slide.slide_number || ''}: ${slide.title}`, heading: HeadingLevel.HEADING_1 }));
    (slide.content || []).forEach(point => {
      children.push(new Paragraph({ text: point, bullet: { level: 0 } }));
    });
    children.push(new Paragraph({ text: '' }));
  });

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This outline was AI-generated and is a starting point for a real pitch deck, not a finished one.', size: 15, color: 'AAAAAA', italics: true })],
    alignment: AlignmentType.CENTER
  }));

  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

app.get('/api/business/:id/pitch-deck/download', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT name, website, pitch_deck FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];
    if (!business.pitch_deck) return res.status(404).json({ error: 'No pitch deck outline has been generated yet for this business.' });

    const buffer = await buildPitchDeckDOCX(business.pitch_deck, business.name || business.website);
    const filename = sanitizeFilename(business.name || business.website);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}-pitch-deck.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Pitch deck download error:', err.message);
    res.status(500).json({ error: 'Failed to generate the download. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 — BUSINESS PLAN + FUNDING (Step 4: Share)
// One share token per business. The public read endpoint deliberately
// selects ONLY the specific fields meant for sharing — the business's name,
// its plan, funding readiness, and pitch deck — never the full business
// row, which holds far more (leads, growth objectives, internal notes,
// financial facts) that has no business being exposed on an unauthenticated
// link, however that link was obtained.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/share', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE businesses SET share_token = $1, share_created_at = NOW() WHERE id = $2', [token, req.params.id]);

    res.json({ success: true, shareUrl: `${BASE_URL}/shared-plan.html?token=${token}` });
  } catch (err) {
    console.error('Share creation error:', err.message);
    res.status(500).json({ error: 'Failed to create share link. Please try again.' });
  }
});

app.delete('/api/business/:id/share', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      'UPDATE businesses SET share_token = NULL, share_created_at = NULL WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Business not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Share revocation error:', err.message);
    res.status(500).json({ error: 'Failed to revoke share link. Please try again.' });
  }
});

app.get('/api/share/:token', async (req, res) => {
  try {
    const bizRow = await pool.query(
      'SELECT id, name, website, industry, funding_readiness, pitch_deck, share_created_at FROM businesses WHERE share_token = $1',
      [req.params.token]
    );
    if (!bizRow.rows.length) return res.status(404).json({ error: 'This share link is invalid or has been revoked.' });
    const business = bizRow.rows[0];

    const latestPlanRow = await pool.query(
      `SELECT business_plan FROM entrepreneur_sessions WHERE business_id = $1 AND business_plan IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [business.id]
    );

    res.json({
      businessName: business.name || business.website,
      industry: business.industry,
      businessPlan: latestPlanRow.rows[0]?.business_plan || null,
      fundingReadiness: business.funding_readiness || null,
      pitchDeck: business.pitch_deck || null,
      sharedSince: business.share_created_at
    });
  } catch (err) {
    console.error('Public share view error:', err.message);
    res.status(500).json({ error: 'Failed to load this shared plan. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 / INCREMENT 1 — WEBSITE INTELLIGENCE & CONTROL: connection + read-only
//
// A website connection belongs to a specific Business Workspace (business_id),
// not the Arreyon account as a whole — unlike Google/HubSpot/Zoho, which are
// account-wide OAuth connections. Ownership is checked the same way as every
// other business-scoped endpoint (tracked_competitors, leads): resolve the
// account, then confirm the business belongs to it.
// ═══════════════════════════════════════════════════════════════════════════

// Records an event to the audit log — read-only events (connected,
// intelligence generated) from this increment onward, not just future
// write actions, so the log has real, useful content from day one rather
// than sitting empty until execution features exist.
async function logWebsiteAudit(websiteConnectionId, actorType, actorId, actionType, description, details) {
  await pool.query(
    `INSERT INTO website_audit_log (website_connection_id, actor_type, actor_id, action_type, description, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [websiteConnectionId, actorType, actorId, actionType, description, JSON.stringify(details || {})]
  );
}

// Connect (or reconnect) a WordPress site to a business. Credentials are
// verified against the real site BEFORE anything is stored — an invalid
// username/Application Password never gets encrypted and saved.
// ═══════════════════════════════════════════════════════════════════════════
// SEO REST Bridge mu-plugin — a downloadable product asset, not something
// specific to any one customer's WordPress site. Every Arreyon customer
// connecting their own WordPress site hits the same underlying limitation
// (SEO plugins ship their meta fields as REST-read-only by default), so
// this is served directly by the app itself rather than living only in a
// support conversation — no auth required, since the content is generic
// and non-sensitive, and it may reasonably be handed to a client's own
// developer rather than downloaded by the Arreyon account holder directly.
const ARREYON_SEO_REST_BRIDGE_PLUGIN = `<?php
/**
 * Plugin Name: Arreyon SEO REST Bridge
 * Description: Registers your SEO plugin's meta title/description fields
 *              for REST API write access, so Arreyon Consult's SEO Agent
 *              can actually update them. Without this, WordPress core
 *              REST API can update a page/post's main title, but SEO
 *              plugins (Yoast, Rank Math, All in One SEO) ship their own
 *              meta fields as READ-ONLY by design — a write to them
 *              silently succeeds at the API level while never actually
 *              saving. This plugin closes that gap for whichever of the
 *              three plugins you actually have installed; it does
 *              nothing for the others.
 * Version:     1.0.0
 * Author:      G-DESIGNS LTD / Arreyon Consult
 *
 * INSTALLATION
 * 1. Upload this file to wp-content/mu-plugins/ on your WordPress site
 *    (create that folder if it doesn't exist yet).
 * 2. That's it — files in mu-plugins activate automatically. There is
 *    nothing to enable in the Plugins screen, and it cannot be
 *    accidentally deactivated the way a normal plugin can.
 *
 * SECURITY
 * Every field registered here requires the same edit_posts capability a
 * normal WordPress user needs to edit that content — the Application
 * Password Arreyon uses must belong to a user who already has that
 * capability (Editor role or above). This plugin does not lower any
 * permission; it only exposes fields that already exist to the same
 * permission check WordPress already enforces everywhere else.
 */

if (!defined('ABSPATH')) {
    exit; // Never execute this file directly, only as a loaded WordPress plugin.
}

function arreyon_register_seo_rest_fields() {
    // Only registered for post types that are actually shown in the REST
    // API (public, REST-enabled types) — matches what Arreyon itself reads
    // and writes (pages and posts), and avoids registering fields on
    // internal post types that were never meant to be exposed.
    $post_types = get_post_types(['public' => true, 'show_in_rest' => true]);

    // Field key => sanitize callback. sanitize_text_field is used for all
    // of these since none of them are expected to contain HTML — a title
    // or meta description with markup would be a data-quality issue in
    // its own right, not something this plugin should silently allow.
    $seo_fields = [
        // Yoast SEO
        '_yoast_wpseo_title'          => 'sanitize_text_field',
        '_yoast_wpseo_metadesc'       => 'sanitize_text_field',
        '_yoast_wpseo_focuskw'        => 'sanitize_text_field',
        // Rank Math
        'rank_math_title'             => 'sanitize_text_field',
        'rank_math_description'       => 'sanitize_text_field',
        'rank_math_focus_keyword'     => 'sanitize_text_field',
        // All in One SEO
        '_aioseo_title'               => 'sanitize_text_field',
        '_aioseo_description'         => 'sanitize_text_field',
        '_aioseo_keywords'            => 'sanitize_text_field',
    ];

    foreach ($post_types as $post_type) {
        foreach ($seo_fields as $meta_key => $sanitize_callback) {
            register_post_meta($post_type, $meta_key, [
                'show_in_rest'      => true,
                'single'            => true,
                'type'              => 'string',
                'sanitize_callback' => $sanitize_callback,
                // Read requires nothing extra (these fields are visible to
                // anyone who can already see the post); write requires the
                // same capability WordPress already uses to decide whether
                // someone can edit that specific post.
                'auth_callback'     => function ($allowed, $meta_key, $post_id) {
                    return current_user_can('edit_post', $post_id);
                },
            ]);
        }
    }
}
// Runs after both WordPress core (priority 10) and every major SEO plugin
// have registered their own post types and meta boxes, so this never
// races a plugin that hasn't finished setting up its own fields yet.
add_action('init', 'arreyon_register_seo_rest_fields', 20);
`;

// Standalone CRC32 and a minimal single-file ZIP builder — no new npm
// dependency, since that would require the person deploying this to run
// npm install on their own server, a risk this file can't verify from
// here. Doesn't rely on Node's built-in zlib.crc32 either, since that was
// only added in Node 22.2.0 and this needs to work on whatever Node
// version the deployed server actually runs, not just this one.
function arreyonMakeCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
}
const ARREYON_CRC_TABLE = arreyonMakeCrcTable();
function arreyonCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = ARREYON_CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// Builds a minimal, valid ZIP archive with one STORED (uncompressed) entry.
// entryPath must include the plugin's own folder (e.g.
// "arreyon-seo-rest-bridge/arreyon-seo-rest-bridge.php") since WordPress
// expects the plugin file to sit inside a folder matching its slug, not
// at the zip root.
function arreyonBuildSingleFileZip(entryPath, content) {
  const nameBuf = Buffer.from(entryPath, 'utf8');
  const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const crc = arreyonCrc32(dataBuf);
  const dosTime = 0x0000, dosDate = 0x0021; // fixed, valid placeholder — the exact timestamp has no functional importance here

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(dosTime, 10);
  localHeader.writeUInt16LE(dosDate, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(dataBuf.length, 18);
  localHeader.writeUInt32LE(dataBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const localEntry = Buffer.concat([localHeader, nameBuf, dataBuf]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(dosTime, 12);
  centralHeader.writeUInt16LE(dosDate, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(dataBuf.length, 20);
  centralHeader.writeUInt32LE(dataBuf.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42); // offset of local header — 0, since this is the only entry
  const centralEntry = Buffer.concat([centralHeader, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localEntry, centralEntry, eocd]);
}

// The primary, recommended path: a proper .zip a person installs through
// WordPress's own familiar "Plugins → Add New → Upload Plugin" screen —
// no FTP, no cPanel file manager, no knowledge of what mu-plugins even
// are. Built fresh on each request (the file is tiny, so there's no
// reason to cache it) rather than requiring a zip to be committed and
// kept in sync with the source separately.
app.get('/api/website-tools/seo-rest-bridge-plugin.zip', (req, res) => {
  const zipBuf = arreyonBuildSingleFileZip('arreyon-seo-rest-bridge/arreyon-seo-rest-bridge.php', ARREYON_SEO_REST_BRIDGE_PLUGIN);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="arreyon-seo-rest-bridge.zip"');
  res.send(zipBuf);
});

// The raw .php file — kept for developers who specifically want the
// mu-plugin (auto-activates, can't be accidentally disabled) and already
// know how to reach their site's file system.
app.get('/api/website-tools/seo-rest-bridge-plugin', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="arreyon-seo-rest-bridge.php"');
  res.send(ARREYON_SEO_REST_BRIDGE_PLUGIN);
});

// ═══════════════════════════════════════════════════════════════════════════
// Arreyon Connect plugin — the code-based, non-technical-friendly connection
// path (Option 2). Reuses the same zip-builder helper as the SEO REST
// Bridge plugin above rather than duplicating that logic.
// ═══════════════════════════════════════════════════════════════════════════
const ARREYON_CONNECT_PLUGIN = `<?php
/**
 * Plugin Name: Arreyon Connect
 * Description: Connects this WordPress site to your Arreyon Consult account using a
 *              short connection code — no need to manually find or paste an
 *              Application Password. Generates its own Application Password
 *              internally and sends it to Arreyon on your behalf, once you enter
 *              the code shown in your Arreyon account.
 * Version:     1.0.0
 * Author:      G-DESIGNS LTD / Arreyon Consult
 * Requires PHP: 7.4
 *
 * INSTALLATION
 * WordPress admin → Plugins → Add New → Upload Plugin → choose this file's
 * .zip → Install Now → Activate. Then go to Settings → Arreyon Connect.
 *
 * WHAT THIS PLUGIN DOES AND DOES NOT DO
 * It creates one Application Password for whichever WordPress user runs the
 * connection (must be able to manage_options — typically an Administrator),
 * and sends that password to Arreyon Consult over HTTPS. It does not read,
 * modify, or publish anything on this site by itself — all of that happens
 * later, through Arreyon's own approval workflow, using the credential this
 * plugin generated.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('ARREYON_CONNECT_API_BASE', 'https://consult.gdesignsme.com');
define('ARREYON_CONNECT_OPTION_KEY', 'arreyon_connect_status');

add_action('admin_menu', function () {
    add_menu_page(
        'Arreyon Connect',
        'Arreyon Connect',
        'manage_options',
        'arreyon-connect',
        'arreyon_connect_render_page',
        'dashicons-admin-links',
        80
    );
});

// The standard WordPress convention for plugin discoverability — a
// "Settings" link right on the plugin's own row (next to
// Deactivate/Delete) on the Plugins page, so a person doesn't have to
// already know this menu item exists somewhere in the sidebar to find it.
add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($actions) {
    $settings_link = '<a href="' . esc_url(admin_url('admin.php?page=arreyon-connect')) . '">' . esc_html__('Settings') . '</a>';
    array_unshift($actions, $settings_link);
    return $actions;
});

function arreyon_connect_render_page() {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You do not have permission to access this page.'));
    }

    $status = get_option(ARREYON_CONNECT_OPTION_KEY, null);
    $error = isset($_GET['arreyon_error']) ? sanitize_text_field(wp_unslash($_GET['arreyon_error'])) : null;
    ?>
    <div class="wrap">
        <h1>Arreyon Connect</h1>

        <?php if ($error): ?>
            <div class="notice notice-error"><p><?php echo esc_html($error); ?></p></div>
        <?php endif; ?>

        <?php if ($status && !empty($status['connected'])): ?>
            <div class="notice notice-success">
                <p>
                    🎉 <strong><?php echo esc_html($status['business_name'] ?: 'Your business'); ?></strong> is connected.<br>
                    Website: <?php echo esc_html(wp_parse_url(home_url(), PHP_URL_HOST)); ?><br>
                    Status: Connected<br>
                    WordPress: Detected<br>
                    Access: Read &amp; Analyze
                </p>
            </div>
            <p>To connect a different Arreyon account or business, enter a new connection code below.</p>
        <?php else: ?>
            <p>Install this plugin, then enter the connection code shown in your Arreyon Consult account to link this website — no need to find or copy any password yourself.</p>
        <?php endif; ?>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <?php wp_nonce_field('arreyon_connect_action', 'arreyon_connect_nonce'); ?>
            <input type="hidden" name="action" value="arreyon_connect">
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="arreyon_code">Connection Code</label></th>
                    <td>
                        <input type="text" id="arreyon_code" name="arreyon_code" class="regular-text" placeholder="ARREYON-XXXX-XXXX" required>
                        <p class="description">Shown in Arreyon Consult under Website → Connect Website.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button('Connect to Arreyon'); ?>
        </form>
    </div>
    <?php
}

add_action('admin_post_arreyon_connect', function () {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You do not have permission to do this.'));
    }
    check_admin_referer('arreyon_connect_action', 'arreyon_connect_nonce');

    $redirect_base = admin_url('admin.php?page=arreyon-connect');
    $code = isset($_POST['arreyon_code']) ? sanitize_text_field(wp_unslash($_POST['arreyon_code'])) : '';

    if (empty($code)) {
        wp_safe_redirect(add_query_arg('arreyon_error', rawurlencode('Please enter a connection code.'), $redirect_base));
        exit;
    }

    // Application Passwords require HTTPS by default — checked before
    // attempting to create one, so the person gets a clear, specific
    // reason rather than a generic failure if this site doesn't qualify.
    if (!wp_is_application_passwords_available()) {
        wp_safe_redirect(add_query_arg('arreyon_error', rawurlencode('Application Passwords are not available on this site — WordPress requires HTTPS for this feature.'), $redirect_base));
        exit;
    }

    $user_id = get_current_user_id();
    $current_user = wp_get_current_user();

    // Include a timestamp in the name so reconnecting later (e.g. after a
    // previous attempt failed partway through) never collides with an
    // existing password of the same name, which WordPress rejects.
    $password_name = 'Arreyon Consult - ' . current_time('Y-m-d H:i:s');
    $created = WP_Application_Passwords::create_new_application_password($user_id, ['name' => $password_name]);

    if (is_wp_error($created)) {
        wp_safe_redirect(add_query_arg('arreyon_error', rawurlencode('Could not create an Application Password: ' . $created->get_error_message()), $redirect_base));
        exit;
    }

    list($new_password, $new_item) = $created;

    $response = wp_remote_post(ARREYON_CONNECT_API_BASE . '/api/website-connector/register', [
        'timeout' => 20,
        'headers' => ['Content-Type' => 'application/json'],
        'body' => wp_json_encode([
            'code' => $code,
            'siteUrl' => home_url(),
            'username' => $current_user->user_login,
            'appPassword' => $new_password,
        ]),
    ]);

    if (is_wp_error($response)) {
        // The handshake never reached Arreyon — the password this plugin
        // just created is orphaned and useless, so it's removed rather
        // than left behind silently.
        WP_Application_Passwords::delete_application_password($user_id, $new_item['uuid']);
        wp_safe_redirect(add_query_arg('arreyon_error', rawurlencode('Could not reach Arreyon Consult: ' . $response->get_error_message()), $redirect_base));
        exit;
    }

    $status_code = wp_remote_retrieve_response_code($response);
    $body = json_decode(wp_remote_retrieve_body($response), true);

    if ($status_code !== 200 || empty($body['success'])) {
        // Same reasoning — Arreyon rejected the handshake (an invalid or
        // expired code, for instance), so this side's freshly-created
        // password is cleaned up rather than left as a dangling,
        // never-used credential.
        WP_Application_Passwords::delete_application_password($user_id, $new_item['uuid']);
        $error_message = !empty($body['error']) ? $body['error'] : 'Arreyon Consult rejected the connection attempt.';
        wp_safe_redirect(add_query_arg('arreyon_error', rawurlencode($error_message), $redirect_base));
        exit;
    }

    update_option(ARREYON_CONNECT_OPTION_KEY, [
        'connected' => true,
        'business_name' => !empty($body['businessName']) ? sanitize_text_field($body['businessName']) : null,
        'connected_at' => current_time('mysql'),
    ]);

    wp_safe_redirect(add_query_arg('arreyon_connected', '1', $redirect_base));
    exit;
});
`;

app.get('/api/website-tools/arreyon-connect-plugin.zip', (req, res) => {
  const zipBuf = arreyonBuildSingleFileZip('arreyon-connect/arreyon-connect.php', ARREYON_CONNECT_PLUGIN);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="arreyon-connect.zip"');
  res.send(zipBuf);
});

app.get('/api/website-tools/arreyon-connect-plugin', (req, res) => {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="arreyon-connect.php"');
  res.send(ARREYON_CONNECT_PLUGIN);
});


// Shared by both the connect endpoint (existing business) and
// connect-new (a business created on the fly) — the actual WordPress
// verification and website_connections storage logic is identical either
// way, only how the business itself is resolved differs.
// Rather than guess which of several possible causes produced a 403,
// this reads WordPress's actual response and looks for real evidence.
// Distinguishing a genuine WordPress permission problem (a
// "rest_forbidden" JSON response — this Application Password's user
// lacks the capability the request needs) from a security plugin or
// hosting-level block matters a lot: they need completely different
// fixes, and guessing wrong wastes the person's time checking the wrong
// setting.
async function buildForbiddenErrorMessage(verifyRes) {
  let bodyText = '';
  try { bodyText = await verifyRes.text(); } catch (e) {}
  const lower = bodyText.toLowerCase();

  if (lower.includes('rest_forbidden') || lower.includes('rest_cannot')) {
    return 'WordPress rejected this with a permissions error, not a security-plugin block: the WordPress user behind this Application Password does not have sufficient permissions (it needs at least an Editor role, or ideally Administrator). Please check that user\'s role in WordPress, or generate the Application Password using an Administrator account instead.';
  }

  // "Just a moment..." combined with Cloudflare's challenge markers is the
  // specific signature of Cloudflare's own bot/JS challenge page — this is
  // fundamentally different from a WAF rule or IP block, and the fix
  // depends entirely on which Cloudflare plan the site is on (researched:
  // Bot Fight Mode on the Free plan cannot be bypassed by ANY rule at
  // all — Cloudflare's own documentation is explicit about this — while
  // Super Bot Fight Mode on paid plans does support a targeted exception).
  if (lower.includes('just a moment') && lower.includes('cloudflare')) {
    return 'Cloudflare (sitting in front of this WordPress site) is showing its bot-challenge page — this happens before the request even reaches WordPress, so no WordPress or Arreyon setting can fix it directly. In the Cloudflare dashboard, check Security → Events to see exactly which feature fired. If it\'s "Bot Fight Mode" (the free-tier version), Cloudflare\'s own documentation confirms this cannot be bypassed by any rule — the only options are turning it off site-wide or upgrading to a paid plan. If it\'s "Super Bot Fight Mode" (Pro or higher) or a WAF rule, a targeted rule can be added so only authenticated REST API requests skip the challenge, e.g.: (http.request.uri.path contains "/wp-json/") and (http.request.headers["authorization"][0] ne "") — Action: Skip. This exempts only API traffic carrying real credentials, not regular visitors to the site.';
  }

  let likelySource = null;
  if (lower.includes('wordfence')) likelySource = 'Wordfence';
  else if (lower.includes('ithemes') || lower.includes('solid security')) likelySource = 'Solid Security / iThemes Security';
  else if (lower.includes('sucuri')) likelySource = 'Sucuri';
  else if (lower.includes('cloudflare')) likelySource = 'Cloudflare';
  else if (lower.includes('mod_security') || lower.includes('modsecurity')) likelySource = 'ModSecurity (a server-level firewall rule, not a WordPress plugin — your hosting provider would need to adjust this)';

  const excerpt = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

  let message = 'WordPress accepted the connection attempt but blocked it (403 Forbidden). ';
  if (likelySource) {
    message += `The response indicates this was blocked by ${likelySource}. `;
  } else {
    message += 'This is usually a security plugin or your hosting provider\'s firewall restricting REST API or Application Password access. ';
  }
  if (excerpt) {
    message += `WordPress's actual response: "${excerpt}"${excerpt.length >= 300 ? '...' : ''}`;
  }
  return message;
}

async function connectWordPressSite(businessId, siteUrl, username, appPassword, userId) {
  const trimmedUrl = siteUrl.trim();
  const trimmedUser = username.trim();
  const trimmedPass = appPassword.trim();

  let siteName = null, wpVersion = null;
  try {
    const rootRes = await wpApiRequest(trimmedUrl, '', '', '/', { timeoutMs: 8000 });
    if (rootRes.ok) {
      const rootData = await rootRes.json();
      siteName = rootData.name || null;
      wpVersion = null; // modern WordPress omits its version here by design; honestly always unavailable, not a real check
    }
  } catch (e) {
    return { ok: false, statusCode: 400, error: 'Could not reach a WordPress site at that URL. Please check the address and that the site is online.' };
  }

  let verifyRes;
  try {
    verifyRes = await wpApiRequest(trimmedUrl, trimmedUser, trimmedPass, '/wp/v2/pages?per_page=1&status=any&context=edit', { timeoutMs: 10000 });
  } catch (e) {
    return { ok: false, statusCode: 400, error: e.message || 'Could not connect to WordPress. Please check your website URL.' };
  }

  if (verifyRes.status === 401) {
    return { ok: false, statusCode: 400, error: 'WordPress rejected these credentials. Please check your username and Application Password.' };
  }
  if (verifyRes.status === 403) {
    return { ok: false, statusCode: 400, error: await buildForbiddenErrorMessage(verifyRes) };
  }
  if (!verifyRes.ok) {
    return { ok: false, statusCode: 400, error: `WordPress returned an unexpected error (status ${verifyRes.status}). Please verify your site supports the REST API.` };
  }

  const encryptedPassword = encryptSecret(trimmedPass);

  const existing = await pool.query('SELECT id FROM website_connections WHERE business_id = $1', [businessId]);
  let connection;
  if (existing.rows.length) {
    const updated = await pool.query(
      `UPDATE website_connections SET site_url = $1, site_name = $2, wp_version = $3, wp_username = $4,
       wp_app_password_encrypted = $5, connection_status = 'connected', last_verified_at = NOW(),
       last_error = NULL, connected_at = NOW(), disconnected_at = NULL
       WHERE id = $6 RETURNING id, site_url, site_name, connection_status, permission_level, automation_mode, connected_at`,
      [trimmedUrl, siteName, wpVersion, trimmedUser, encryptedPassword, existing.rows[0].id]
    );
    connection = updated.rows[0];
  } else {
    const inserted = await pool.query(
      `INSERT INTO website_connections (business_id, site_url, site_name, wp_version, wp_username, wp_app_password_encrypted, connection_status, last_verified_at, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'connected', NOW(), NOW())
       RETURNING id, site_url, site_name, connection_status, permission_level, automation_mode, connected_at`,
      [businessId, trimmedUrl, siteName, wpVersion, trimmedUser, encryptedPassword]
    );
    connection = inserted.rows[0];
  }

  await logWebsiteAudit(connection.id, 'user', userId, 'connected', `Connected WordPress site: ${trimmedUrl}`, { siteUrl: trimmedUrl });

  return { ok: true, connection };
}

// Connects a WordPress site to a business that hasn't been analyzed yet —
// creates a minimal business record first (name only; every other
// businesses column is nullable, so this is a safe, valid row), so a
// website can be connected without requiring the full Analyzer flow to
// run beforehand.
app.post('/api/business/website/connect-new', authRequired, async (req, res) => {
  const { businessName, siteUrl, username, appPassword } = req.body;
  if (!businessName || !businessName.trim()) return res.status(400).json({ error: 'Please enter a business name.' });
  if (!siteUrl || !siteUrl.trim()) return res.status(400).json({ error: 'Please enter your website URL.' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'Please enter your WordPress username.' });
  if (!appPassword || !appPassword.trim()) return res.status(400).json({ error: 'Please enter your Application Password.' });

  try {
    const account = await resolveAccount(req.userId);
    const inserted = await pool.query(
      'INSERT INTO businesses (user_id, name, website) VALUES ($1, $2, $3) RETURNING id',
      [account.id, businessName.trim(), siteUrl.trim()]
    );
    const newBusinessId = inserted.rows[0].id;

    const result = await connectWordPressSite(newBusinessId, siteUrl, username, appPassword, req.userId);
    if (!result.ok) {
      // The business now exists even though the connection attempt
      // failed — that's the right outcome (it's a real, correctly-named
      // business the person can retry connecting from the normal
      // dropdown), not something to roll back just because this one step
      // didn't succeed.
      return res.status(result.statusCode).json({ error: result.error, businessId: newBusinessId });
    }

    res.json({ success: true, businessId: newBusinessId, connection: result.connection });
  } catch (e) {
    console.error('Website connect-new error:', e.message);
    res.status(500).json({ error: 'Failed to connect website' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ARREYON CONNECT PLUGIN — connection-code handshake (Option 2). Arreyon
// generates a short-lived, single-use code and displays it; the person
// enters that code into the Arreyon Connect plugin on their own WordPress
// site, which then reaches OUT to Arreyon (the reverse of the direct
// credential flow) with a fresh Application Password it generated itself.
// Excludes visually ambiguous characters (0/O, 1/I/L) since a person needs
// to type this by hand from one screen into another.
// ═══════════════════════════════════════════════════════════════════════════
function generateConnectionCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const segment = (len) => Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `ARREYON-${segment(4)}-${segment(4)}`;
}

async function generateAndStoreConnectionCode(businessId) {
  // Only one live code per business at a time — expiring any earlier,
  // still-unused code for this business avoids confusion about which of
  // several displayed codes is actually still valid.
  await pool.query(`UPDATE website_connection_codes SET expires_at = NOW() WHERE business_id = $1 AND used_at IS NULL`, [businessId]);

  const code = generateConnectionCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes — long enough to switch tabs and install a plugin, short enough to keep the guessing window small
  await pool.query(
    'INSERT INTO website_connection_codes (business_id, code, expires_at) VALUES ($1, $2, $3)',
    [businessId, code, expiresAt]
  );
  return { code, expiresAt };
}

app.post('/api/business/:id/website/generate-code', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const { code, expiresAt } = await generateAndStoreConnectionCode(req.params.id);
    res.json({ code, expiresAt });
  } catch (e) {
    console.error('Generate connection code error:', e.message);
    res.status(500).json({ error: 'Failed to generate a connection code' });
  }
});

// Same as above, but for a business that hasn't been analyzed yet —
// creates a minimal business record first (name only, same as
// connect-new), then generates the code for it.
app.post('/api/business/website/generate-code-new', authRequired, async (req, res) => {
  const { businessName } = req.body;
  if (!businessName || !businessName.trim()) return res.status(400).json({ error: 'Please enter a business name.' });

  try {
    const account = await resolveAccount(req.userId);
    const inserted = await pool.query(
      'INSERT INTO businesses (user_id, name) VALUES ($1, $2) RETURNING id',
      [account.id, businessName.trim()]
    );
    const newBusinessId = inserted.rows[0].id;

    const { code, expiresAt } = await generateAndStoreConnectionCode(newBusinessId);
    res.json({ code, expiresAt, businessId: newBusinessId });
  } catch (e) {
    console.error('Generate connection code (new business) error:', e.message);
    res.status(500).json({ error: 'Failed to generate a connection code' });
  }
});

// Deliberately public — the caller here is the WordPress plugin itself,
// not an Arreyon-authenticated person, so there is no Arreyon session to
// check. Security instead rests on the code being short-lived,
// single-use, and drawn from a large-enough space (30^8 combinations)
// that guessing one within its 15-minute window is impractical.
app.post('/api/website-connector/register', async (req, res) => {
  const { code, siteUrl, username, appPassword } = req.body;
  if (!code || !siteUrl || !username || !appPassword) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const codeResult = await pool.query(
      'SELECT * FROM website_connection_codes WHERE code = $1',
      [code.trim().toUpperCase()]
    );
    if (!codeResult.rows.length) return res.status(400).json({ error: 'This connection code was not recognized. Please generate a new one in Arreyon Consult.' });
    const codeRow = codeResult.rows[0];

    if (codeRow.used_at) return res.status(400).json({ error: 'This connection code has already been used. Please generate a new one in Arreyon Consult.' });
    if (new Date(codeRow.expires_at) < new Date()) return res.status(400).json({ error: 'This connection code has expired. Please generate a new one in Arreyon Consult.' });

    const biz = await pool.query('SELECT id, user_id FROM businesses WHERE id = $1', [codeRow.business_id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'The business associated with this code no longer exists.' });

    const result = await connectWordPressSite(codeRow.business_id, siteUrl, username, appPassword, biz.rows[0].user_id);
    if (!result.ok) return res.status(result.statusCode).json({ error: result.error });

    await pool.query('UPDATE website_connection_codes SET used_at = NOW() WHERE id = $1', [codeRow.id]);

    res.json({ success: true, businessName: (await pool.query('SELECT name FROM businesses WHERE id = $1', [codeRow.business_id])).rows[0]?.name || null });
  } catch (e) {
    console.error('Website connector register error:', e.message);
    res.status(500).json({ error: 'Failed to complete the connection. Please try again.' });
  }
});

app.post('/api/business/:id/website/connect', authRequired, async (req, res) => {
  const { siteUrl, username, appPassword } = req.body;
  if (!siteUrl || !siteUrl.trim()) return res.status(400).json({ error: 'Please enter your website URL.' });
  if (!username || !username.trim()) return res.status(400).json({ error: 'Please enter your WordPress username.' });
  if (!appPassword || !appPassword.trim()) return res.status(400).json({ error: 'Please enter your Application Password.' });

  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const result = await connectWordPressSite(req.params.id, siteUrl, username, appPassword, req.userId);
    if (!result.ok) return res.status(result.statusCode).json({ error: result.error });

    res.json({ success: true, connection: result.connection });
  } catch (e) {
    console.error('Website connect error:', e.message);
    res.status(500).json({ error: 'Failed to connect website' });
  }
});

// Read connection status — never returns the encrypted password or any
// decrypted credential to the frontend.
app.get('/api/business/:id/website', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const result = await pool.query(
      `SELECT id, site_url, site_name, wp_version, wp_username, connection_status, last_verified_at, last_error,
       permission_level, automation_mode, connected_at, website_intelligence, website_intelligence_fr,
       website_intelligence_generated_at
       FROM website_connections WHERE business_id = $1`,
      [req.params.id]
    );
    const connection = result.rows[0];

    // Same discipline as Business X-Ray and Business Intelligence: translate
    // ONCE on first French view and cache the result, rather than either
    // showing stale English or burning a fresh, full re-analysis (which
    // could also produce a genuinely different set of findings, not just a
    // different language, since it isn't a translation at that point).
    if (connection && lang === 'fr') {
      if (connection.website_intelligence && !connection.website_intelligence_fr) {
        try {
          const translated = await translateStructuredContent(connection.website_intelligence, 'website intelligence analysis');
          await pool.query('UPDATE website_connections SET website_intelligence_fr = $1 WHERE id = $2', [JSON.stringify(translated), connection.id]);
          connection.website_intelligence_fr = translated;
        } catch (e) {
          console.error('Website Intelligence auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (connection.website_intelligence_fr) connection.website_intelligence = connection.website_intelligence_fr;
    }
    if (connection) delete connection.website_intelligence_fr;

    res.json({ connection: connection || null });
  } catch (e) {
    console.error('Get website connection error:', e.message);
    res.status(500).json({ error: 'Failed to load website connection' });
  }
});

// Re-check an existing connection's health without changing credentials —
// used both by a manual "Refresh" action and could be called from a future
// monitoring sweep to detect a revoked Application Password before the
// person notices their site actions silently failing.
app.post('/api/business/:id/website/verify', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT * FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];

    const decryptedPassword = decryptSecret(connection.wp_app_password_encrypted);
    let verifyRes;
    try {
      verifyRes = await wpApiRequest(connection.site_url, connection.wp_username, decryptedPassword, '/wp/v2/pages?per_page=1&status=any&context=edit', { timeoutMs: 10000 });
    } catch (e) {
      await pool.query(`UPDATE website_connections SET connection_status = 'error', last_error = $1 WHERE id = $2`, [e.message, connection.id]);
      return res.json({ connection_status: 'error', error: e.message });
    }

    if (verifyRes.status === 401) {
      await pool.query(`UPDATE website_connections SET connection_status = 'auth_expired', last_error = 'Credentials no longer valid' WHERE id = $1`, [connection.id]);
      return res.json({ connection_status: 'auth_expired', error: 'This Application Password is no longer valid — it may have been revoked in WordPress. Please reconnect.' });
    }
    if (verifyRes.status === 403) {
      const msg = await buildForbiddenErrorMessage(verifyRes);
      await pool.query(`UPDATE website_connections SET connection_status = 'needs_attention', last_error = $1 WHERE id = $2`, [msg, connection.id]);
      return res.json({ connection_status: 'needs_attention', error: msg });
    }
    if (!verifyRes.ok) {
      await pool.query(`UPDATE website_connections SET connection_status = 'needs_attention', last_error = $1 WHERE id = $2`, [`WordPress returned status ${verifyRes.status}`, connection.id]);
      return res.json({ connection_status: 'needs_attention', error: `WordPress returned an unexpected status (${verifyRes.status}).` });
    }

    await pool.query(`UPDATE website_connections SET connection_status = 'connected', last_verified_at = NOW(), last_error = NULL WHERE id = $1`, [connection.id]);
    res.json({ connection_status: 'connected' });
  } catch (e) {
    console.error('Website verify error:', e.message);
    res.status(500).json({ error: 'Failed to verify website connection' });
  }
});

// Lets the person set the permission tier and automation switch for their
// connection (spec Section 4). Whitelisted rather than accepting any
// string — an invalid value here would otherwise be silently stored and
// could produce unpredictable behavior wherever it's later checked.
const VALID_PERMISSION_LEVELS = ['read_only', 'draft', 'approval_required', 'managed'];
const VALID_AUTOMATION_MODES = ['manual', 'automatic'];
app.put('/api/business/:id/website/permissions', authRequired, async (req, res) => {
  const { permissionLevel, automationMode } = req.body;
  if (permissionLevel && !VALID_PERMISSION_LEVELS.includes(permissionLevel)) {
    return res.status(400).json({ error: 'Invalid permission level' });
  }
  if (automationMode && !VALID_AUTOMATION_MODES.includes(automationMode)) {
    return res.status(400).json({ error: 'Invalid automation mode' });
  }
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT id, permission_level, automation_mode FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];

    const newPermissionLevel = permissionLevel || connection.permission_level;
    const newAutomationMode = automationMode || connection.automation_mode;

    await pool.query(
      'UPDATE website_connections SET permission_level = $1, automation_mode = $2 WHERE id = $3',
      [newPermissionLevel, newAutomationMode, connection.id]
    );

    if (newPermissionLevel !== connection.permission_level || newAutomationMode !== connection.automation_mode) {
      await logWebsiteAudit(connection.id, 'user', req.userId, 'permissions_changed',
        `Permission level set to "${newPermissionLevel}", automation mode set to "${newAutomationMode}"`,
        { previousPermissionLevel: connection.permission_level, newPermissionLevel, previousAutomationMode: connection.automation_mode, newAutomationMode });
    }

    res.json({ success: true, permissionLevel: newPermissionLevel, automationMode: newAutomationMode });
  } catch (e) {
    console.error('Website permissions update error:', e.message);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

app.delete('/api/business/:id/website', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT id, site_url FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });

    await pool.query(`UPDATE website_connections SET connection_status = 'disconnected', disconnected_at = NOW() WHERE id = $1`, [connResult.rows[0].id]);
    await logWebsiteAudit(connResult.rows[0].id, 'user', req.userId, 'disconnected', `Disconnected WordPress site: ${connResult.rows[0].site_url}`, {});
    res.json({ success: true });
  } catch (e) {
    console.error('Website disconnect error:', e.message);
    res.status(500).json({ error: 'Failed to disconnect website' });
  }
});

// Decodes HTML entities generically (named + numeric/hex) rather than a
// hand-picked list of specific replacements — WordPress's own "wptexturize"
// feature automatically converts plain quotes and hyphens into numeric
// entities (e.g. &#8217;) in its rendered output, so this matters more for
// WordPress content specifically than for generic page scraping.
function decodeHtmlEntities(str) {
  if (!str) return '';
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–', lsquo: String.fromCharCode(8216), rsquo: String.fromCharCode(8217),
    ldquo: String.fromCharCode(8220), rdquo: String.fromCharCode(8221), copy: '©', reg: '®', trade: '™'
  };
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(\w+);/g, (m, name) => named[name] !== undefined ? named[name] : m);
}
function wpStripHtml(html) {
  if (!html) return '';
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function wpCountHeadings(html) {
  const counts = {};
  for (let level = 1; level <= 6; level++) {
    const matches = (html || '').match(new RegExp(`<h${level}[ >]`, 'gi'));
    counts[`h${level}`] = matches ? matches.length : 0;
  }
  return counts;
}

// Fetches pages and posts from a connected WordPress site and reduces each
// to the fields actually needed for analysis. Meta description is read
// from Yoast's yoast_head_json field when present — this is NOT
// guaranteed to exist (it depends entirely on the site having Yoast
// installed with its REST integration enabled), and is left null rather
// than assumed whenever it's absent, per the spec's explicit requirement
// not to pretend data exists that the connected site doesn't actually expose.
async function fetchWordPressContent(connection, decryptedPassword) {
  const fetchType = async (type) => {
    const res = await wpApiRequest(
      connection.site_url, connection.wp_username, decryptedPassword,
      `/wp/v2/${type}?per_page=20&status=publish&_fields=id,title,slug,link,excerpt,content,date,yoast_head_json`,
      { timeoutMs: 15000 }
    );
    if (!res.ok) throw new Error(`Could not read ${type} from WordPress (status ${res.status})`);
    const items = await res.json();
    return items.map(item => {
      const rawContent = item.content?.rendered || '';
      const bodyText = wpStripHtml(rawContent);
      return {
        id: item.id,
        title: decodeHtmlEntities(wpStripHtml(item.title?.rendered || '')),
        slug: item.slug,
        url: item.link,
        wordCount: bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0,
        headings: wpCountHeadings(rawContent),
        metaDescription: item.yoast_head_json?.description || null,
        bodyExcerpt: bodyText.slice(0, 500)
      };
    });
  };

  const [pages, posts] = await Promise.all([fetchType('pages'), fetchType('posts')]);
  return { pages, posts };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 / INCREMENT 3 — EXECUTION + VERIFICATION
//
// Two genuinely different reliability profiles, confirmed by research
// before writing this:
//
// - Title updates use POST /wp/v2/{pages|posts}/:id with {title} — WordPress's
//   own documented convention for updating an existing resource, a core
//   WordPress REST API field. This is reliable on any WordPress site
//   regardless of plugins.
//
// - Meta description updates target _yoast_wpseo_metadesc via the meta
//   object. Yoast's own REST surface is READ-ONLY BY DESIGN — a write to
//   this field silently no-ops (the API returns success, but the value is
//   never actually saved) unless the site has specifically registered
//   this meta key with show_in_rest (a custom snippet or third-party
//   plugin, not a default Yoast behavior). Even when a site DOES support
//   this, Yoast's cached "indexable" record can lag behind a direct meta
//   write, so the field appearing to save is not proof it actually took
//   effect on the rendered page.
//
// This is exactly why verification here is not a nice-to-have: after
// every execution, this re-fetches the SAME field used for reading
// (yoast_head_json.description) and compares it against what was
// intended — the only way to honestly distinguish "this WordPress site's
// SEO plugin doesn't support API writes" from "this genuinely worked."
async function executeWebsiteAction(action, connection, decryptedPassword) {
  const wpType = action.target_type === 'post' ? 'posts' : 'pages';
  const change = action.edited_change || action.proposed_change;

  try {
    if (change.title) {
      const res = await wpApiRequest(connection.site_url, connection.wp_username, decryptedPassword, `/wp/v2/${wpType}/${action.target_wp_id}`, {
        method: 'POST', body: { title: change.title }, timeoutMs: 15000
      });
      if (!res.ok) {
        return { executed: false, verified: false, error: `WordPress rejected the update (status ${res.status}).` };
      }
      // Verify against a fresh GET, not the PUT response's echoed value —
      // the echo only confirms what was SENT, not what was actually saved.
      const verifyRes = await wpApiRequest(connection.site_url, connection.wp_username, decryptedPassword, `/wp/v2/${wpType}/${action.target_wp_id}?_fields=title`, { timeoutMs: 10000 });
      if (!verifyRes.ok) return { executed: true, verified: false, error: 'The update was sent, but verification could not confirm it — please check the page manually.' };
      const verifyData = await verifyRes.json();
      const actualTitle = decodeHtmlEntities(wpStripHtml(verifyData.title?.rendered || ''));
      if (actualTitle !== change.title) {
        return { executed: true, verified: false, error: `The update was sent, but the title on the live page still reads "${actualTitle}" — it does not appear to have been saved.` };
      }
      return { executed: true, verified: true };
    }

    if (change.metaDescription) {
      const res = await wpApiRequest(connection.site_url, connection.wp_username, decryptedPassword, `/wp/v2/${wpType}/${action.target_wp_id}`, {
        method: 'POST', body: { meta: { _yoast_wpseo_metadesc: change.metaDescription } }, timeoutMs: 15000
      });
      if (!res.ok) {
        return { executed: false, verified: false, error: `WordPress rejected the update (status ${res.status}).` };
      }
      // context=edit is required to see the raw `meta` object — without
      // it WordPress only returns the rendered/derived fields. Checking
      // BOTH the raw meta value and Yoast's own derived output tells
      // apart two genuinely different problems: if raw meta updated but
      // the derived value didn't, the write itself worked and Yoast's
      // cached "indexable" record just hasn't caught up yet — not
      // something the SEO Bridge plugin can be missing, since that
      // plugin's whole job is exactly the write that DID succeed here.
      const verifyRes = await wpApiRequest(connection.site_url, connection.wp_username, decryptedPassword, `/wp/v2/${wpType}/${action.target_wp_id}?_fields=yoast_head_json,meta&context=edit`, { timeoutMs: 10000 });
      if (!verifyRes.ok) return { executed: true, verified: false, error: 'The update was sent, but verification could not confirm it — please check the page manually.' };
      const verifyData = await verifyRes.json();
      const derivedDescription = verifyData.yoast_head_json?.description || null;
      const rawMetaDescription = verifyData.meta?._yoast_wpseo_metadesc || null;

      if (derivedDescription === change.metaDescription) {
        return { executed: true, verified: true };
      }
      if (rawMetaDescription === change.metaDescription) {
        // The write genuinely succeeded — this is Yoast's own cache
        // lagging, not a permissions problem the SEO Bridge plugin fixes.
        return { executed: true, verified: false, error: 'The update was saved correctly (confirmed in WordPress\'s raw data), but the live page\'s rendered meta description has not caught up yet. This is a known Yoast SEO caching behavior, not a permissions problem — installing the SEO Bridge plugin will not help here. Try refreshing the page directly in a browser, or wait a few minutes and check again; the underlying data is correct.' };
      }
      return { executed: true, verified: false, error: 'The update was sent and WordPress accepted it, but the meta description on the live page did not change. This WordPress site\'s SEO plugin does not allow meta description updates via the API by default — go to the Website page and download the "Arreyon SEO REST Bridge" plugin, then install AND ACTIVATE it on this site (installing alone is not enough — it must show "Active" on the Plugins page) to fix this.' };
    }

    return { executed: false, verified: false, error: 'This proposed change has no recognized field to update.' };
  } catch (e) {
    if (e.message.includes('401')) {
      return { executed: false, verified: false, error: 'This Application Password is no longer valid. Please reconnect your website.', authExpired: true };
    }
    return { executed: false, verified: false, error: e.message || 'Failed to execute this change.' };
  }
}

// Generate read-only Website Intelligence — structure, SEO, and content
// observations. The AI is explicitly instructed to separate "measured"
// facts (directly present in the fetched page data — word counts, heading
// presence, meta description presence) from "assessed" judgments (its own
// opinion on quality) — this is the same observed/inferred discipline
// already used for business-fact extraction elsewhere in the platform,
// applied here because the spec is explicit that scores must never be
// fabricated and measured data must stay visibly distinct from AI opinion.
app.post('/api/business/:id/website/intelligence', authRequired, async (req, res) => {
  const language = req.body?.language === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id, name FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT * FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];
    if (connection.connection_status === 'disconnected') return res.status(400).json({ error: 'This website is disconnected. Please reconnect it first.' });

    const decryptedPassword = decryptSecret(connection.wp_app_password_encrypted);
    let pages, posts;
    try {
      ({ pages, posts } = await fetchWordPressContent(connection, decryptedPassword));
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('status 401')) {
        await pool.query(`UPDATE website_connections SET connection_status = 'auth_expired' WHERE id = $1`, [connection.id]);
        return res.status(400).json({ error: 'This Application Password is no longer valid. Please reconnect your website.' });
      }
      throw e;
    }

    if (!pages.length && !posts.length) {
      return res.status(400).json({ error: 'No published pages or posts were found on this website to analyze.' });
    }

    const pagesSummary = pages.map(p => `PAGE: "${p.title}" (${p.url})\n  Word count: ${p.wordCount} | Headings: ${JSON.stringify(p.headings)} | Meta description: ${p.metaDescription ? `"${p.metaDescription}"` : 'NOT DETECTED (may not exist, or the connected site may not expose it)'}\n  Excerpt: ${p.bodyExcerpt}`).join('\n\n');
    const postsSummary = posts.map(p => `POST: "${p.title}" (${p.url}, ${p.date || ''})\n  Word count: ${p.wordCount} | Headings: ${JSON.stringify(p.headings)} | Meta description: ${p.metaDescription ? `"${p.metaDescription}"` : 'NOT DETECTED (may not exist, or the connected site may not expose it)'}\n  Excerpt: ${p.bodyExcerpt}`).join('\n\n');

    const businessName = biz.rows[0].name || 'this business';

    const prompt = `You are a website intelligence analyst reviewing a WordPress site for ${businessName}. You have been given REAL, MEASURED data fetched directly from the site's own content — word counts, heading structure, and meta description presence are all FACTS, not your opinion. Your job is to add ASSESSMENT on top of these facts, and you must keep the two clearly separate.

MEASURED DATA — PAGES (${pages.length} found):
${pagesSummary || 'None found.'}

MEASURED DATA — POSTS (${posts.length} found):
${postsSummary || 'None found.'}

CRITICAL RULES:
- Every issue you list must reference something ACTUALLY PRESENT in the measured data above (a specific page/post, an actual word count, an actual missing meta description) — never invent a page, a number, or an issue not grounded in what's shown.
- Do NOT invent an overall numeric "website score." Scores are not requested and must not be fabricated.
- "NOT DETECTED" for a meta description means the site's REST API did not expose one — this could mean it genuinely doesn't have one, OR that the connected site simply doesn't expose that data (e.g. no SEO plugin, or one not integrated with the REST API). State this honestly rather than assuming the description is missing.
- Thin content threshold: treat under 300 words as a genuine content-depth concern worth flagging; do not flag naturally short pages (e.g. a simple contact page) as broken just for being short.
- This site may have more pages/posts than can be covered individually — use ALL of the measured data above to inform your structure_summary and to pick the most important findings, but limit your output to AT MOST 15 seo_issues, 10 content_observations, and 8 recommendations, prioritizing the most significant, highest-severity findings. Do not attempt one entry per page/post — a bounded, prioritized list is required, not a note-by-note walkthrough of everything.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "structure_summary": "2-3 sentences on what this site actually consists of (page count, post count, general shape) — factual, not evaluative",
  "seo_issues": [
    { "page_title": "exact title from the measured data above", "url": "exact url from the measured data", "issue": "specific, concrete issue (e.g. missing meta description, no H1, thin content at N words)", "severity": "high" | "medium" | "low" }
  ],
  "content_observations": [
    { "page_title": "exact title from the measured data", "observation": "one honest, specific observation about this page's content — thin, outdated-sounding, well-developed, etc." }
  ],
  "recommendations": [
    { "title": "short, specific action title", "description": "1-2 sentences on what to do and why", "priority": "high" | "medium" | "low" }
  ],
  "data_limitations_note": "one honest sentence on what this analysis could NOT see (e.g. no SEO plugin data was exposed by this site, so on-page meta description completeness could not be fully assessed) — if the site has more pages/posts than fit in the 15/10/8 limits above, mention that here too, so the person knows the list is prioritized, not exhaustive"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Provide the Website Intelligence analysis now, as JSON only.' }], complexity: 'complex', context: { feature: 'website_intelligence', userId: req.userId }, maxTokens: 8000 });

    let intelligence;
    try {
      intelligence = extractJSON(raw);
    } catch (e) {
      // A cut-off response (the AI's JSON stopping mid-structure, most
      // likely from running out of the token budget on a site with many
      // pages/posts) looks very different from genuinely malformed JSON —
      // this distinction is real, useful evidence rather than a guess,
      // and is included directly so a repeat failure doesn't need another
      // round of blind troubleshooting.
      const looksTruncated = !raw.trim().endsWith('}') && !raw.trim().endsWith('```');
      console.error('Website Intelligence JSON parse failed:', e.message, '| Response length:', raw.length, '| Looks truncated:', looksTruncated);
      throw new Error(`Could not generate Website Intelligence — the AI's response could not be read as valid data${looksTruncated ? ' (it appears to have been cut off before finishing, likely because this site has more pages/posts than fit in the response — please try again, or try a business with fewer connected pages)' : ' (please try again)'}.`);
    }
    if (!Array.isArray(intelligence.seo_issues) || !Array.isArray(intelligence.recommendations)) {
      console.error('Website Intelligence missing required arrays. Keys present:', Object.keys(intelligence));
      throw new Error(`Could not generate Website Intelligence — the response was missing required data (got: ${Object.keys(intelligence).join(', ') || 'nothing'}). Please try again.`);
    }

    // Defensive cap alongside the prompt instruction above — a prompt
    // instruction is a soft constraint the AI might not always follow
    // exactly, so this guarantees the response never balloons even if it
    // occasionally lists more than asked.
    intelligence.seo_issues = intelligence.seo_issues.slice(0, 15);
    if (Array.isArray(intelligence.content_observations)) intelligence.content_observations = intelligence.content_observations.slice(0, 10);
    intelligence.recommendations = intelligence.recommendations.slice(0, 8);

    // Real, measured counts are stored alongside the AI's assessment —
    // computed here in code, not asked of the AI, so these specific
    // numbers can never be a fabrication risk.
    intelligence.measured = {
      pageCount: pages.length,
      postCount: posts.length,
      pagesWithNoMetaDescription: pages.filter(p => !p.metaDescription).length,
      postsWithNoMetaDescription: posts.filter(p => !p.metaDescription).length,
      pagesUnder300Words: pages.filter(p => p.wordCount < 300).length,
      postsUnder300Words: posts.filter(p => p.wordCount < 300).length
    };

    await pool.query(
      `UPDATE website_connections SET website_intelligence = $1, website_intelligence_fr = NULL, website_intelligence_generated_at = NOW() WHERE id = $2`,
      [JSON.stringify(intelligence), connection.id]
    );

    await logWebsiteAudit(connection.id, 'ai_agent', null, 'intelligence_generated', `Generated Website Intelligence (${pages.length} pages, ${posts.length} posts analyzed)`, { pageCount: pages.length, postCount: posts.length });

    res.json({ intelligence, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Website Intelligence error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate Website Intelligence. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 8 / INCREMENT 2 — APPROVAL WORKFLOW
//
// The SEO Agent's first concrete capability: proposing meta title/description
// improvements for pages and posts that genuinely have a real, measured gap
// (missing description, or a generic/weak title) — never inventing an issue
// that doesn't exist in the actual fetched data. Uses the same real business
// context (industry, positioning, etc.) other AI features already use,
// rather than treating the website as an isolated object, per the spec's
// explicit Business Workspace integration requirement.
//
// Proposing a change is allowed at any permission level — it's read-only
// analysis plus an AI suggestion, nothing is written to WordPress. The
// permission tier is enforced at APPROVAL time instead (below), since
// approval is the point where the person is expressing real intent to
// eventually publish something.
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/business/:id/website/seo-proposals', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const context = await getBusinessContext(req.params.id, account.id);
    if (!context) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT * FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];
    if (connection.connection_status === 'disconnected') return res.status(400).json({ error: 'This website is disconnected. Please reconnect it first.' });

    const decryptedPassword = decryptSecret(connection.wp_app_password_encrypted);
    let pages, posts;
    try {
      ({ pages, posts } = await fetchWordPressContent(connection, decryptedPassword));
    } catch (e) {
      if (e.message.includes('401')) {
        await pool.query(`UPDATE website_connections SET connection_status = 'auth_expired' WHERE id = $1`, [connection.id]);
        return res.status(400).json({ error: 'This Application Password is no longer valid. Please reconnect your website.' });
      }
      throw e;
    }

    // Only pages/posts with a REAL, measured gap qualify — a missing meta
    // description, or a title that's just the site/page name with no real
    // content (a genuine weak-title heuristic, not an AI opinion at this
    // filtering stage).
    const genericTitlePattern = /^(home|untitled|page \d+|post \d+)$/i;
    const candidates = [...pages, ...posts.map(p => ({ ...p, isPost: true }))].filter(item =>
      !item.metaDescription || genericTitlePattern.test(item.title.trim())
    );

    if (!candidates.length) {
      return res.json({ proposals: [], message: 'No meta title or description gaps were found — nothing to propose right now.' });
    }

    const contextSummary = summarizeBusinessContextForAI(context) || 'No detailed context is available for this business yet.';
    // Capped once, at the source — both the prompt shown to the AI and the
    // index lookup below reference this exact same list, so an index the
    // AI returns can never accidentally resolve to a candidate it was
    // never actually shown.
    const cappedCandidates = candidates.slice(0, 15);
    const candidatesSummary = cappedCandidates.map((c, i) => `[${i}] ${c.isPost ? 'POST' : 'PAGE'}: "${c.title}" (${c.url})\n  Current meta description: ${c.metaDescription ? `"${c.metaDescription}"` : 'MISSING'}\n  Content excerpt: ${c.bodyExcerpt}`).join('\n\n');

    const prompt = `You are an SEO Agent proposing meta title and description improvements for a real business's WordPress site. You must ONLY propose a change for pages that genuinely need one — every candidate listed below already has a real, measured gap (missing description or a generic title), so you don't need to invent reasons; you need to write GOOD, SPECIFIC suggestions grounded in the actual page content and the real business context.
${contextSummary}

PAGES/POSTS NEEDING ATTENTION:
${candidatesSummary}

For EACH numbered item above, propose a suggested_title (only if the current title is genuinely generic/weak — otherwise leave suggested_title null) and a suggested_meta_description (a specific, compelling 120-155 character description grounded in that page's actual content, not generic boilerplate). Reference the actual business name/industry from the context above where it genuinely fits — never invent details about the business that aren't in the context.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "proposals": [
    { "index": 0, "suggested_title": "specific improved title, or null if the current title is already fine", "suggested_meta_description": "specific 120-155 char description grounded in this page's actual content", "reasoning": "1 sentence on why this specific change helps" }
  ]
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction('en', { jsonMode: true }), messages: [{ role: 'user', content: 'Provide the SEO proposals now, as JSON only.' }], complexity: 'complex', context: { feature: 'website_seo_proposals', userId: req.userId }, maxTokens: 4000 });

    let result;
    try {
      result = extractJSON(raw);
    } catch (e) {
      const looksTruncated = !raw.trim().endsWith('}') && !raw.trim().endsWith('```');
      console.error('SEO proposals JSON parse failed:', e.message, '| Response length:', raw.length, '| Looks truncated:', looksTruncated);
      throw new Error(`Could not generate SEO proposals — the AI's response could not be read as valid data${looksTruncated ? ' (it appears to have been cut off before finishing — please try again)' : ' (please try again)'}.`);
    }
    if (!Array.isArray(result.proposals)) throw new Error(`Could not generate SEO proposals — the response was missing required data (got: ${Object.keys(result).join(', ') || 'nothing'}). Please try again.`);
    result.proposals = result.proposals.slice(0, 15);

    // Explicit risk classification, not an assumption — both current
    // action types are non-destructive text changes. A future action type
    // (e.g. deleting content, changing settings) must be added here
    // deliberately as 'high' risk, never inherit 'low' by default, so
    // Managed + Automatic can never auto-execute something destructive —
    // that safety rule the spec requires stays true regardless of what
    // later increments add.
    const ACTION_RISK = { update_meta_title: 'low', update_meta_description: 'low' };
    const autoExecuteEligible = connection.permission_level === 'managed' && connection.automation_mode === 'automatic';

    const insertedProposals = [];
    for (const p of result.proposals) {
      const candidate = cappedCandidates[p.index];
      if (!candidate) continue; // AI referenced an index outside the real candidate list — skip rather than guess
      if (!p.suggested_title && !p.suggested_meta_description) continue; // nothing actually proposed for this one

      const actionType = p.suggested_title ? 'update_meta_title' : 'update_meta_description';
      const previousState = { title: candidate.title, metaDescription: candidate.metaDescription };
      const proposedChange = {};
      if (p.suggested_title) proposedChange.title = p.suggested_title;
      if (p.suggested_meta_description) proposedChange.metaDescription = p.suggested_meta_description;

      const inserted = await pool.query(
        `INSERT INTO website_actions (website_connection_id, ai_agent, action_type, target_type, target_wp_id, target_url, target_title, previous_state, proposed_change, reasoning)
         VALUES ($1, 'seo_agent', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [connection.id, actionType, candidate.isPost ? 'post' : 'page', candidate.id, candidate.url, candidate.title, JSON.stringify(previousState), JSON.stringify(proposedChange), p.reasoning || null]
      );
      let action = inserted.rows[0];

      if (autoExecuteEligible && ACTION_RISK[actionType] === 'low') {
        await pool.query(`UPDATE website_actions SET approval_status = 'approved', reviewed_at = NOW() WHERE id = $1`, [action.id]);
        await logWebsiteAudit(connection.id, 'system', null, 'proposal_auto_approved', `Auto-approved under Managed/Automatic settings: ${actionType} for "${candidate.title}"`, { actionId: action.id });

        const decryptedPassword = decryptSecret(connection.wp_app_password_encrypted);
        const execResult = await executeWebsiteAction({ ...action, approval_status: 'approved' }, connection, decryptedPassword);
        const executionStatus = execResult.executed ? 'executed' : 'execution_failed';
        const verificationStatus = execResult.executed ? (execResult.verified ? 'verified' : 'verification_failed') : null;

        const updated = await pool.query(
          `UPDATE website_actions SET approval_status = 'approved', execution_status = $1, verification_status = $2, error_message = $3 WHERE id = $4 RETURNING *`,
          [executionStatus, verificationStatus, execResult.error || null, action.id]
        );
        action = updated.rows[0];

        await logWebsiteAudit(connection.id, 'system', null,
          execResult.verified ? 'change_executed_and_verified' : 'change_execution_issue',
          `Auto-executed ${actionType} for "${candidate.title}": ${executionStatus}, verification ${verificationStatus || 'n/a'}`,
          { actionId: action.id, executionStatus, verificationStatus, error: execResult.error });
      }

      insertedProposals.push(action);
    }

    const autoExecutedCount = insertedProposals.filter(a => a.execution_status === 'executed').length;
    const pendingCount = insertedProposals.length - autoExecutedCount;
    await logWebsiteAudit(connection.id, 'ai_agent', null, 'proposals_generated',
      `SEO Agent generated ${insertedProposals.length} proposal(s)` + (autoExecutedCount ? ` — ${autoExecutedCount} auto-executed under Managed/Automatic settings, ${pendingCount} awaiting approval` : ' awaiting approval'),
      { count: insertedProposals.length, autoExecutedCount, pendingCount });

    res.json({ proposals: insertedProposals });
  } catch (err) {
    console.error('SEO proposals error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate SEO proposals. Please try again.' });
  }
});

app.get('/api/business/:id/website/actions', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT id FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.json({ actions: [] });

    const actions = await pool.query(
      'SELECT * FROM website_actions WHERE website_connection_id = $1 ORDER BY created_at DESC LIMIT 50',
      [connResult.rows[0].id]
    );
    res.json({ actions: actions.rows });
  } catch (e) {
    console.error('Get website actions error:', e.message);
    res.status(500).json({ error: 'Failed to load proposed changes' });
  }
});

// Approving requires the connection to be at least "draft" tier — approval
// expresses real intent to eventually publish, which read_only explicitly
// should never allow (spec Section 4). editedChange lets the person adjust
// the AI's suggestion before approving it (spec's explicit "Preview,
// Approve, Reject, Edit" requirement) — the edit itself is what gets
// approved, not silently discarded in favor of the original.
app.post('/api/business/:id/website/actions/:actionId/approve', authRequired, async (req, res) => {
  const { editedChange } = req.body || {};
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT id, permission_level FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];

    if (connection.permission_level === 'read_only') {
      return res.status(403).json({ error: 'This website is set to Read Only, which does not allow approving changes. Change the permission level first if you want to allow this.' });
    }

    const actionResult = await pool.query('SELECT id, approval_status FROM website_actions WHERE id = $1 AND website_connection_id = $2', [req.params.actionId, connection.id]);
    if (!actionResult.rows.length) return res.status(404).json({ error: 'Proposed change not found' });
    if (actionResult.rows[0].approval_status !== 'pending') return res.status(400).json({ error: 'This proposal has already been reviewed.' });

    const updated = await pool.query(
      `UPDATE website_actions SET approval_status = 'approved', edited_change = $1, reviewed_by = $2, reviewed_at = NOW() WHERE id = $3 RETURNING *`,
      [editedChange ? JSON.stringify(editedChange) : null, req.userId, req.params.actionId]
    );

    await logWebsiteAudit(connection.id, 'user', req.userId, 'proposal_approved', `Approved proposed change: ${updated.rows[0].action_type} for "${updated.rows[0].target_title}"`, { actionId: updated.rows[0].id, wasEdited: !!editedChange });

    res.json({ success: true, action: updated.rows[0] });
  } catch (e) {
    console.error('Approve website action error:', e.message);
    res.status(500).json({ error: 'Failed to approve change' });
  }
});

// Requires prior approval — the execution layer independently enforces
// this rather than trusting that an action reaching this endpoint is
// automatically safe to run. Re-checks the connection's CURRENT
// permission_level live (not whatever it was at approval time), since
// the person may have changed it in between.
app.post('/api/business/:id/website/actions/:actionId/execute', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT * FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });
    const connection = connResult.rows[0];

    if (connection.permission_level === 'read_only') {
      return res.status(403).json({ error: 'This website is set to Read Only, which does not allow executing changes.' });
    }
    if (connection.connection_status === 'disconnected') {
      return res.status(400).json({ error: 'This website is disconnected. Please reconnect it first.' });
    }

    const actionResult = await pool.query('SELECT * FROM website_actions WHERE id = $1 AND website_connection_id = $2', [req.params.actionId, connection.id]);
    if (!actionResult.rows.length) return res.status(404).json({ error: 'Proposed change not found' });
    const action = actionResult.rows[0];

    if (action.approval_status !== 'approved') {
      return res.status(400).json({ error: 'This change must be approved before it can be executed.' });
    }
    if (action.execution_status === 'executed') {
      return res.status(400).json({ error: 'This change has already been executed.' });
    }

    const decryptedPassword = decryptSecret(connection.wp_app_password_encrypted);
    const result = await executeWebsiteAction(action, connection, decryptedPassword);

    if (result.authExpired) {
      await pool.query(`UPDATE website_connections SET connection_status = 'auth_expired' WHERE id = $1`, [connection.id]);
    }

    const executionStatus = result.executed ? 'executed' : 'execution_failed';
    const verificationStatus = result.executed ? (result.verified ? 'verified' : 'verification_failed') : null;

    const updated = await pool.query(
      `UPDATE website_actions SET execution_status = $1, verification_status = $2, error_message = $3 WHERE id = $4 RETURNING *`,
      [executionStatus, verificationStatus, result.error || null, action.id]
    );

    await logWebsiteAudit(connection.id, 'system', req.userId,
      result.verified ? 'change_executed_and_verified' : 'change_execution_issue',
      `${action.action_type} for "${action.target_title}": execution ${executionStatus}, verification ${verificationStatus || 'n/a'}`,
      { actionId: action.id, executionStatus, verificationStatus, error: result.error });

    res.json({ success: result.executed && result.verified, action: updated.rows[0], error: result.error });
  } catch (e) {
    console.error('Execute website action error:', e.message);
    res.status(500).json({ error: 'Failed to execute change' });
  }
});

app.post('/api/business/:id/website/actions/:actionId/reject', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const connResult = await pool.query('SELECT id FROM website_connections WHERE business_id = $1', [req.params.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'No website connected' });

    const actionResult = await pool.query('SELECT id, approval_status, action_type, target_title FROM website_actions WHERE id = $1 AND website_connection_id = $2', [req.params.actionId, connResult.rows[0].id]);
    if (!actionResult.rows.length) return res.status(404).json({ error: 'Proposed change not found' });
    if (actionResult.rows[0].approval_status !== 'pending') return res.status(400).json({ error: 'This proposal has already been reviewed.' });

    await pool.query(`UPDATE website_actions SET approval_status = 'rejected', reviewed_by = $1, reviewed_at = NOW() WHERE id = $2`, [req.userId, req.params.actionId]);
    await logWebsiteAudit(connResult.rows[0].id, 'user', req.userId, 'proposal_rejected', `Rejected proposed change: ${actionResult.rows[0].action_type} for "${actionResult.rows[0].target_title}"`, { actionId: req.params.actionId });

    res.json({ success: true });
  } catch (e) {
    console.error('Reject website action error:', e.message);
    res.status(500).json({ error: 'Failed to reject change' });
  }
});


// Pulls together what already exists across the platform for one business
// into a single view — this endpoint generates nothing itself, it only
// reports on what's already been generated elsewhere, so a business with
// nothing built out yet correctly shows everything as "not yet generated."
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/business/:id/reports-center', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query(
      `SELECT id, name, intelligence_generated_at, market_context_generated_at,
         marketing_strategy_generated_at, content_calendar_generated_at,
         funding_readiness_generated_at, pitch_deck_generated_at
       FROM businesses WHERE id = $1 AND user_id = $2`,
      [req.params.id, account.id]
    );
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];

    const factsCountRow = await pool.query(
      'SELECT COUNT(*), MAX(created_at) AS latest FROM business_facts WHERE business_id = $1',
      [req.params.id]
    );
    const hasFacts = parseInt(factsCountRow.rows[0].count, 10) > 0;

    const latestResearchRow = await pool.query(
      'SELECT created_at FROM research_sessions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );

    const latestPlanRow = await pool.query(
      `SELECT created_at FROM entrepreneur_sessions WHERE business_id = $1 AND business_plan IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [req.params.id]
    );

    const reports = [
      { key: 'business_report', generatedAt: hasFacts ? factsCountRow.rows[0].latest : null },
      { key: 'business_intelligence', generatedAt: business.intelligence_generated_at },
      { key: 'market_context', generatedAt: business.market_context_generated_at },
      { key: 'market_research', generatedAt: latestResearchRow.rows[0]?.created_at || null },
      { key: 'marketing_strategy', generatedAt: business.marketing_strategy_generated_at },
      { key: 'content_calendar', generatedAt: business.content_calendar_generated_at },
      { key: 'business_plan', generatedAt: latestPlanRow.rows[0]?.created_at || null },
      { key: 'funding_readiness', generatedAt: business.funding_readiness_generated_at },
      { key: 'pitch_deck', generatedAt: business.pitch_deck_generated_at }
    ];

    res.json({ businessName: business.name, reports });
  } catch (err) {
    console.error('Reports Center error:', err.message);
    res.status(500).json({ error: 'Failed to load Reports Center. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE ANALYTICS INTEGRATION
// A separate OAuth flow from login — requesting read-only Analytics access
// for an already-logged-in user, not authenticating them. Reuses the same
// Google Cloud OAuth client (GOOGLE_CLIENT_ID/SECRET) as login, but with a
// different scope and callback URL. Requires the Google Analytics Data API
// (and Admin API, for listing properties) to be enabled on that same Google
// Cloud project, and this callback URL added to its authorized redirect URIs
// — both are one-time setup steps in Google Cloud Console, not something
// this server can do on its own.
// ═══════════════════════════════════════════════════════════════════════════

const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const GA_CALLBACK_URL = `${BASE_URL}/api/integrations/google-analytics/callback`;

app.get('/api/integrations/google-analytics/connect', authRequired, async (req, res) => {
  const account = await resolveAccount(req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can connect integrations' });

  // Encode the owner's ID into state so the callback knows who this is for —
  // this request is opened as a full page redirect, not a fetch, so there's
  // no other way to carry that context through Google's OAuth round-trip.
  const state = jwt.sign({ ownerId: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GA_CALLBACK_URL,
    response_type: 'code',
    scope: GA_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/integrations/google-analytics/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?section=integrations&error=ga_connect_failed');

  let ownerId;
  try {
    ownerId = jwt.verify(state, JWT_SECRET).ownerId;
  } catch (e) {
    return res.redirect('/dashboard?section=integrations&error=ga_connect_failed');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GA_CALLBACK_URL,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error('GA token exchange failed:', tokenData);
      return res.redirect('/dashboard?section=integrations&error=ga_connect_failed');
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    await pool.query(
      `INSERT INTO google_analytics_connections (owner_id, access_token, refresh_token, token_expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) DO UPDATE SET access_token = $2, refresh_token = $3, token_expires_at = $4, connected_at = NOW()`,
      [ownerId, tokenData.access_token, tokenData.refresh_token, expiresAt]
    );

    res.redirect('/dashboard?section=integrations&connected=google-analytics');
  } catch (e) {
    console.error('GA callback error:', e.message);
    res.redirect('/dashboard?section=integrations&error=ga_connect_failed');
  }
});

// Refreshes the access token if it's expired (or close to it), returns a
// valid access token ready to use. Google access tokens last ~1 hour;
// refresh tokens are long-lived and reused indefinitely.
async function getValidGAAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) return connection.access_token; // still valid for 5+ more minutes

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: connection.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Failed to refresh Google Analytics access token: ' + (tokenData.error || tokenRes.status));

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
  await pool.query('UPDATE google_analytics_connections SET access_token = $1, token_expires_at = $2 WHERE id = $3',
    [tokenData.access_token, newExpiresAt, connection.id]);

  return tokenData.access_token;
}

app.get('/api/integrations/google-analytics/status', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query('SELECT id, ga_account_name, property_id, property_name, connected_at, last_synced_at FROM google_analytics_connections WHERE owner_id = $1', [account.id]);
    if (!result.rows.length) return res.json({ connected: false });
    res.json({ connected: true, ...result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed to load integration status' }); }
});

app.get('/api/integrations/google-analytics/properties', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM google_analytics_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Google Analytics is not connected' });
    const connection = connResult.rows[0];

    const accessToken = await getValidGAAccessToken(connection);
    const accountSummariesRes = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const summaries = await accountSummariesRes.json();
    if (!accountSummariesRes.ok) throw new Error(summaries.error?.message || 'Failed to list Analytics properties');

    const properties = [];
    (summaries.accountSummaries || []).forEach(acc => {
      (acc.propertySummaries || []).forEach(p => {
        properties.push({ propertyId: p.property.replace('properties/', ''), propertyName: p.displayName, accountName: acc.displayName });
      });
    });

    res.json({ properties });
  } catch (e) {
    console.error('GA properties error:', e.message);
    res.status(500).json({ error: 'Failed to load Analytics properties. Try reconnecting Google Analytics.' });
  }
});

app.put('/api/integrations/google-analytics/property', authRequired, async (req, res) => {
  const { propertyId, propertyName, accountName } = req.body;
  if (!propertyId) return res.status(400).json({ error: 'Property ID is required' });
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    const result = await pool.query(
      'UPDATE google_analytics_connections SET property_id = $1, property_name = $2, ga_account_name = $3 WHERE owner_id = $4 RETURNING id',
      [propertyId, propertyName || null, accountName || null, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Google Analytics is not connected' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save selected property' }); }
});

app.delete('/api/integrations/google-analytics', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    await pool.query('DELETE FROM google_analytics_connections WHERE owner_id = $1', [account.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disconnect' }); }
});

// Fetches real metrics from the GA4 Data API for the given date range —
// sessions, users, conversions, bounce rate, top traffic source.
async function fetchGAMetrics(connection, days = 30) {
  const accessToken = await getValidGAAccessToken(connection);
  const body = {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'today' }],
    metrics: [
      { name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' },
      { name: 'bounceRate' }, { name: 'averageSessionDuration' }
    ],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 1
  };

  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${connection.property_id}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Failed to fetch Analytics data');

  const row = data.rows?.[0];
  if (!row) return { sessions: 0, users: 0, conversions: 0, conversionRate: 0, bounceRate: 0, avgSessionDurationSec: 0, topSource: null };

  const sessions = parseInt(row.metricValues[0].value, 10) || 0;
  const users = parseInt(row.metricValues[1].value, 10) || 0;
  const conversions = parseInt(row.metricValues[2].value, 10) || 0;
  const bounceRate = parseFloat(row.metricValues[3].value) || 0;
  const avgSessionDurationSec = Math.round(parseFloat(row.metricValues[4].value) || 0);
  const topSource = row.dimensionValues[0].value;
  const conversionRate = sessions > 0 ? round2((conversions / sessions) * 100) : 0;

  return { sessions, users, conversions, conversionRate, bounceRate: round2(bounceRate * 100), avgSessionDurationSec, topSource };
}

app.get('/api/integrations/google-analytics/metrics', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM google_analytics_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Google Analytics is not connected' });
    const connection = connResult.rows[0];
    if (!connection.property_id) return res.status(400).json({ error: 'No Analytics property selected yet' });

    const metrics = await fetchGAMetrics(connection, 30);

    // Save today's snapshot for trend charts and for the monitoring system to
    // compare against later — harmless if called more than once today.
    await pool.query(
      `INSERT INTO analytics_snapshots (connection_id, snapshot_date, sessions, users, conversions, conversion_rate, bounce_rate, avg_session_duration_sec, top_source, raw_data)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (connection_id, snapshot_date) DO UPDATE SET sessions = $2, users = $3, conversions = $4, conversion_rate = $5, bounce_rate = $6, avg_session_duration_sec = $7, top_source = $8, raw_data = $9`,
      [connection.id, metrics.sessions, metrics.users, metrics.conversions, metrics.conversionRate, metrics.bounceRate, metrics.avgSessionDurationSec, metrics.topSource, JSON.stringify(metrics)]
    );
    await pool.query('UPDATE google_analytics_connections SET last_synced_at = NOW() WHERE id = $1', [connection.id]);

    res.json({ metrics, propertyName: connection.property_name });
  } catch (e) {
    console.error('GA metrics error:', e.message);
    res.status(500).json({ error: 'Failed to load Analytics metrics. Try reconnecting Google Analytics.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GOOGLE SEARCH CONSOLE — same Google Cloud OAuth client (GOOGLE_CLIENT_ID/
// SECRET) as Google Analytics, but its own scope and callback URL. Requires
// the Search Console API enabled on that same Google Cloud project, and
// this callback URL added to its authorized redirect URIs — both one-time
// setup steps in Google Cloud Console this server cannot do on its own.
// One connection per Arreyon account, owned and managed by the account
// owner only, shared by the whole team — deliberately not per-team-member.
// ═══════════════════════════════════════════════════════════════════════════

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_CALLBACK_URL = `${BASE_URL}/api/integrations/google-search-console/callback`;

app.get('/api/integrations/google-search-console/connect', authRequired, async (req, res) => {
  const account = await resolveAccount(req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can connect integrations' });

  const state = jwt.sign({ ownerId: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GSC_CALLBACK_URL,
    response_type: 'code',
    scope: GSC_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/integrations/google-search-console/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?section=integrations&error=gsc_connect_failed');

  let ownerId;
  try {
    ownerId = jwt.verify(state, JWT_SECRET).ownerId;
  } catch (e) {
    return res.redirect('/dashboard?section=integrations&error=gsc_connect_failed');
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: GSC_CALLBACK_URL,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error('GSC token exchange failed:', tokenData);
      return res.redirect('/dashboard?section=integrations&error=gsc_connect_failed');
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    await pool.query(
      `INSERT INTO google_search_console_connections (owner_id, access_token, refresh_token, token_expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (owner_id) DO UPDATE SET access_token = $2, refresh_token = $3, token_expires_at = $4, connected_at = NOW()`,
      [ownerId, tokenData.access_token, tokenData.refresh_token, expiresAt]
    );

    res.redirect('/dashboard?section=integrations&connected=google-search-console');
  } catch (e) {
    console.error('GSC callback error:', e.message);
    res.redirect('/dashboard?section=integrations&error=gsc_connect_failed');
  }
});

async function getValidGSCAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) return connection.access_token;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: connection.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Failed to refresh Google Search Console access token: ' + (tokenData.error || tokenRes.status));

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
  await pool.query('UPDATE google_search_console_connections SET access_token = $1, token_expires_at = $2 WHERE id = $3',
    [tokenData.access_token, newExpiresAt, connection.id]);

  return tokenData.access_token;
}

app.get('/api/integrations/google-search-console/status', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query('SELECT id, site_url, connected_at, last_synced_at FROM google_search_console_connections WHERE owner_id = $1', [account.id]);
    if (!result.rows.length) return res.json({ connected: false });
    res.json({ connected: true, ...result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed to load integration status' }); }
});

app.get('/api/integrations/google-search-console/sites', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM google_search_console_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Google Search Console is not connected' });
    const connection = connResult.rows[0];

    const accessToken = await getValidGSCAccessToken(connection);
    const sitesRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await sitesRes.json();
    if (!sitesRes.ok) throw new Error(data.error?.message || 'Failed to list Search Console sites');

    const sites = (data.siteEntry || []).map(s => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
    res.json({ sites });
  } catch (e) {
    console.error('GSC sites error:', e.message);
    res.status(500).json({ error: 'Failed to load Search Console sites. Try reconnecting Google Search Console.' });
  }
});

app.put('/api/integrations/google-search-console/site', authRequired, async (req, res) => {
  const { siteUrl } = req.body;
  if (!siteUrl) return res.status(400).json({ error: 'Site URL is required' });
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    const result = await pool.query(
      'UPDATE google_search_console_connections SET site_url = $1 WHERE owner_id = $2 RETURNING id',
      [siteUrl, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Google Search Console is not connected' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save selected site' }); }
});

app.delete('/api/integrations/google-search-console', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    await pool.query('DELETE FROM google_search_console_connections WHERE owner_id = $1', [account.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disconnect' }); }
});

// Search Console data typically lags 2-3 days behind real-time — querying
// through "today" risks an incomplete or empty final day skewing the
// report, so the window ends 3 days back instead.
function getGSCDateRange(days = 28) {
  const end = new Date();
  end.setDate(end.getDate() - 3);
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchGSCMetrics(connection, days = 28) {
  const accessToken = await getValidGSCAccessToken(connection);
  const { startDate, endDate } = getGSCDateRange(days);

  // Overall totals first — no dimension breakdown, matching the same
  // "one aggregate summary" shape the Analytics metrics call returns.
  const totalsRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.site_url)}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate, endDate })
  });
  const totalsData = await totalsRes.json();
  if (!totalsRes.ok) throw new Error(totalsData.error?.message || 'Failed to fetch Search Console data');

  const totalsRow = totalsData.rows?.[0];
  const clicks = totalsRow ? Math.round(totalsRow.clicks) : 0;
  const impressions = totalsRow ? Math.round(totalsRow.impressions) : 0;
  const ctr = totalsRow ? round2(totalsRow.ctr * 100) : 0;
  const avgPosition = totalsRow ? round2(totalsRow.position) : 0;

  // Top query by clicks — the one piece of genuinely distinctive GSC data
  // worth surfacing alongside the totals.
  let topQuery = null;
  try {
    const queryRes = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(connection.site_url)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit: 1 })
    });
    const queryData = await queryRes.json();
    if (queryRes.ok) topQuery = queryData.rows?.[0]?.keys?.[0] || null;
  } catch (e) {
    // Non-fatal — the overall totals above are the primary data; a missing
    // top query just means that one extra detail isn't shown.
  }

  return { clicks, impressions, ctr, avgPosition, topQuery, startDate, endDate };
}

app.get('/api/integrations/google-search-console/metrics', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM google_search_console_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Google Search Console is not connected' });
    const connection = connResult.rows[0];
    if (!connection.site_url) return res.status(400).json({ error: 'No Search Console site selected yet' });

    const metrics = await fetchGSCMetrics(connection, 28);

    await pool.query(
      `INSERT INTO search_console_snapshots (connection_id, snapshot_date, clicks, impressions, ctr, avg_position, top_query, raw_data)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (connection_id, snapshot_date) DO UPDATE SET clicks = $2, impressions = $3, ctr = $4, avg_position = $5, top_query = $6, raw_data = $7`,
      [connection.id, metrics.clicks, metrics.impressions, metrics.ctr, metrics.avgPosition, metrics.topQuery, JSON.stringify(metrics)]
    );
    await pool.query('UPDATE google_search_console_connections SET last_synced_at = NOW() WHERE id = $1', [connection.id]);

    res.json({ metrics, siteUrl: connection.site_url });
  } catch (e) {
    console.error('GSC metrics error:', e.message);
    res.status(500).json({ error: 'Failed to load Search Console metrics. Try reconnecting Google Search Console.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HUBSPOT CRM — a separate OAuth client from the Google integrations
// (HUBSPOT_CLIENT_ID/SECRET), obtained by creating an app through HubSpot's
// CLI-based developer platform (their web-form public app creation was
// discontinued in mid-2026). The runtime OAuth flow itself is the standard
// authorization-code flow, same shape as the Google integrations, just
// against HubSpot's endpoints — including their current versioned token
// endpoint, which requires all parameters in the request body.
// One connection per Arreyon account, owned and managed by the account
// owner only, shared by the whole team — same model as the Google
// integrations, deliberately not per-team-member.
// ═══════════════════════════════════════════════════════════════════════════

const HUBSPOT_SCOPE = 'crm.objects.contacts.read crm.objects.deals.read';
const HUBSPOT_CALLBACK_URL = `${BASE_URL}/api/integrations/hubspot/callback`;
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/2026-03/token';

app.get('/api/integrations/hubspot/connect', authRequired, async (req, res) => {
  const account = await resolveAccount(req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can connect integrations' });

  const state = jwt.sign({ ownerId: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.HUBSPOT_CLIENT_ID,
    redirect_uri: HUBSPOT_CALLBACK_URL,
    scope: HUBSPOT_SCOPE,
    state
  });
  res.redirect(`https://app.hubspot.com/oauth/authorize?${params.toString()}`);
});

app.get('/api/integrations/hubspot/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect('/dashboard?section=integrations&error=hubspot_connect_failed');

  let ownerId;
  try {
    ownerId = jwt.verify(state, JWT_SECRET).ownerId;
  } catch (e) {
    return res.redirect('/dashboard?section=integrations&error=hubspot_connect_failed');
  }

  try {
    const tokenRes = await fetch(HUBSPOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.HUBSPOT_CLIENT_ID,
        client_secret: process.env.HUBSPOT_CLIENT_SECRET,
        redirect_uri: HUBSPOT_CALLBACK_URL,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error('HubSpot token exchange failed:', tokenData);
      return res.redirect('/dashboard?section=integrations&error=hubspot_connect_failed');
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 1800) * 1000);
    await pool.query(
      `INSERT INTO hubspot_connections (owner_id, access_token, refresh_token, token_expires_at, hub_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_id) DO UPDATE SET access_token = $2, refresh_token = $3, token_expires_at = $4, hub_id = $5, connected_at = NOW()`,
      [ownerId, tokenData.access_token, tokenData.refresh_token, expiresAt, tokenData.hub_id ? String(tokenData.hub_id) : null]
    );

    res.redirect('/dashboard?section=integrations&connected=hubspot');
  } catch (e) {
    console.error('HubSpot callback error:', e.message);
    res.redirect('/dashboard?section=integrations&error=hubspot_connect_failed');
  }
});

async function getValidHubSpotAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) return connection.access_token;

  const tokenRes = await fetch(HUBSPOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.HUBSPOT_CLIENT_ID,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET,
      refresh_token: connection.refresh_token
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Failed to refresh HubSpot access token: ' + (tokenData.message || tokenRes.status));

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 1800) * 1000);
  await pool.query('UPDATE hubspot_connections SET access_token = $1, token_expires_at = $2 WHERE id = $3',
    [tokenData.access_token, newExpiresAt, connection.id]);

  return tokenData.access_token;
}

app.get('/api/integrations/hubspot/status', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query('SELECT id, hub_id, hub_domain, connected_at, last_synced_at FROM hubspot_connections WHERE owner_id = $1', [account.id]);
    if (!result.rows.length) return res.json({ connected: false });
    res.json({ connected: true, ...result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed to load integration status' }); }
});

app.delete('/api/integrations/hubspot', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    await pool.query('DELETE FROM hubspot_connections WHERE owner_id = $1', [account.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disconnect' }); }
});

// Uses the Search API rather than the plain list endpoint specifically
// because it returns an accurate "total" count directly in the response,
// rather than requiring every record to be paginated through and counted
// client-side just to know how many there are.
async function fetchHubSpotMetrics(connection) {
  const accessToken = await getValidHubSpotAccessToken(connection);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const contactsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST', headers, body: JSON.stringify({ limit: 1, filterGroups: [] })
  });
  const contactsData = await contactsRes.json();
  if (!contactsRes.ok) throw new Error(contactsData.message || 'Failed to fetch HubSpot contacts');
  const contactsCount = contactsData.total || 0;

  const dealsRes = await fetch('https://api.hubapi.com/crm/v3/objects/deals/search', {
    method: 'POST', headers, body: JSON.stringify({ limit: 100, filterGroups: [], properties: ['amount', 'hs_is_closed_won'] })
  });
  const dealsData = await dealsRes.json();
  if (!dealsRes.ok) throw new Error(dealsData.message || 'Failed to fetch HubSpot deals');
  const dealsCount = dealsData.total || 0;

  // hs_is_closed_won is a standard HubSpot property present on every
  // pipeline regardless of that account's specific stage configuration,
  // which pipeline-stage IDs are not — using it avoids guessing at
  // account-specific stage names to determine what counts as "won."
  let dealsWonCount = 0;
  let totalPipelineValue = 0;
  (dealsData.results || []).forEach(d => {
    const amount = parseFloat(d.properties?.amount);
    if (!isNaN(amount)) totalPipelineValue += amount;
    if (d.properties?.hs_is_closed_won === 'true') dealsWonCount++;
  });

  return { contactsCount, dealsCount, dealsWonCount, totalPipelineValue: round2(totalPipelineValue) };
}

app.get('/api/integrations/hubspot/metrics', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM hubspot_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'HubSpot is not connected' });
    const connection = connResult.rows[0];

    const metrics = await fetchHubSpotMetrics(connection);

    await pool.query(
      `INSERT INTO hubspot_snapshots (connection_id, snapshot_date, contacts_count, deals_count, open_deals_value, deals_won_count, raw_data)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id, snapshot_date) DO UPDATE SET contacts_count = $2, deals_count = $3, open_deals_value = $4, deals_won_count = $5, raw_data = $6`,
      [connection.id, metrics.contactsCount, metrics.dealsCount, metrics.totalPipelineValue, metrics.dealsWonCount, JSON.stringify(metrics)]
    );
    await pool.query('UPDATE hubspot_connections SET last_synced_at = NOW() WHERE id = $1', [connection.id]);

    res.json({ metrics });
  } catch (e) {
    console.error('HubSpot metrics error:', e.message);
    res.status(500).json({ error: 'Failed to load HubSpot metrics. Try reconnecting HubSpot.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ZOHO BOOKS — a separate OAuth client from Google and HubSpot
// (ZOHO_CLIENT_ID/SECRET). Zoho hosts different customers on entirely
// separate regional data centers (US, EU, India, and others) with distinct
// API domains — getting this wrong produces authentication failures that
// look like token problems, not an obviously region-related error. The
// authorization callback directly provides both the region code and the
// exact accounts-server URL to use, so that's read and stored per
// connection rather than guessed from a hardcoded table; only the
// corresponding data-API domain (which isn't returned directly) needs a
// small lookup, with Canada's URL pattern as the one real exception.
// One connection per Arreyon account, owned and managed by the account
// owner only, shared by the whole team — same model as the other
// integrations, deliberately not per-team-member.
// ═══════════════════════════════════════════════════════════════════════════

// settings.READ is required specifically for the organizations list
// endpoint (confirmed from Zoho's own API documentation) — without it,
// the connection succeeds but listing organizations fails, since scopes
// are granted per-endpoint, not implied by the others.
const ZOHO_SCOPE = 'ZohoBooks.invoices.READ,ZohoBooks.bills.READ,ZohoBooks.settings.READ';
const ZOHO_CALLBACK_URL = `${BASE_URL}/api/integrations/zoho-books/callback`;

// Confirmed from Zoho's own multi-DC documentation (consistent across
// their Bigin, SalesIQ and Mail API docs) — the API domain isn't returned
// by the callback itself, only the region code and the accounts-server,
// so this maps the region code to the corresponding data-API domain.
// Falls back to the US domain for any future/unrecognized region code
// rather than failing outright.
const ZOHO_API_DOMAINS = {
  us: 'https://www.zohoapis.com',
  eu: 'https://www.zohoapis.eu',
  in: 'https://www.zohoapis.in',
  au: 'https://www.zohoapis.com.au',
  jp: 'https://www.zohoapis.jp',
  cn: 'https://www.zohoapis.com.cn',
  sa: 'https://www.zohoapis.sa',
  ca: 'https://www.zohoapis.ca', // accounts-server for Canada is accounts.zohocloud.ca, but the API domain itself is zohoapis.ca — a genuine, confirmed inconsistency, not a typo
  uk: 'https://www.zohoapis.uk'
};
function resolveZohoApiDomain(location) {
  return ZOHO_API_DOMAINS[location] || ZOHO_API_DOMAINS.us;
}

app.get('/api/integrations/zoho-books/connect', authRequired, async (req, res) => {
  const account = await resolveAccount(req.userId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can connect integrations' });

  const state = jwt.sign({ ownerId: req.userId }, JWT_SECRET, { expiresIn: '10m' });
  const params = new URLSearchParams({
    client_id: process.env.ZOHO_CLIENT_ID,
    redirect_uri: ZOHO_CALLBACK_URL,
    response_type: 'code',
    scope: ZOHO_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  // Always initiate from the US (.com) accounts domain, regardless of the
  // connecting user's actual region — Zoho automatically redirects to
  // their correct home data center behind the scenes and reports it back
  // in the callback, rather than requiring the initiating request to
  // already know which region to use.
  res.redirect(`https://accounts.zoho.com/oauth/v2/auth?${params.toString()}`);
});

app.get('/api/integrations/zoho-books/callback', async (req, res) => {
  const { code, state, error, location, 'accounts-server': accountsServer } = req.query;
  if (error || !code || !accountsServer) return res.redirect('/dashboard?section=integrations&error=zoho_connect_failed');

  let ownerId;
  try {
    ownerId = jwt.verify(state, JWT_SECRET).ownerId;
  } catch (e) {
    return res.redirect('/dashboard?section=integrations&error=zoho_connect_failed');
  }

  try {
    const tokenRes = await fetch(`${accountsServer}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.ZOHO_CLIENT_ID,
        client_secret: process.env.ZOHO_CLIENT_SECRET,
        redirect_uri: ZOHO_CALLBACK_URL,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.refresh_token) {
      console.error('Zoho token exchange failed:', tokenData);
      return res.redirect('/dashboard?section=integrations&error=zoho_connect_failed');
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
    const apiDomain = resolveZohoApiDomain(location);
    await pool.query(
      `INSERT INTO zoho_books_connections (owner_id, access_token, refresh_token, token_expires_at, accounts_server, api_domain)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id) DO UPDATE SET access_token = $2, refresh_token = $3, token_expires_at = $4, accounts_server = $5, api_domain = $6, organization_id = NULL, organization_name = NULL, connected_at = NOW()`,
      [ownerId, tokenData.access_token, tokenData.refresh_token, expiresAt, accountsServer, apiDomain]
    );

    res.redirect('/dashboard?section=integrations&connected=zoho-books');
  } catch (e) {
    console.error('Zoho callback error:', e.message);
    res.redirect('/dashboard?section=integrations&error=zoho_connect_failed');
  }
});

async function getValidZohoAccessToken(connection) {
  const expiresAt = new Date(connection.token_expires_at);
  const now = new Date();
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) return connection.access_token;

  // Token refresh must go to the SAME regional accounts-server the
  // connection was originally issued from — Zoho's other data centers
  // will reject a refresh token they didn't issue.
  const tokenRes = await fetch(`${connection.accounts_server}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: connection.refresh_token
    })
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) throw new Error('Failed to refresh Zoho access token: ' + (tokenData.message || tokenRes.status));

  const newExpiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);
  await pool.query('UPDATE zoho_books_connections SET access_token = $1, token_expires_at = $2 WHERE id = $3',
    [tokenData.access_token, newExpiresAt, connection.id]);

  return tokenData.access_token;
}

app.get('/api/integrations/zoho-books/status', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query('SELECT id, organization_id, organization_name, connected_at, last_synced_at FROM zoho_books_connections WHERE owner_id = $1', [account.id]);
    if (!result.rows.length) return res.json({ connected: false });
    res.json({ connected: true, ...result.rows[0] });
  } catch (e) { res.status(500).json({ error: 'Failed to load integration status' }); }
});

app.get('/api/integrations/zoho-books/organizations', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM zoho_books_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Zoho Books is not connected' });
    const connection = connResult.rows[0];

    const accessToken = await getValidZohoAccessToken(connection);
    const orgsRes = await fetch(`${connection.api_domain}/books/v3/organizations`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` }
    });
    const data = await orgsRes.json();
    if (!orgsRes.ok) throw new Error(data.message || 'Failed to list Zoho Books organizations');

    const organizations = (data.organizations || []).map(o => ({ organizationId: o.organization_id, name: o.name }));
    res.json({ organizations });
  } catch (e) {
    console.error('Zoho organizations error:', e.message);
    res.status(500).json({ error: 'Failed to load Zoho Books organizations. Try reconnecting Zoho Books.' });
  }
});

app.put('/api/integrations/zoho-books/organization', authRequired, async (req, res) => {
  const { organizationId, organizationName } = req.body;
  if (!organizationId) return res.status(400).json({ error: 'Organization ID is required' });
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    const result = await pool.query(
      'UPDATE zoho_books_connections SET organization_id = $1, organization_name = $2 WHERE owner_id = $3 RETURNING id',
      [organizationId, organizationName || null, account.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Zoho Books is not connected' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save selected organization' }); }
});

app.delete('/api/integrations/zoho-books', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage integrations' });
    await pool.query('DELETE FROM zoho_books_connections WHERE owner_id = $1', [account.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disconnect' }); }
});

async function fetchZohoBooksMetrics(connection) {
  const accessToken = await getValidZohoAccessToken(connection);
  const headers = { Authorization: `Zoho-oauthtoken ${accessToken}` };
  const orgParam = `organization_id=${connection.organization_id}`;

  // "unpaid" covers sent, partially-paid and overdue invoices together —
  // their total balance is the business's total receivables.
  const invoicesRes = await fetch(`${connection.api_domain}/books/v3/invoices?${orgParam}&status=unpaid&per_page=200`, { headers });
  const invoicesData = await invoicesRes.json();
  if (invoicesData.code !== 0) throw new Error(invoicesData.message || 'Failed to fetch Zoho Books invoices');
  const totalReceivables = round2((invoicesData.invoices || []).reduce((sum, inv) => sum + (parseFloat(inv.balance) || 0), 0));
  const openInvoicesCount = invoicesData.page_context?.total || (invoicesData.invoices || []).length;

  const overdueRes = await fetch(`${connection.api_domain}/books/v3/invoices?${orgParam}&status=overdue&per_page=1`, { headers });
  const overdueData = await overdueRes.json();
  const overdueInvoicesCount = overdueData.code === 0 ? (overdueData.page_context?.total || 0) : 0;

  const billsRes = await fetch(`${connection.api_domain}/books/v3/bills?${orgParam}&status=unpaid&per_page=200`, { headers });
  const billsData = await billsRes.json();
  const totalPayables = billsData.code === 0 ? round2((billsData.bills || []).reduce((sum, b) => sum + (parseFloat(b.balance) || 0), 0)) : 0;

  return { totalReceivables, totalPayables, openInvoicesCount, overdueInvoicesCount };
}

app.get('/api/integrations/zoho-books/metrics', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const connResult = await pool.query('SELECT * FROM zoho_books_connections WHERE owner_id = $1', [account.id]);
    if (!connResult.rows.length) return res.status(404).json({ error: 'Zoho Books is not connected' });
    const connection = connResult.rows[0];
    if (!connection.organization_id) return res.status(400).json({ error: 'No Zoho Books organization selected yet' });

    const metrics = await fetchZohoBooksMetrics(connection);

    await pool.query(
      `INSERT INTO zoho_books_snapshots (connection_id, snapshot_date, total_receivables, total_payables, open_invoices_count, overdue_invoices_count, raw_data)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id, snapshot_date) DO UPDATE SET total_receivables = $2, total_payables = $3, open_invoices_count = $4, overdue_invoices_count = $5, raw_data = $6`,
      [connection.id, metrics.totalReceivables, metrics.totalPayables, metrics.openInvoicesCount, metrics.overdueInvoicesCount, JSON.stringify(metrics)]
    );
    await pool.query('UPDATE zoho_books_connections SET last_synced_at = NOW() WHERE id = $1', [connection.id]);

    res.json({ metrics, organizationName: connection.organization_name });
  } catch (e) {
    console.error('Zoho Books metrics error:', e.message);
    res.status(500).json({ error: 'Failed to load Zoho Books metrics. Try reconnecting Zoho Books.' });
  }
});

function adminRequired(req, res, next) {
  const token = req.cookies.arreyon_admin_token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.adminId = decoded.adminId;
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid admin token' }); }
}

// ── DATABASE INIT ──────────────────────────────────────────────────────────
async function initDB() {
  const fs = require('fs');
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    // Create default admin
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, name) VALUES ($1, $2, 'Admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = $2`,
      [ADMIN_EMAIL, hash]
    );
    console.log('Database initialized');
  } catch(e) { console.error('DB init error:', e.message); }
}

// ── HELPERS ────────────────────────────────────────────────────────────────
function generateToken(userId, plan) {
  return jwt.sign({ userId, plan }, JWT_SECRET, { expiresIn: '30d' });
}

function setCookie(res, token, name = 'arreyon_token') {
  res.cookie(name, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Register
app.post('/api/auth/register', async (req, res) => {
  const { firstName, lastName, password, phone, country, language } = req.body;
  const email = req.body.email?.trim().toLowerCase();
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'All required fields must be filled' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const token = uuidv4();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const preferredLang = language === 'fr' ? 'fr' : 'en';
    const planStartedAt = new Date();
    const planExpiresAt = new Date();
    planExpiresAt.setMonth(planExpiresAt.getMonth() + 1);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, country,
       verification_token, verification_expires, plan, preferred_language, plan_started_at, plan_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'starter', $9, $10, $11) RETURNING *`,
      [email, hash, firstName, lastName, phone, country, token, expires, preferredLang, planStartedAt, planExpiresAt]
    );
    const user = result.rows[0];

    const verifyUrl = `${BASE_URL}/auth/verify?token=${token}`;
    const { subject, html } = buildEmail('verify', preferredLang, { firstName, verifyUrl });
    await sendEmail(email, subject, html);

    res.json({ success: true, message: 'Account created. Please check your email to verify.' });
  } catch(e) {
    console.error('Register error:', e.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// Verify email
app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  try {
    const result = await pool.query(
      `UPDATE users SET email_verified = true, verification_token = NULL
       WHERE verification_token = $1 AND verification_expires > NOW() RETURNING *`,
      [token]
    );
    if (!result.rows.length) return res.redirect('/auth?error=invalid_token');
    const user = result.rows[0];
    const authToken = generateToken(user.id, user.plan);
    setCookie(res, authToken);
    res.redirect('/dashboard');
  } catch(e) { res.redirect('/auth?error=verify_failed'); }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  const { password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (!user.password_hash) return res.status(401).json({ error: 'Please sign in with Google' });
    if (!user.email_verified) return res.status(401).json({ error: 'Please verify your email first', needsVerification: true });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = generateToken(user.id, user.plan);
    setCookie(res, token);
    res.json({ success: true, user: { id: user.id, firstName: user.first_name, email: user.email, plan: user.plan } });
  } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

// Resend verification
app.post('/api/auth/resend-verification', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0];
    if (!user || user.email_verified) return res.json({ success: true });

    const token = uuidv4();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET verification_token = $1, verification_expires = $2 WHERE id = $3',
      [token, expires, user.id]);

    const verifyUrl = `${BASE_URL}/auth/verify?token=${token}`;
    const { subject, html } = buildEmail('resendVerify', user.preferred_language, { verifyUrl });
    await sendEmail(email, subject, html);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed to resend' }); }
});

// Forgot password
app.post('/api/auth/forgot-password', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0];
    if (!user) return res.json({ success: true }); // Don't reveal if email exists

    const token = uuidv4();
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query('UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
      [token, expires, user.id]);

    const resetUrl = `${BASE_URL}/auth/reset-password?token=${token}`;
    const { subject, html } = buildEmail('resetPassword', user.preferred_language, { resetUrl });
    await sendEmail(email, subject, html);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// Reset password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL
       WHERE reset_token = $2 AND reset_expires > NOW() RETURNING *`,
      [hash, token]
    );
    if (!result.rows.length) return res.status(400).json({ error: 'Invalid or expired reset link' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Reset failed' }); }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('arreyon_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  res.json({ success: true });
});

// Google OAuth routes
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth?error=google_failed' }),
  (req, res) => {
    const token = generateToken(req.user.id, req.user.plan);
    setCookie(res, token);
    res.redirect('/dashboard');
  }
);

// ── GET CURRENT USER ────────────────────────────────────────────────────────
app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, first_name, last_name, phone, avatar_url, plan, consultations_used, created_at, team_owner_id FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // resolveAccount() resolves team members to their owner AND enforces
    // subscription expiry (auto-transitioning a lapsed plan to 'expired') —
    // reused here rather than duplicated, since this endpoint is the
    // primary source of user.plan for the whole frontend and needs to
    // reflect the same, single source of truth on expiry.
    const account = await resolveAccount(req.userId);

    if (user.team_owner_id) {
      const memberResult = await pool.query('SELECT permissions FROM team_members WHERE owner_id = $1 AND member_id = $2 AND status = $3', [user.team_owner_id, req.userId, 'active']);
      const permissions = memberResult.rows[0]?.permissions || {};
      return res.json({
        user: { ...user, plan: account?.plan || 'starter', consultations_used: account?.consultations_used || 0, plan_expires_at: account?.plan_expires_at || null },
        isTeamMember: true,
        teamOwnerName: account ? [account.first_name, account.last_name].filter(Boolean).join(' ') : null,
        permissions
      });
    }

    res.json({ user: { ...user, plan: account?.plan || user.plan, plan_started_at: account?.plan_started_at || null, plan_expires_at: account?.plan_expires_at || null }, isTeamMember: false });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();
  const { password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1)', [email]);
    const admin = result.rows[0];
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ adminId: admin.id, role: 'admin', name: admin.name }, JWT_SECRET, { expiresIn: '24h' });
    setCookie(res, token, 'arreyon_admin_token');
    res.json({ success: true, admin: { id: admin.id, name: admin.name, email: admin.email } });
  } catch(e) { res.status(500).json({ error: 'Login failed' }); }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('arreyon_admin_token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CMS ROUTES (Admin only)
// ═══════════════════════════════════════════════════════════════════════════

// Bulk CMS update
app.put('/api/cms/bulk', adminRequired, async (req, res) => {
  const { updates } = req.body; // [{section, key, value, value_fr}]
  try {
    for (const { section, key, value, value_fr } of updates) {
      await pool.query(
        `INSERT INTO cms_content (section, key, value, value_fr) VALUES ($1, $2, $3, $4)
         ON CONFLICT (section, key) DO UPDATE SET value = $3, value_fr = COALESCE($4, cms_content.value_fr), updated_at = NOW()`,
        [section, key, value, value_fr || null]
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ── Admin-only: raw CMS data with both English and French values, for editing ──
app.get('/api/admin/cms-raw', adminRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_content ORDER BY section, key');
    const content = {};
    result.rows.forEach(row => {
      if (!content[row.section]) content[row.section] = {};
      content[row.section][row.key] = { value: row.value, value_fr: row.value_fr || '' };
    });
    res.json({ content });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ── Auto-translate CMS content to French using AI ──────────────────────────
// Reads the ACTUAL current English content from the database (not a guess at
// what it might be) and produces real French translations. Batched one AI call
// per section — smaller, more reliable calls rather than one giant one that
// risks truncation on a large site. By default only translates fields that
// don't already have French text, so it never silently overwrites manual edits
// unless the admin explicitly asks it to. IMPORTANT: this returns the
// translations for review — it does NOT write to the database. The admin must
// still click "Save All Changes" to actually publish them, same as any other
// CMS edit, so nothing goes live without a human looking at it first.
// ── Shared: translate one section's fields to French via AI ────────────────
// Used by both the automatic on-demand path (GET /api/cms) and the manual
// admin re-translate button (still available for forcing a refresh).
async function translateCmsSection(section, fields) {
  const fieldsJson = JSON.stringify(Object.fromEntries(fields.map(f => [f.key, f.value])));

  const prompt = `You are a professional French translator working on marketing copy for a business consulting platform (Arreyon Consult, aimed at African and global founders, based in Cameroon). Translate the following website content from English to French.

CONTENT TO TRANSLATE (JSON, section: "${section}"):
${fieldsJson}

RULES:
- Translate naturally, as a native French marketing copywriter would write it — not a literal word-for-word translation
- Keep the same tone: confident, direct, professional but warm
- Keep proper nouns, brand names (Arreyon Consult, G-DESIGNS LTD), and person names (e.g. Rockefeller, Ogilvy, Buffett) unchanged
- Keep any numbers, prices, or currency symbols unchanged
- Preserve any HTML tags exactly as they appear in the source (e.g. <br>, <strong>)
- Return ONLY a JSON object with the EXACT SAME keys as the input, mapped to their French translations. No markdown, no commentary, no extra keys.`;

  const raw = await callAI({ persona: prompt, messages: [{ role: 'user', content: 'Translate now, as JSON only.' }], complexity: 'complex', context: { feature: 'cms_translation' }, maxTokens: 6000 });
  return extractJSON(raw); // { key: frValue, ... }
}

// ── Generic French translation for a flat business-facts key/value set ─────
// Same one-call, whole-set batching pattern as CMS translation.
async function translateBusinessFacts(facts) {
  const factsJson = JSON.stringify(facts); // { fact_key: fact_value, ... }

  const prompt = `You are a professional French translator working for a business consulting platform. Translate the following business profile facts from English to French.

FACTS TO TRANSLATE (JSON):
${factsJson}

RULES:
- Translate naturally, as a native French business consultant would write it
- Keep proper nouns, business/brand names, and person names unchanged
- Keep any numbers, prices, currency symbols, URLs, and email addresses unchanged
- Return ONLY a JSON object with the EXACT SAME keys as the input, mapped to their French translations. No markdown, no commentary, no extra keys.`;

  const raw = await callAI({ persona: prompt, messages: [{ role: 'user', content: 'Translate now, as JSON only.' }], complexity: 'complex', context: { feature: 'content_translation' }, maxTokens: 3000 });
  return extractJSON(raw);
}

// ── Generic French translation for a deeply-nested structured JSON object ──
// Used for research/verification/entrepreneur-mode results, which have arrays
// of objects (competitors, recommendations, checks, etc) rather than a flat
// key/value set. Carries the same enum-protection rule as live generation —
// translating a status/priority/scope/verdict ENUM value would silently break
// the frontend's color-coding and filtering logic, which matches by exact
// English string. Only free-text narrative fields get translated.
async function translateStructuredContent(obj, contextLabel) {
  const objJson = JSON.stringify(obj);

  const prompt = `You are a professional French translator working for a business consulting platform. Translate the following ${contextLabel} content from English to French.

CONTENT TO TRANSLATE (JSON):
${objJson.slice(0, 12000)}

RULES:
- Translate every free-text/narrative string value naturally into French, as a native French business consultant would write it
- Keep the EXACT SAME JSON structure and the EXACT SAME keys — do not add, remove, or rename any key
- Keep proper nouns, business/brand/person names, numbers, prices, currency symbols, URLs unchanged
- CRITICAL: any field holding a fixed English enum value (for example "high"/"medium"/"low", "local"/"international", "covered"/"partial"/"not covered", "upheld"/"weakened"/"revise", "validate"/"modify"/"reconsider", "observed"/"inferred"/"user_provided", "you"/"them") must keep that EXACT English word unchanged — the application matches these values by exact string for color-coding, message alignment, and filtering, and translating them would silently break that logic. Only the surrounding descriptive text should become French.
- Return ONLY the translated JSON object, no markdown, no commentary.`;

  const raw = await callAI({ persona: prompt, messages: [{ role: 'user', content: 'Translate now, as JSON only.' }], complexity: 'complex', context: { feature: 'content_translation' }, maxTokens: 6500 });
  return extractJSON(raw);
}

// ── Bidirectional live-chat translator ──────────────────────────────────────
// Unlike every other translation helper in this file (all one-way, English →
// French), this one needs to go BOTH directions: a conversation may have
// started in French and the user wants to see it in English, or vice versa.
// Used when someone switches language mid-conversation — the messages already
// on screen were generated once, in whichever language was active at the
// time, and nothing retroactively touches them without this.
async function translateChatMessages(messages, targetLang) {
  const targetLangName = targetLang === 'fr' ? 'French (Français)' : 'English';
  const messagesJson = JSON.stringify(messages); // { messageId: text, ... }

  const prompt = `Translate the following business advisory chat messages into ${targetLangName}. These are real messages from a conversation between a founder and a business advisor — preserve each speaker's tone, directness, and meaning.

MESSAGES TO TRANSLATE (JSON, key = message id, value = message text):
${messagesJson.slice(0, 12000)}

RULES:
- Translate naturally and conversationally — not stiffly literal
- Keep proper nouns, business/brand/person names, numbers, prices, URLs unchanged
- Return ONLY a JSON object with the EXACT SAME keys as the input, mapped to the translated text. No markdown, no commentary, no extra keys.`;

  const raw = await callAI({ persona: prompt, messages: [{ role: 'user', content: 'Translate now, as JSON only.' }], complexity: 'complex', context: { feature: 'chat_translation' }, maxTokens: 6500 });
  return extractJSON(raw);
}

app.post('/api/translate-messages', async (req, res) => {
  const { messages, targetLanguage } = req.body; // messages: [{ id, text }]
  if (!messages || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages provided' });
  if (targetLanguage !== 'fr' && targetLanguage !== 'en') return res.status(400).json({ error: 'Invalid target language' });

  try {
    const toTranslate = {};
    messages.forEach(m => { if (m && m.id !== undefined && typeof m.text === 'string') toTranslate[m.id] = m.text; });
    if (!Object.keys(toTranslate).length) return res.status(400).json({ error: 'No valid messages to translate' });

    const translated = await translateChatMessages(toTranslate, targetLanguage);
    res.json({ translated });
  } catch (err) {
    console.error('Chat translation error:', err.message);
    res.status(500).json({ error: err.message || 'Translation failed. Please try again.' });
  }
});

// ── Public CMS content endpoint — fully automatic French, no admin action needed ──
// If a French request hits a field with no cached translation yet, it's
// translated right then (parallelized across sections) and saved to the
// database, so every subsequent request — French or not — is instant. Only
// the very first French visitor after a content change experiences the
// one-time translation delay.
app.get('/api/cms', async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const result = await pool.query('SELECT * FROM cms_content ORDER BY section, key');

    if (lang === 'fr') {
      const missingBySection = {};
      result.rows.forEach(row => {
        if (!row.value_fr) {
          if (!missingBySection[row.section]) missingBySection[row.section] = [];
          missingBySection[row.section].push({ key: row.key, value: row.value });
        }
      });

      const sectionsNeedingTranslation = Object.entries(missingBySection);
      if (sectionsNeedingTranslation.length) {
        // Translate all missing sections in parallel — bounded by the slowest
        // single section rather than the sum of all of them
        const results = await Promise.allSettled(
          sectionsNeedingTranslation.map(([section, fields]) => translateCmsSection(section, fields))
        );

        const updates = []; // flatten to a list of {section, key, value_fr} for the DB write + in-memory patch
        sectionsNeedingTranslation.forEach(([section, fields], i) => {
          const outcome = results[i];
          if (outcome.status !== 'fulfilled') {
            console.error(`Auto-translate failed for section "${section}":`, outcome.reason?.message);
            return;
          }
          const translated = outcome.value;
          fields.forEach(field => {
            const frValue = translated[field.key];
            if (frValue) updates.push({ section, key: field.key, value_fr: frValue });
          });
        });

        // Save to DB (cache for next time) and patch the in-memory rows so this
        // very request already returns the freshly-translated text, not a stale fallback
        for (const u of updates) {
          await pool.query('UPDATE cms_content SET value_fr = $1 WHERE section = $2 AND key = $3', [u.value_fr, u.section, u.key]);
          const row = result.rows.find(r => r.section === u.section && r.key === u.key);
          if (row) row.value_fr = u.value_fr;
        }
      }
    }

    const content = {};
    result.rows.forEach(row => {
      if (!content[row.section]) content[row.section] = {};
      // Still falls back to English if a specific field's translation failed —
      // never shows blank text even if one section had trouble
      content[row.section][row.key] = (lang === 'fr' && row.value_fr) ? row.value_fr : row.value;
    });
    res.json({ content, lang });
  } catch(e) {
    console.error('CMS load error:', e.message);
    res.status(500).json({ error: 'Failed' });
  }
});

app.put('/api/cms', adminRequired, async (req, res) => {
  const { section, key, value, value_fr } = req.body;
  try {
    await pool.query(
      `INSERT INTO cms_content (section, key, value, value_fr) VALUES ($1, $2, $3, $4)
       ON CONFLICT (section, key) DO UPDATE SET value = $3, value_fr = COALESCE($4, cms_content.value_fr), updated_at = NOW()`,
      [section, key, value, value_fr || null]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/cms-translate', adminRequired, async (req, res) => {
  const { overwrite = false } = req.body || {};

  try {
    const result = await pool.query('SELECT * FROM cms_content ORDER BY section, key');
    const bySection = {};
    result.rows.forEach(row => {
      if (!bySection[row.section]) bySection[row.section] = [];
      const needsTranslation = overwrite || !row.value_fr;
      if (needsTranslation) bySection[row.section].push({ key: row.key, value: row.value });
    });

    const sections = Object.entries(bySection).filter(([, fields]) => fields.length > 0);
    if (!sections.length) {
      return res.json({ success: true, translatedCount: 0, sectionsProcessed: 0, translations: {}, message: 'Everything already has a French translation. Nothing to do.' });
    }

    let translatedCount = 0;
    const failedSections = [];
    const translations = {};

    for (const [section, fields] of sections) {
      try {
        const translated = await translateCmsSection(section, fields);
        translations[section] = {};
        for (const field of fields) {
          const frValue = translated[field.key];
          if (frValue) {
            translations[section][field.key] = frValue;
            translatedCount++;
          } else {
            console.error(`CMS translation: section "${section}" succeeded but field "${field.key}" was missing from the AI's response.`);
          }
        }
      } catch (sectionErr) {
        console.error(`CMS translation failed for section "${section}":`, sectionErr.message);
        failedSections.push(section);
      }
    }

    res.json({
      success: true,
      translatedCount,
      sectionsProcessed: sections.length,
      translations,
      failedSections: failedSections.length ? failedSections : undefined
    });
  } catch (err) {
    console.error('CMS auto-translate error:', err.message);
    res.status(500).json({ error: err.message || 'Translation failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ANNOUNCEMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/announcements', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM announcements WHERE is_active = true
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at >= NOW())
       ORDER BY created_at DESC`
    );
    res.json({ announcements: result.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/announcements', adminRequired, async (req, res) => {
  const { title, message, type, show_as_banner, show_as_popup, starts_at, ends_at } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO announcements (title, message, type, show_as_banner, show_as_popup, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, message, type || 'info', show_as_banner !== false, show_as_popup === true, starts_at, ends_at]
    );
    res.json({ success: true, announcement: result.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/admin/announcements/:id', adminRequired, async (req, res) => {
  const { id } = req.params;
  const { title, message, type, show_as_banner, show_as_popup, is_active, ends_at } = req.body;
  try {
    await pool.query(
      `UPDATE announcements SET title=$1, message=$2, type=$3, show_as_banner=$4,
       show_as_popup=$5, is_active=$6, ends_at=$7 WHERE id=$8`,
      [title, message, type, show_as_banner, show_as_popup, is_active, ends_at, id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.delete('/api/admin/announcements/:id', adminRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// COUPON ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/coupons/validate', async (req, res) => {
  const { code, plan } = req.body;
  try {
    const result = await pool.query(
      `SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) AND is_active = true
       AND (valid_until IS NULL OR valid_until >= NOW())
       AND (max_uses IS NULL OR used_count < max_uses)
       AND (applies_to = 'all' OR applies_to = $2)`,
      [code, plan]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid or expired coupon code' });
    const coupon = result.rows[0];
    res.json({ valid: true, discount: coupon.discount_percent, description: coupon.description });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/admin/coupons', adminRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: result.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/admin/coupons', adminRequired, async (req, res) => {
  const { code, description, discount_percent, applies_to, max_uses, valid_until } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO coupons (code, description, discount_percent, applies_to, max_uses, valid_until)
       VALUES (UPPER($1), $2, $3, $4, $5, $6) RETURNING *`,
      [code, description, discount_percent, applies_to || 'all', max_uses, valid_until]
    );
    res.json({ success: true, coupon: result.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/coupons/:id', adminRequired, async (req, res) => {
  const { is_active } = req.body;
  try {
    await pool.query('UPDATE coupons SET is_active = $1 WHERE id = $2', [is_active, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/payments/submit', async (req, res) => {
  const { userId, plan, billingCycle, paymentMethod, payerName, payerEmail, payerPhone, payerCountry, couponCode, transactionRef } = req.body;
  try {
    const plans = {
      pro:      { monthly: { usd: 35, cfa: 20125 }, annual: { usd: 28, cfa: 16100 } },
      business: { monthly: { usd: 150, cfa: 86250 }, annual: { usd: 120, cfa: 69000 } }
    };

    let discount = 0;
    if (couponCode) {
      const couponResult = await pool.query(
        `SELECT * FROM coupons WHERE UPPER(code) = UPPER($1) AND is_active = true
         AND (valid_until IS NULL OR valid_until >= NOW())`, [couponCode]
      );
      if (couponResult.rows.length) {
        discount = couponResult.rows[0].discount_percent;
        await pool.query('UPDATE coupons SET used_count = used_count + 1 WHERE id = $1', [couponResult.rows[0].id]);
      }
    }

    const amounts = plans[plan]?.[billingCycle] || { usd: 0, cfa: 0 };
    const finalUsd = amounts.usd * (1 - discount / 100);
    const finalCfa = Math.round(amounts.cfa * (1 - discount / 100));

    const result = await pool.query(
      `INSERT INTO payments (user_id, plan, billing_cycle, amount_usd, amount_cfa, payment_method,
       payment_reference, payer_name, payer_email, payer_phone, payer_country, coupon_code, discount_percent, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending') RETURNING *`,
      [userId, plan, billingCycle, finalUsd, finalCfa, paymentMethod, transactionRef,
       payerName, payerEmail, payerPhone, payerCountry, couponCode, discount]
    );

    // Notify admin
    await sendEmail(ADMIN_EMAIL, `New Payment Submission — ${plan} plan`,
      `<p><strong>Name:</strong> ${payerName}<br>
       <strong>Email:</strong> ${payerEmail}<br>
       <strong>Plan:</strong> ${plan} (${billingCycle})<br>
       <strong>Amount:</strong> $${finalUsd} / ${finalCfa} FCFA<br>
       <strong>Method:</strong> ${paymentMethod}<br>
       <strong>Ref:</strong> ${transactionRef || 'N/A'}</p>
       <p><a href="${BASE_URL}/admin">Review in Admin Panel</a></p>`
    );

    res.json({ success: true, paymentId: result.rows[0].id });
  } catch(e) {
    console.error('Payment error:', e.message);
    res.status(500).json({ error: 'Payment submission failed' });
  }
});

// Admin approve payment
app.post('/api/admin/payments/:id/approve', adminRequired, async (req, res) => {
  const { id } = req.params;
  try {
    const payment = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (!payment.rows.length) return res.status(404).json({ error: 'Payment not found' });
    const p = payment.rows[0];

    const expiresAt = new Date();
    if (p.billing_cycle === 'annual') expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    else expiresAt.setMonth(expiresAt.getMonth() + 1);

    await pool.query(
      `UPDATE payments SET status = 'approved', approved_at = NOW() WHERE id = $1`, [id]
    );
    await pool.query(
      `UPDATE users SET plan = $1, plan_started_at = NOW(), plan_expires_at = $2, plan_expiry_notified_at = NULL, updated_at = NOW() WHERE id = $3`,
      [p.plan, expiresAt, p.user_id]
    );
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan, billing_cycle, amount_usd, amount_cfa, payment_method, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
       ON CONFLICT DO NOTHING`,
      [p.user_id, p.plan, p.billing_cycle, p.amount_usd, p.amount_cfa, p.payment_method, expiresAt]
    );

    // Notify user
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [p.user_id]);
    if (user.rows.length) {
      const { subject, html } = buildEmail('planActive', user.rows[0].preferred_language, {
        firstName: user.rows[0].first_name, plan: p.plan, dashboardUrl: `${BASE_URL}/dashboard`
      });
      await sendEmail(user.rows[0].email, subject, html);
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Approval failed' }); }
});

app.get('/api/admin/payments', adminRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.first_name, u.last_name, u.email as user_email
       FROM payments p LEFT JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json({ payments: result.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN USER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/admin/users', adminRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, plan, email_verified, consultations_used, created_at
       FROM users ORDER BY created_at DESC`
    );
    res.json({ users: result.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ── Admin: platform-wide visibility into every team, across every account ──
app.get('/api/admin/team-members', adminRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tm.id, tm.member_email, tm.status, tm.permissions, tm.invited_at, tm.joined_at,
              owner.email as owner_email, owner.first_name as owner_first_name, owner.last_name as owner_last_name, owner.plan as owner_plan,
              member.email as member_actual_email
       FROM team_members tm
       JOIN users owner ON owner.id = tm.owner_id
       LEFT JOIN users member ON member.id = tm.member_id
       WHERE tm.status != 'removed'
       ORDER BY tm.invited_at DESC`
    );
    res.json({ teamMembers: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load team members' }); }
});

app.put('/api/admin/users/:id/plan', adminRequired, async (req, res) => {
  const { plan } = req.body;
  try {
    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ── AI Usage Dashboard — Increment 6 ─────────────────────────────────────────
// Rough, clearly-labeled cost estimate per provider. Not exact billing —
// actual cost depends on token count which we don't currently log per call —
// but gives a useful relative sense of where usage/spend concentrates.
const ESTIMATED_COST_PER_CALL = { claude: 0.003, chatgpt: 0.004, gemini: 0.001 };
// Rough per-call estimates by exact model — Sonnet (used for 'complex' tier tasks)
// costs noticeably more per call than Haiku, given its larger typical token usage
// for structured, multi-section reasoning tasks. Still an estimate, not billing.
const ESTIMATED_COST_PER_MODEL = {
  'claude-haiku-4-5-20251001': 0.003,
  'claude-sonnet-4-6': 0.018,
  'gpt-4o-mini': 0.004,
  'gemini-flash-latest': 0.001
};

app.get('/api/admin/usage-stats', adminRequired, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT COUNT(*) as total_calls,
              COUNT(*) FILTER (WHERE status = 'error') as error_calls,
              COUNT(DISTINCT user_id) as unique_users,
              AVG(duration_ms) as avg_duration_ms
       FROM ai_usage WHERE created_at > NOW() - INTERVAL '30 days'`
    );

    const byProvider = await pool.query(
      `SELECT provider, COUNT(*) as calls, COUNT(*) FILTER (WHERE status='error') as errors
       FROM ai_usage WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY provider ORDER BY calls DESC`
    );

    const byFeature = await pool.query(
      `SELECT feature, COUNT(*) as calls, COUNT(*) FILTER (WHERE status='error') as errors,
              AVG(duration_ms) as avg_duration_ms
       FROM ai_usage WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY feature ORDER BY calls DESC`
    );

    const byModel = await pool.query(
      `SELECT model, provider, COUNT(*) as calls
       FROM ai_usage WHERE created_at > NOW() - INTERVAL '30 days' AND model IS NOT NULL
       GROUP BY model, provider ORDER BY calls DESC`
    );

    const dailyTrend = await pool.query(
      `SELECT date_trunc('day', created_at) as day, COUNT(*) as calls
       FROM ai_usage WHERE created_at > NOW() - INTERVAL '30 days'
       GROUP BY day ORDER BY day ASC`
    );

    const topUsers = await pool.query(
      `SELECT u.email, u.first_name, u.last_name, u.plan, COUNT(a.*) as calls
       FROM ai_usage a JOIN users u ON u.id = a.user_id
       WHERE a.created_at > NOW() - INTERVAL '30 days'
       GROUP BY u.id, u.email, u.first_name, u.last_name, u.plan
       ORDER BY calls DESC LIMIT 10`
    );

    // Model-aware cost estimate — Sonnet (complex-reasoning tier) costs meaningfully
    // more per call than Haiku, so lump-summing by provider alone understates this
    const estimatedCost = byModel.rows.reduce((sum, r) =>
      sum + (parseInt(r.calls, 10) * (ESTIMATED_COST_PER_MODEL[r.model] || ESTIMATED_COST_PER_CALL[r.provider] || 0.002)), 0
    );

    res.json({
      totals: totals.rows[0],
      byProvider: byProvider.rows,
      byModel: byModel.rows,
      byFeature: byFeature.rows,
      dailyTrend: dailyTrend.rows,
      topUsers: topUsers.rows,
      estimatedCostUsd: estimatedCost.toFixed(2)
    });
  } catch (e) {
    console.error('Usage stats error:', e.message);
    res.status(500).json({ error: 'Failed to load usage stats' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// USER API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/user/profile', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, phone, country, avatar_url, plan, consultations_used, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    res.json({ user: result.rows[0] });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/user/profile', authRequired, async (req, res) => {
  const { firstName, lastName, phone, country } = req.body;
  try {
    await pool.query(
      'UPDATE users SET first_name=$1, last_name=$2, phone=$3, country=$4, updated_at=NOW() WHERE id=$5',
      [firstName, lastName, phone, country, req.userId]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// Called silently whenever a logged-in user switches the app's display
// language, so future emails (verification, password reset, plan activation,
// team invites) follow whichever language they're actually using the app in,
// rather than staying locked to whatever they picked at signup.
app.put('/api/user/language', authRequired, async (req, res) => {
  const { language } = req.body;
  const lang = language === 'fr' ? 'fr' : 'en';
  try {
    await pool.query('UPDATE users SET preferred_language = $1 WHERE id = $2', [lang, req.userId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// TEAM MEMBERS — invite, list, permissions, removal
// Only account owners (users with no team_owner_id of their own) can manage
// a team. A team member operates inside the owner's account for plan/limits
// purposes (see resolveAccount above), with the owner controlling which
// features they're allowed to touch via per-member permissions.
// ═══════════════════════════════════════════════════════════════════════════

const TEAM_PERMISSION_KEYS = ['boardroom', 'analyzer', 'entrepreneur', 'financial', 'scenario', 'history'];
function sanitizePermissions(input) {
  const perms = {};
  TEAM_PERMISSION_KEYS.forEach(k => { perms[k] = !!(input && input[k]); });
  return perms; // Billing is deliberately never included — team members can never touch billing/subscription, regardless of what the owner grants
}

app.get('/api/team', authRequired, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.team_owner_id) return res.status(403).json({ error: 'Only the account owner can manage team members' });

    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.starter;
    const members = await pool.query(
      `SELECT id, member_email, member_id, status, permissions, invited_at, joined_at FROM team_members
       WHERE owner_id = $1 AND status != 'removed' ORDER BY invited_at ASC`,
      [req.userId]
    );
    res.json({ members: members.rows, seatLimit: limits.team, seatsUsed: members.rows.length + 1 }); // +1 for the owner's own seat
  } catch (e) { res.status(500).json({ error: 'Failed to load team' }); }
});

app.post('/api/team/invite', authRequired, async (req, res) => {
  const { email, permissions, language } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Please provide a valid email address' });

  try {
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.team_owner_id) return res.status(403).json({ error: 'Only the account owner can invite team members' });
    if (email.toLowerCase() === user.email.toLowerCase()) return res.status(400).json({ error: "You can't invite yourself" });

    const limits = PLAN_LIMITS[user.plan] || PLAN_LIMITS.starter;
    const existing = await pool.query(`SELECT COUNT(*) FROM team_members WHERE owner_id = $1 AND status != 'removed'`, [req.userId]);
    const seatsUsed = parseInt(existing.rows[0].count, 10) + 1; // +1 for the owner
    if (seatsUsed >= limits.team) {
      return res.status(403).json({ error: `Your ${user.plan} plan includes ${limits.team} seat${limits.team===1?'':'s'} total (including you). Upgrade your plan to add more team members.`, upgradeRequired: true });
    }

    const dupe = await pool.query(`SELECT id FROM team_members WHERE owner_id = $1 AND member_email = $2 AND status != 'removed'`, [req.userId, email.toLowerCase()]);
    if (dupe.rows.length) return res.status(400).json({ error: 'This person has already been invited' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    const perms = sanitizePermissions(permissions);

    const inserted = await pool.query(
      `INSERT INTO team_members (owner_id, member_email, status, invite_token, invite_token_expires_at, permissions)
       VALUES ($1, $2, 'invited', $3, $4, $5) RETURNING id`,
      [req.userId, email.toLowerCase(), token, expiresAt, JSON.stringify(perms)]
    );

    const ownerName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email;
    const inviteUrl = `${BASE_URL}/team-invite?token=${token}`;
    const inviteLang = language === 'fr' ? 'fr' : 'en';
    const { subject, html } = buildEmail('teamInvite', inviteLang, { ownerName, inviteUrl });
    await sendEmail(email, subject, html);

    res.json({ success: true, id: inserted.rows[0].id });
  } catch (e) {
    console.error('Team invite error:', e.message);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

app.get('/api/team/invite/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tm.*, u.first_name, u.last_name, u.email as owner_email
       FROM team_members tm JOIN users u ON u.id = tm.owner_id
       WHERE tm.invite_token = $1`,
      [req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid invite link' });
    const invite = result.rows[0];
    if (invite.status !== 'invited') return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.invite_token_expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired' });

    const ownerName = [invite.first_name, invite.last_name].filter(Boolean).join(' ') || invite.owner_email;
    res.json({ ownerName, memberEmail: invite.member_email });
  } catch (e) { res.status(500).json({ error: 'Failed to load invite' }); }
});

app.post('/api/team/invite/:token/accept', authRequired, async (req, res) => {
  try {
    const inviteResult = await pool.query('SELECT * FROM team_members WHERE invite_token = $1', [req.params.token]);
    if (!inviteResult.rows.length) return res.status(404).json({ error: 'Invalid invite link' });
    const invite = inviteResult.rows[0];
    if (invite.status !== 'invited') return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.invite_token_expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const acceptingUser = userResult.rows[0];
    if (!acceptingUser) return res.status(404).json({ error: 'User not found' });
    if (acceptingUser.email.toLowerCase() !== invite.member_email.toLowerCase()) {
      return res.status(403).json({ error: 'This invite was sent to a different email address. Please log in with that account instead.' });
    }
    if (acceptingUser.team_owner_id) {
      return res.status(400).json({ error: 'You are already a member of another team. Leave that team before joining a new one.' });
    }

    await pool.query('UPDATE team_members SET status = $1, member_id = $2, joined_at = NOW() WHERE id = $3', ['active', req.userId, invite.id]);
    await pool.query('UPDATE users SET team_owner_id = $1 WHERE id = $2', [invite.owner_id, req.userId]);

    res.json({ success: true });
  } catch (e) {
    console.error('Team accept error:', e.message);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

app.put('/api/team/:id/permissions', authRequired, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT team_owner_id FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows[0]?.team_owner_id) return res.status(403).json({ error: 'Only the account owner can manage permissions' });

    const perms = sanitizePermissions(req.body.permissions);
    const result = await pool.query(
      `UPDATE team_members SET permissions = $1 WHERE id = $2 AND owner_id = $3 RETURNING id`,
      [JSON.stringify(perms), req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team member not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update permissions' }); }
});

app.delete('/api/team/:id', authRequired, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT team_owner_id FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows[0]?.team_owner_id) return res.status(403).json({ error: 'Only the account owner can remove team members' });

    const memberResult = await pool.query('SELECT member_id FROM team_members WHERE id = $1 AND owner_id = $2', [req.params.id, req.userId]);
    if (!memberResult.rows.length) return res.status(404).json({ error: 'Team member not found' });

    await pool.query(`UPDATE team_members SET status = 'removed' WHERE id = $1`, [req.params.id]);
    if (memberResult.rows[0].member_id) {
      await pool.query('UPDATE users SET team_owner_id = NULL WHERE id = $1', [memberResult.rows[0].member_id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove team member' }); }
});

app.get('/api/user/consultations', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId); // shared history across the whole team
    const plan = account?.plan || 'starter';
    if (!PLAN_LIMITS[plan]?.history) {
      return res.json({ consultations: [], upgradeRequired: true });
    }
    const result = await pool.query(
      'SELECT * FROM consultations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [account.id]
    );
    res.json({ consultations: result.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/user/consultations/:id', authRequired, async (req, res) => {
  try {
    const consult = await pool.query(
      'SELECT * FROM consultations WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]
    );
    if (!consult.rows.length) return res.status(404).json({ error: 'Not found' });
    const messages = await pool.query(
      'SELECT * FROM messages WHERE consultation_id = $1 ORDER BY created_at', [req.params.id]
    );
    res.json({ consultation: consult.rows[0], messages: messages.rows });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSULTATION (BOARD) ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── Auto-match: suggest the best director for a described challenge ────────
app.post('/api/board/match', authRequired, async (req, res) => {
  const { challenge, directors: rawDirectors } = req.body; // directors: [{id,name,role}]
  if (!challenge || !rawDirectors || !rawDirectors.length) {
    return res.status(400).json({ error: 'Missing challenge or director list' });
  }
  // Defensively drop any malformed entries — client-supplied data should
  // never be able to crash the server, regardless of how it got malformed.
  const directors = rawDirectors.filter(d => d && d.id && d.name && d.role);
  if (!directors.length) {
    return res.status(400).json({ error: 'No valid directors in the provided list' });
  }

  try {
    const matchPrompt = `A founder described this challenge: "${challenge}"

Here is the list of available board directors, each with their specialty:
${directors.map(d => `- ${d.id}: ${d.name} — ${d.role}`).join('\n')}

Pick the ONE director whose specialty best matches this challenge. Return ONLY the director's id (the short lowercase code before the colon), nothing else — no explanation, no punctuation.`;

    const result = await askClaude(matchPrompt, [{ role: 'user', content: 'Which director id matches best?' }], { feature: 'board_match' });
    const matchedId = result.trim().toLowerCase().replace(/[^a-z]/g, '');
    const valid = directors.find(d => d.id === matchedId);
    res.json({ directorId: valid ? matchedId : directors[0].id });
  } catch (err) {
    console.error('Match error:', err.message);
    res.json({ directorId: directors[0].id }); // graceful fallback
  }
});

app.post('/api/board/chat', authRequired, async (req, res) => {
  const { persona, messages, ai, directorId, consultationId, language = 'en', businessId } = req.body;

  try {
    const u = await resolveAccount(req.userId); // team members share the owner's plan/limits
    if (!u) return res.status(404).json({ error: 'Account not found' });
    const limits = PLAN_LIMITS[u.plan] || PLAN_LIMITS.starter;

    // Check director access
    if (u.plan === 'starter' && directorId && !STARTER_DIRECTORS.includes(directorId)) {
      return res.status(403).json({ error: 'This director is available on Arreyon Pro and above', upgradeRequired: true });
    }

    // Check consultation limits (reset monthly)
    const resetDate = new Date(u.consultations_reset_date);
    const now = new Date();
    if (now.getMonth() !== resetDate.getMonth() || now.getFullYear() !== resetDate.getFullYear()) {
      await pool.query('UPDATE users SET consultations_used = 0, consultations_reset_date = NOW() WHERE id = $1', [u.id]);
      u.consultations_used = 0;
    }

    if (limits.consultations !== -1 && u.consultations_used >= limits.consultations) {
      return res.status(403).json({ error: `Monthly consultation limit reached (${limits.consultations}/month). Upgrade for more.`, upgradeRequired: true });
    }

    // Optional business link — validated against this account before ever
    // being trusted, same pattern used for Entrepreneur Mode's linking.
    // Failure here is silent and non-fatal: Boardroom must keep working
    // exactly as before for anyone not using this feature, or if the lookup
    // itself fails for any reason.
    let businessContextText = '';
    if (businessId) {
      try {
        const context = await getBusinessContext(businessId, u.id);
        businessContextText = summarizeBusinessContextForAI(context);
      } catch (e) { console.error('Boardroom business context lookup failed (non-fatal):', e.message); }
    }

    const localizedPersona = persona + frenchInstruction(language) + businessContextText;

    // Call the appropriate AI
    let reply;
    const selectedAI = ai || 'claude';

    if (selectedAI === 'chatgpt') {
      reply = await askChatGPT(localizedPersona, messages, { feature: 'boardroom_chat', userId: req.userId });
    } else if (selectedAI === 'gemini') {
      reply = await askGemini(localizedPersona, messages, { feature: 'boardroom_chat', userId: req.userId });
    } else if (selectedAI === 'perplexity') {
      reply = await askPerplexity(localizedPersona, messages, { feature: 'boardroom_chat', userId: req.userId });
    } else {
      reply = await askClaude(localizedPersona, messages, { feature: 'boardroom_chat', userId: req.userId });
    }

    res.json({ reply, ai: selectedAI });
  } catch(e) {
    console.error('Board chat error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CHAIRMAN SYNTHESIS — Increment 4, part 3
// Reviews all director conversations from a live Boardroom session, identifies
// disagreements between directors, and produces one final synthesized verdict.
// Pro/Business only — same tier as the multi-director market research feature.
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/board/synthesize', authRequired, async (req, res) => {
  const { conversations, language = 'en' } = req.body; // [{ directorName, directorRole, messages: [{from,text}] }]

  if (!conversations || !Array.isArray(conversations) || !conversations.length) {
    return res.status(400).json({ error: 'No conversations to synthesize. Chat with at least one director first.' });
  }

  try {
    const account = await resolveAccount(req.userId); // team members share the owner's plan
    const plan = account?.plan || 'starter';
    if (plan === 'starter') {
      return res.status(403).json({ error: 'Chairman Synthesis (a final board verdict across your conversations) is available on Arreyon Pro and above.', upgradeRequired: true });
    }

    // Build a transcript per director, capped so a very long session doesn't blow the token budget
    const transcripts = conversations.map(c => {
      const lines = (c.messages || []).slice(-16).map(m => `${m.from === 'you' ? 'Founder' : c.directorName}: ${m.text}`).join('\n');
      return `=== ${c.directorName} (${c.directorRole || 'Board Member'}) ===\n${lines}`;
    }).join('\n\n');

    const multiDirector = conversations.length > 1;

    const prompt = `You are the Chairman of the Board at Arreyon Consult, synthesizing a live boardroom session into one final decision for the founder.

${multiDirector ? `The founder spoke with ${conversations.length} different board members in this session.` : `The founder spoke with one board member in this session.`}

FULL CONVERSATION TRANSCRIPTS:
${transcripts.slice(0, 10000)}

YOUR TASK:
1. Identify the founder's core problem or question, based on what they actually discussed.
2. Summarize the key advice given${multiDirector ? ' by each director' : ''}.
${multiDirector ? '3. Identify any disagreements or tensions between what different directors advised — do not paper over conflicting advice, name it explicitly.\n4. Weigh the disagreement and determine which position is better supported by sound business reasoning, or whether it depends on a specific unstated assumption (state what that assumption is).\n5.' : '3.'} Produce ONE final, clear recommendation — the Chairman's verdict — that the founder should act on.
${multiDirector ? '6.' : '4.'} State your confidence in this verdict and why.

Be decisive. The founder came to the board for a boardroom-grade final answer, not a menu of options.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "core_problem": "the founder's actual problem or question, in one sentence",
  "key_advice": [
    {"director": "Director Name", "summary": "their core advice, 1-2 sentences"}
  ],
  "disagreements": "Only include this key if multiple directors gave conflicting advice — describe the disagreement and which side has stronger reasoning, or omit this key entirely if directors were aligned or only one director was consulted",
  "chairman_verdict": "The final, decisive recommendation — 2-4 sentences, clear and actionable",
  "confidence": "high|medium|low",
  "confidence_reason": "why this confidence level — what's solid vs. uncertain about this verdict"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the Chairman synthesis now, as JSON only.' }], complexity: 'complex', context: { feature: 'chairman_synthesis', userId: req.userId }, maxTokens: 2000 });
    let synthesis;

    try {

      synthesis = extractJSON(raw);

    } catch (e) {

      console.error('Chairman synthesis JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));

      throw new Error('Could not produce the board verdict — please try again');

    }

    // Persisted so the Home dashboard can surface the most recent verdict
    // (DASH-04) — previously this result was generated and returned live
    // with nothing saved, so there was nothing for the dashboard to show.
    // Saved to the account owner, not req.userId directly, matching the
    // "team members share the owner's plan" pattern already used above —
    // a team member's verdict should surface for the whole account, not
    // be invisible to the owner viewing their own dashboard.
    try {
      await pool.query(
        `INSERT INTO chairman_syntheses (owner_id, core_problem, chairman_verdict, confidence, director_count, full_synthesis)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [account.id, synthesis.core_problem || null, synthesis.chairman_verdict || null, synthesis.confidence || null, conversations.length, JSON.stringify(synthesis)]
      );
    } catch (e) {
      // Non-fatal — the founder still gets their verdict even if saving
      // it for the dashboard fails for some reason.
      console.error('Chairman synthesis persistence failed (non-fatal):', e.message);
    }

    res.json({ success: true, synthesis });
  } catch (err) {
    console.error('Chairman synthesis error:', err.message);
    res.status(500).json({ error: err.message || 'Synthesis failed. Please try again.' });
  }
});

// DASH-04 — most recent Chairman Synthesis for the Home dashboard.
app.get('/api/dashboard/latest-verdict', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      'SELECT core_problem, chairman_verdict, confidence, director_count, created_at FROM chairman_syntheses WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1',
      [account.id]
    );
    res.json({ verdict: result.rows[0] || null });
  } catch (e) {
    console.error('Latest verdict fetch error:', e.message);
    res.status(500).json({ error: 'Failed to load latest board verdict' });
  }
});

// DASH-06 — Recent Activity feed. Pulls from 5 existing tables that were
// never before combined into one view. Two different scoping conventions
// are already established elsewhere in this codebase and are respected
// here rather than unified into one for convenience: research_sessions
// and entrepreneur_sessions are scoped per logged-in user (matching their
// own existing list endpoints), while action_tasks, leads, and
// chairman_syntheses are scoped to the shared account owner (matching how
// team members already see the same tasks/leads/verdicts elsewhere).
app.get('/api/dashboard/recent-activity', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);

    const [research, entrepreneur, tasks, leadsAdded, verdicts] = await Promise.all([
      pool.query('SELECT id, query, created_at FROM research_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [req.userId]),
      pool.query(`SELECT id, mode, business_plan IS NOT NULL AS has_plan, created_at FROM entrepreneur_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [req.userId]),
      pool.query(`SELECT id, title, completed_at FROM action_tasks WHERE owner_id = $1 AND status = 'done' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 5`, [account.id]),
      pool.query('SELECT id, name, created_at FROM leads WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 5', [account.id]),
      pool.query('SELECT id, core_problem, created_at FROM chairman_syntheses WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 5', [account.id])
    ]);

    const activity = [
      ...research.rows.map(r => ({ type: 'research', label: r.query, timestamp: r.created_at })),
      ...entrepreneur.rows.map(r => ({ type: r.has_plan ? 'business_plan' : 'entrepreneur', label: r.has_plan ? null : r.mode, timestamp: r.created_at })),
      ...tasks.rows.map(r => ({ type: 'task_completed', label: r.title, timestamp: r.completed_at })),
      ...leadsAdded.rows.map(r => ({ type: 'lead_added', label: r.name, timestamp: r.created_at })),
      ...verdicts.rows.map(r => ({ type: 'verdict', label: r.core_problem, timestamp: r.created_at }))
    ]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 8);

    res.json({ activity });
  } catch (e) {
    console.error('Recent activity fetch error:', e.message);
    res.status(500).json({ error: 'Failed to load recent activity' });
  }
});

// DASH-03 — Top Priorities. Curated, not overwhelming: pulls from 3 sources
// that already exist (Business X-Ray's bottleneck, Business Intelligence's
// priority problems, and high-priority open tasks) rather than a fourth,
// separately-maintained priorities list. Self-contained — determines the
// "primary" business itself using the exact same ordering /api/business
// uses (most recently updated active business), rather than requiring the
// frontend to pass one and risking a race against its own separate fetch.
app.get('/api/dashboard/top-priorities', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);

    const bizResult = await pool.query(
      'SELECT id, name, business_xray, intelligence_snapshot FROM businesses WHERE user_id = $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1',
      [account.id]
    );
    const business = bizResult.rows[0];

    const priorities = [];

    if (business?.business_xray?.bottleneck_reasoning) {
      priorities.push({
        type: 'xray_bottleneck',
        text: business.business_xray.bottleneck_reasoning,
        businessId: business.id
      });
    }

    if (business?.intelligence_snapshot?.priority_problems?.length) {
      business.intelligence_snapshot.priority_problems.slice(0, 2).forEach(p => {
        priorities.push({ type: 'priority_problem', text: p, businessId: business.id });
      });
    }

    const tasksResult = await pool.query(
      `SELECT id, title, business_id FROM action_tasks WHERE owner_id = $1 AND priority = 'high' AND status != 'done'
       ORDER BY due_date ASC NULLS LAST, created_at DESC LIMIT 3`,
      [account.id]
    );
    tasksResult.rows.forEach(task => {
      priorities.push({ type: 'high_priority_task', text: task.title, businessId: task.business_id, taskId: task.id });
    });

    res.json({ priorities: priorities.slice(0, 5), businessName: business?.name || null });
  } catch (e) {
    console.error('Top priorities fetch error:', e.message);
    res.status(500).json({ error: 'Failed to load top priorities' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENTREPRENEUR MODE — Increment 5
// For users who don't have a business yet. Two paths:
//   A) Opportunity Finder — no idea yet, find suitable opportunities
//   B) Idea Validation — has an idea, wants a straight VALIDATE/MODIFY/RECONSIDER
// Research-backed (Tavily) on Pro/Business; AI-reasoning-only on Starter, clearly
// labeled as such so nothing looks more grounded than it is.
// ═══════════════════════════════════════════════════════════════════════════

function formatEntrepreneurContext(input) {
  const parts = [];
  if (input.country) parts.push(`Location: ${input.city ? input.city + ', ' : ''}${input.country}`);
  if (input.primarySkill) parts.push(`Primary skill (their strongest — weight opportunity suggestions toward this first): ${input.primarySkill}`);
  if (input.otherSkills) parts.push(`Other skills: ${input.otherSkills}`);
  if (input.experience) parts.push(`Experience: ${input.experience}`);
  if (input.interests) parts.push(`Interests: ${input.interests}`);
  if (input.capital) parts.push(`Available capital: ${input.capital}`);
  if (input.time) parts.push(`Available time: ${input.time}`);
  if (input.incomeTarget) parts.push(`Income target: ${input.incomeTarget}`);
  if (input.preference) parts.push(`Preference: ${input.preference}`);
  if (input.riskTolerance) parts.push(`Risk tolerance: ${input.riskTolerance}`);
  return parts.join('\n');
}

// ── A) Opportunity Finder ───────────────────────────────────────────────────
app.post('/api/entrepreneur/find-opportunities', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    const researchBacked = plan === 'pro' || plan === 'business';

    const input = req.body || {};
    if (!input.country && !input.primarySkill && !input.otherSkills && !input.interests) {
      return res.status(400).json({ error: 'Please provide at least your location, skills, or interests to find relevant opportunities.' });
    }

    const context = formatEntrepreneurContext(input);
    let sourcesText = '', sources = [];

    if (researchBacked) {
      const queries = [];
      const locationPart = input.country ? `in ${input.city ? input.city + ', ' : ''}${input.country}` : '';
      if (input.interests) queries.push(`small business opportunities ${input.interests} ${locationPart} 2026`.trim());
      if (input.primarySkill) queries.push(`how to start a business with ${input.primarySkill} skills ${locationPart}`.trim());
      if (!queries.length) queries.push(`profitable small business ideas low capital ${locationPart}`.trim());

      const allSources = [];
      for (const q of queries) {
        try {
          const results = await researchSearch(q, { maxResults: 4 });
          allSources.push(...results);
        } catch (e) { continue; }
      }
      const seen = new Set();
      sources = allSources.filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });
      sourcesText = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet || ''}`).join('\n\n');
    }

    const prompt = `You are a practical business opportunity advisor helping an aspiring entrepreneur find a suitable business to start. Do NOT give generic ideas — ground every suggestion in their actual circumstances below.

THEIR CIRCUMSTANCES:
${context || 'Limited information provided — work with what is given and note where more detail would sharpen the recommendations.'}

${researchBacked ? `REAL MARKET RESEARCH RESULTS:\n${sourcesText.slice(0, 6000)}\n\nGround your opportunities in this research where relevant — cite using source_ref.` : `NOTE: No live market research was conducted for this request (available on Arreyon Pro and above). Base your suggestions on general business knowledge, and be appropriately humble about demand/competition claims since they are not verified against current market data.`}

YOUR TASK:
Suggest 3-4 realistic business opportunities that genuinely fit THIS person's skills, capital, time, and risk tolerance — not a generic list. For each one, explain specifically why it fits them.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "opportunities": [
    {
      "name": "short opportunity name",
      "description": "what this business would actually involve, 1-2 sentences",
      "why_it_fits": "specifically tied to their skills/capital/time/interests — not generic",
      "demand": "high|medium|low",
      "competition": "high|medium|low",
      "startup_cost_estimate": "realistic estimate given their stated capital",
      "time_to_first_revenue": "realistic estimate given their stated available time",
      "potential_margin": "high|medium|low",
      "customer_acquisition_difficulty": "high|medium|low",
      "scalability": "high|medium|low",
      "risk": "high|medium|low"${researchBacked ? ',\n      "source_ref": "1 (optional, only if grounded in a specific source above)"' : ''}
    }
  ],
  "overall_recommendation": "which ONE opportunity to prioritize first and why, 2-3 sentences",
  "what_to_learn_first": "the single most important skill or knowledge gap to close before starting, if any"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(input.language, { jsonMode: true }), messages: [{ role: 'user', content: 'Find the opportunities now, as JSON only.' }], complexity: 'complex', context: { feature: 'entrepreneur_mode', userId: req.userId }, maxTokens: 2800 });
    let structured;
    try {
      structured = extractJSON(raw);
    } catch (e) {
      console.error('Opportunity finder JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate opportunities — please try again');
    }
    if (!Array.isArray(structured.opportunities)) {
      console.error('Find-opportunities returned a malformed shape:', typeof structured.opportunities);
      throw new Error('Could not generate opportunities — please try again');
    }

    // Optional link to an existing business — validated against the resolved
    // account (not just req.userId) so a team member can link to a business
    // the whole team shares, but never to one they don't have access to.
    let linkedBusinessId = null;
    if (req.body.businessId) {
      const bizCheck = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.body.businessId, account.id]);
      if (bizCheck.rows.length) linkedBusinessId = req.body.businessId;
    }

    const session = await pool.query(
      `INSERT INTO entrepreneur_sessions (user_id, mode, input_data, structured_output, research_backed, business_id) VALUES ($1, 'opportunity_finder', $2, $3, $4, $5) RETURNING id, created_at`,
      [req.userId, JSON.stringify(input), JSON.stringify(structured), researchBacked, linkedBusinessId]
    );

    res.json({ success: true, sessionId: session.rows[0].id, structured, sources, researchBacked, linkedBusinessId });
  } catch (err) {
    console.error('Opportunity finder error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to find opportunities. Please try again.' });
  }
});

// Generates additional opportunities beyond the original set — reuses the
// founder's original circumstances (stored on the session) rather than
// asking the frontend to resend the whole form, and explicitly tells the AI
// which opportunities have already been shown so it doesn't just repeat them.
app.post('/api/entrepreneur/:sessionId/more-opportunities', authRequired, async (req, res) => {
  try {
    const sessionResult = await pool.query(
      'SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2 AND mode = $3',
      [req.params.sessionId, req.userId, 'opportunity_finder']
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];
    const input = session.input_data;
    // Prefer the language sent with THIS request over whatever was stored
    // when the original search ran — the user may have switched language
    // since then, and "Show More" should follow their current preference,
    // not resurrect a stale one.
    const language = req.body?.language === 'fr' ? 'fr' : (req.body?.language === 'en' ? 'en' : input.language);
    const existingOpportunities = session.structured_output?.opportunities || [];
    const existingNames = existingOpportunities.map(o => o.name);

    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    const researchBacked = plan === 'pro' || plan === 'business';

    const context = formatEntrepreneurContext(input);
    let sourcesText = '', sources = [];

    if (researchBacked) {
      // Deliberately different query angles from the original round — same
      // "avoid repeats" goal as the exclusion list below, but for the search
      // results feeding the AI, not just the AI's own output.
      const locationPart = input.country ? `in ${input.city ? input.city + ', ' : ''}${input.country}` : '';
      const queries = [
        `alternative small business ideas ${locationPart} 2026`.trim(),
        `underserved niche business opportunities ${input.interests || ''} ${locationPart}`.trim()
      ];
      const allSources = [];
      for (const q of queries) {
        try {
          const results = await researchSearch(q, { maxResults: 4 });
          allSources.push(...results);
        } catch (e) { continue; }
      }
      const seen = new Set();
      sources = allSources.filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });
      sourcesText = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet || ''}`).join('\n\n');
    }

    const prompt = `You are a practical business opportunity advisor. This founder already saw an initial set of opportunity suggestions and wants MORE, DIFFERENT options — not the same ones repeated.

THEIR CIRCUMSTANCES:
${context || 'Limited information provided.'}

OPPORTUNITIES ALREADY SHOWN — DO NOT SUGGEST THESE AGAIN, even reworded:
${existingNames.map(n => `- ${n}`).join('\n')}

${researchBacked ? `REAL MARKET RESEARCH RESULTS:\n${sourcesText.slice(0, 6000)}\n\nGround your opportunities in this research where relevant — cite using source_ref.` : `NOTE: No live market research was conducted for this request (available on Arreyon Pro and above). Base your suggestions on general business knowledge.`}

YOUR TASK:
Suggest 3 NEW business opportunities, genuinely different in kind from what's already been shown (not just minor variations) — still realistically fitted to their skills, capital, time, and risk tolerance.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "opportunities": [
    {
      "name": "short opportunity name",
      "description": "what this business would actually involve, 1-2 sentences",
      "why_it_fits": "specifically tied to their skills/capital/time/interests — not generic",
      "demand": "high|medium|low",
      "competition": "high|medium|low",
      "startup_cost_estimate": "realistic estimate given their stated capital",
      "time_to_first_revenue": "realistic estimate given their stated available time",
      "potential_margin": "high|medium|low",
      "customer_acquisition_difficulty": "high|medium|low",
      "scalability": "high|medium|low",
      "risk": "high|medium|low"${researchBacked ? ',\n      "source_ref": "1 (optional, only if grounded in a specific source above)"' : ''}
    }
  ]
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Suggest more opportunities now, as JSON only.' }], complexity: 'complex', context: { feature: 'entrepreneur_mode', userId: req.userId }, maxTokens: 2200 });
    let additional;
    try {
      additional = extractJSON(raw);
    } catch (e) {
      console.error('More-opportunities JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate more opportunities — please try again');
    }
    if (!Array.isArray(additional.opportunities)) {
      // Guards against two failure modes: an object shape here would throw
      // on the spread below (caught, but with a confusing error message),
      // while a STRING shape wouldn't throw at all — it would silently
      // spread into individual characters, corrupting the saved data with
      // no error surfaced anywhere. Catch both explicitly instead.
      console.error('More-opportunities returned a malformed shape:', typeof additional.opportunities);
      throw new Error('Could not generate more opportunities — please try again');
    }

    // Append to the existing session rather than creating a new one, so the
    // full growing list stays together and can still be used to build a
    // Business Plan from any opportunity, old or new.
    const updatedOutput = { ...session.structured_output, opportunities: [...existingOpportunities, ...additional.opportunities] };
    await pool.query('UPDATE entrepreneur_sessions SET structured_output = $1, structured_output_fr = NULL WHERE id = $2', [JSON.stringify(updatedOutput), session.id]);

    res.json({ success: true, newOpportunities: additional.opportunities || [], allOpportunities: updatedOutput.opportunities, sources, researchBacked });
  } catch (err) {
    console.error('More opportunities error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to find more opportunities. Please try again.' });
  }
});

// ── B) Idea Validation ──────────────────────────────────────────────────────
app.post('/api/entrepreneur/validate-idea', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    const researchBacked = plan === 'pro' || plan === 'business';

    const input = req.body || {};
    if (!input.idea || input.idea.trim().length < 10) {
      return res.status(400).json({ error: 'Please describe your business idea in a bit more detail.' });
    }

    const context = formatEntrepreneurContext(input);
    let sourcesText = '', sources = [];

    if (researchBacked) {
      const locationPart = input.country ? `in ${input.city ? input.city + ', ' : ''}${input.country}` : '';
      const queries = [
        `${input.idea} business competitors ${locationPart}`.trim(),
        `${input.idea} market demand ${locationPart} 2026`.trim()
      ];
      const allSources = [];
      for (const q of queries) {
        try {
          const results = await researchSearch(q, { maxResults: 4 });
          allSources.push(...results);
        } catch (e) { continue; }
      }
      const seen = new Set();
      sources = allSources.filter(s => { if (seen.has(s.url)) return false; seen.add(s.url); return true; });
      sourcesText = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet || ''}`).join('\n\n');
    }

    const prompt = `You are a rigorous business idea validator. An aspiring entrepreneur has an idea and wants an honest assessment — not encouragement for its own sake.

THEIR IDEA: "${input.idea}"

THEIR CIRCUMSTANCES:
${context || 'Limited context provided.'}

${researchBacked ? `REAL MARKET RESEARCH RESULTS:\n${sourcesText.slice(0, 6000)}\n\nGround your assessment in this research — cite using source references where relevant.` : `NOTE: No live market research was conducted for this validation (available on Arreyon Pro and above). Base your assessment on general business reasoning, and be explicit that demand/competition claims are not verified against current market data.`}

YOUR TASK:
Do NOT simply validate the idea. Perform a structured, honest assessment covering: the problem it solves, target customer, demand, existing alternatives, competition, realistic pricing, startup requirements, unit economics, distribution, customer acquisition, risks, differentiation opportunity, and scalability.

Then give ONE final verdict:
- "validate" — the idea is sound as described, proceed
- "modify" — the core idea has merit but needs a specific change before proceeding
- "reconsider" — significant problems make this idea risky as currently conceived

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "problem_addressed": "the real problem this solves, one sentence",
  "target_customer": "who specifically would pay for this",
  "demand_assessment": "honest read on demand, with reasoning",
  "existing_alternatives": ["what people currently do instead"],
  "competition_level": "high|medium|low, with brief reasoning",
  "suggested_pricing": "a realistic pricing approach",
  "startup_requirements": "what's genuinely needed to start, given their stated capital/time",
  "unit_economics_note": "rough sense of whether the numbers could work",
  "distribution_channels": "how customers would realistically be reached",
  "customer_acquisition_strategy": "a concrete first approach",
  "risks": ["specific risk 1", "specific risk 2"],
  "differentiation_opportunity": "how this could stand out, if it can",
  "scalability_note": "growth ceiling and what would need to change to scale",
  "verdict": "validate|modify|reconsider",
  "verdict_reasoning": "the core reasoning behind the verdict, 2-3 sentences — be direct"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(input.language, { jsonMode: true }), messages: [{ role: 'user', content: 'Validate the idea now, as JSON only.' }], complexity: 'complex', context: { feature: 'entrepreneur_mode', userId: req.userId }, maxTokens: 2800 });
    let structured;
    try {
      structured = extractJSON(raw);
    } catch (e) {
      console.error('Idea validation JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not validate the idea — please try again');
    }

    let linkedBusinessId = null;
    if (req.body.businessId) {
      const bizCheck = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.body.businessId, account.id]);
      if (bizCheck.rows.length) linkedBusinessId = req.body.businessId;
    }

    const session = await pool.query(
      `INSERT INTO entrepreneur_sessions (user_id, mode, input_data, structured_output, research_backed, business_id) VALUES ($1, 'idea_validation', $2, $3, $4, $5) RETURNING id, created_at`,
      [req.userId, JSON.stringify(input), JSON.stringify(structured), researchBacked, linkedBusinessId]
    );

    res.json({ success: true, sessionId: session.rows[0].id, structured, sources, researchBacked, linkedBusinessId });
  } catch (err) {
    console.error('Idea validation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to validate idea. Please try again.' });
  }
});

// ── Entrepreneur Mode history ───────────────────────────────────────────────
app.get('/api/entrepreneur/sessions', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const result = await pool.query(
      'SELECT id, mode, input_data, structured_output, structured_output_fr, research_backed, discussion_messages, discussion_messages_fr, business_plan, business_plan_fr, created_at FROM entrepreneur_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );

    if (lang === 'fr' && result.rows.length) {
      // Each session can need up to 3 separate translations (main result,
      // business plan, discussion thread) — run everything needed in
      // parallel, bounded by the slowest single call rather than the sum.
      const jobs = [];
      for (const session of result.rows) {
        if (session.structured_output && !session.structured_output_fr) {
          jobs.push({ session, field: 'structured_output', promise: translateStructuredContent(session.structured_output, session.mode === 'opportunity_finder' ? 'business opportunity report' : 'business idea validation report') });
        }
        if (session.business_plan && !session.business_plan_fr) {
          // computed_financials is language-neutral numeric data, not
          // narrative text — strip it before the translation call (re-attached
          // in the result-handling loop below) so it can't be silently
          // dropped or altered by the AI translation pass.
          const { computed_financials, ...planForTranslation } = session.business_plan;
          jobs.push({ session, field: 'business_plan', computedFinancials: computed_financials, promise: translateStructuredContent(planForTranslation, 'business plan') });
        }
        if (session.discussion_messages?.length && !session.discussion_messages_fr) {
          jobs.push({ session, field: 'discussion_messages', promise: translateStructuredContent(session.discussion_messages, 'discussion chat thread') });
        }
      }

      if (jobs.length) {
        const outcomes = await Promise.allSettled(jobs.map(j => j.promise));
        for (let i = 0; i < jobs.length; i++) {
          const { session, field, computedFinancials } = jobs[i];
          const outcome = outcomes[i];
          if (outcome.status !== 'fulfilled') {
            console.error(`Entrepreneur session translation failed for ${field}:`, outcome.reason?.message);
            continue;
          }
          const translated = outcome.value;
          if (field === 'business_plan' && computedFinancials) translated.computed_financials = computedFinancials;
          const column = field + '_fr';
          try {
            await pool.query(`UPDATE entrepreneur_sessions SET ${column} = $1 WHERE id = $2`, [JSON.stringify(translated), session.id]);
          } catch (e) { /* non-fatal — still return the translated content for this response even if the cache write fails */ }
          session[column] = translated;
        }
      }

      result.rows.forEach(session => {
        if (session.structured_output_fr) session.structured_output = session.structured_output_fr;
        if (session.business_plan_fr) session.business_plan = session.business_plan_fr;
        if (session.discussion_messages_fr) session.discussion_messages = session.discussion_messages_fr;
      });
    }

    res.json({ sessions: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load sessions' }); }
});

// ── Discuss the results — follow-up chat grounded in that specific session ──
app.post('/api/entrepreneur/:sessionId/discuss', authRequired, async (req, res) => {
  const { message, language = 'en' } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  try {
    const sessionResult = await pool.query(
      'SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2',
      [req.params.sessionId, req.userId]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];

    const priorMessages = session.discussion_messages || [];
    const isOpp = session.mode === 'opportunity_finder';

    const contextSummary = isOpp
      ? `The user requested business opportunities matching their circumstances: ${JSON.stringify(session.input_data)}\n\nHere are the opportunities generated:\n${JSON.stringify(session.structured_output)}`
      : `The user validated this business idea: "${session.input_data.idea}"\n\nHere is the validation result:\n${JSON.stringify(session.structured_output)}`;

    const persona = `You are a knowledgeable, direct business advisor at Arreyon Consult. You already produced the ${isOpp ? 'opportunity analysis' : 'idea validation'} below for this founder, and they now want to discuss it — ask questions, push back, or explore a specific point further.

${contextSummary}

Stay grounded in what was actually generated above — don't contradict it without good reason, but do engage honestly if they raise a fair challenge. Keep responses focused and conversational, 2-4 sentences unless genuinely more detail is needed. Do not restate the entire original report.${frenchInstruction(language)}`;

    const chatMessages = [
      ...priorMessages.map(m => ({ role: m.from === 'you' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: message }
    ];

    const reply = await askClaude(persona, chatMessages, { feature: 'entrepreneur_mode', userId: req.userId }, 800);

    const updatedMessages = [...priorMessages, { from: 'you', text: message }, { from: 'them', text: reply }];
    // Clear the cached French translation too — otherwise, since this array
    // only ever grows, a stale discussion_messages_fr would completely hide
    // this brand-new exchange from the French view (the whole array gets
    // swapped in wholesale wherever it's read, not merged).
    await pool.query('UPDATE entrepreneur_sessions SET discussion_messages = $1, discussion_messages_fr = NULL WHERE id = $2', [JSON.stringify(updatedMessages), req.params.sessionId]);

    res.json({ reply, discussionMessages: updatedMessages });
  } catch (err) {
    console.error('Entrepreneur discuss error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to respond. Please try again.' });
  }
});

// ── Generate a full business plan from a validated idea or chosen opportunity ──
app.post('/api/entrepreneur/:sessionId/business-plan', authRequired, async (req, res) => {
  const { chosenOpportunityName, language = 'en', estimatedMonthlyRevenue, estimatedMonthlyCosts, estimatedStartupCost } = req.body;

  try {
    const sessionResult = await pool.query(
      'SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2',
      [req.params.sessionId, req.userId]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];
    const isOpp = session.mode === 'opportunity_finder';

    let businessDescription;
    if (isOpp) {
      const chosen = (session.structured_output.opportunities || []).find(o => o.name === chosenOpportunityName);
      if (!chosen) return res.status(400).json({ error: 'Please specify which opportunity to build a plan for.' });
      businessDescription = `${chosen.name}: ${chosen.description}`;
    } else {
      businessDescription = session.input_data.idea;
    }

    const context = formatEntrepreneurContext(session.input_data);

    // If the founder gave us real revenue/cost/startup-cost estimates, run
    // them through the SAME deterministic math engine that powers Scenario
    // Analysis — real arithmetic, not an AI guess — and hand the AI verified
    // numbers to build a narrative around instead of asking it to invent
    // plausible-sounding figures. Entirely optional: if these weren't
    // provided, the plan falls back to the AI's own estimate exactly as before.
    const computedFinancials = computeScenarioFinancials({
      monthlyRevenueImpact: estimatedMonthlyRevenue,
      monthlyCostImpact: estimatedMonthlyCosts,
      oneTimeInvestment: estimatedStartupCost,
      timeframeMonths: 12
    });

    const financialInstruction = computedFinancials
      ? (language === 'fr'
        ? `\nDONNÉES FINANCIÈRES VÉRIFIÉES (calculées par un moteur déterministe, non estimées — utilisez ces chiffres EXACTS dans financial_snapshot, ne recalculez pas et n'inventez pas d'autres chiffres) :
- Coût de démarrage estimé : ${computedFinancials.investment !== null ? computedFinancials.investment : 'non fourni'}
- Gain mensuel net (revenu moins coûts) : ${computedFinancials.netMonthlyGain}
- Période de rentabilité : ${computedFinancials.paybackMonths !== null ? computedFinancials.paybackMonths + ' mois' : "n'atteint pas la rentabilité à ce rythme — signalez-le honnêtement dans key_assumption"}
- ROI sur 12 mois : ${computedFinancials.roiPct !== null ? computedFinancials.roiPct + '%' : 'non calculable (aucun coût de démarrage fourni)'}
Pour les champs de financial_snapshot, utilisez ces chiffres EXACTS — ne les remplacez jamais par votre propre estimation — mais expliquez le raisonnement derrière eux avec 2-3 phrases par champ.`
        : `\nVERIFIED FINANCIAL BASELINE (computed by deterministic calculator, not estimated — use these EXACT figures in financial_snapshot, do not recalculate or invent different numbers):
- Estimated startup cost: ${computedFinancials.investment !== null ? computedFinancials.investment : 'not provided'}
- Net monthly gain (revenue minus costs): ${computedFinancials.netMonthlyGain}
- Payback/breakeven period: ${computedFinancials.paybackMonths !== null ? computedFinancials.paybackMonths + ' months' : 'does not break even at this rate — flag this honestly as key_assumption'}
- 12-month ROI: ${computedFinancials.roiPct !== null ? computedFinancials.roiPct + '%' : 'not calculable (no startup cost provided)'}
For the financial_snapshot fields, use these EXACT figures — never substitute your own estimate — but explain the reasoning behind them in 2-3 sentences per field.`)
      : '';

    const prompt = `You are a business planning consultant at Arreyon Consult. Build a complete, practical business plan for this founder.

BUSINESS: ${businessDescription}

FOUNDER'S CIRCUMSTANCES:
${context || 'Limited context available.'}
${financialInstruction}

${isOpp ? `PRIOR OPPORTUNITY ANALYSIS:\n${JSON.stringify((session.structured_output.opportunities || []).find(o => o.name === chosenOpportunityName))}` : `PRIOR IDEA VALIDATION:\n${JSON.stringify(session.structured_output)}`}

YOUR TASK:
Produce a complete, detailed, professional business plan grounded in the founder's actual stated capital and time — not a generic template, and not a thin summary. Write this as if it will be read by a real investor: specific, substantive, and well-reasoned in every section. Marketing must be a genuinely separate, detailed section — not a single throwaway line.

DEPTH: Every section — including Financial Snapshot — should be written in full, professional detail: multiple sentences per field where the topic warrants it, with concrete specifics (real numbers, named channels, named competitors or comparable businesses where relevant) and genuine reasoning behind each figure or conclusion, rather than a bare number with no justification. This should read like a document worth submitting to an investor, not a bullet-point outline.

FINANCIAL SNAPSHOT: if verified financial figures are provided above, restate those exact numbers — never recalculate or invent different ones — but explain the reasoning behind them (why this startup cost, what drives the monthly operating cost, what the breakeven timeline assumes) rather than stating the number alone.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "business_model": {
    "value_proposition": "the core value delivered — 2-3 sentences with real specificity, not a slogan",
    "customer_segments": "who specifically this serves, described in real detail — demographics, behavior, why they need this",
    "revenue_streams": ["stream 1 with a brief explanation of how it works", "stream 2"],
    "cost_structure": ["major cost 1 with rough scale", "major cost 2"],
    "key_resources": ["what's needed to operate, specifically"],
    "key_activities": ["what must be done regularly, specifically"],
    "key_partners": ["who to partner with, if relevant, and why"],
    "channels": ["how customers are reached, specifically"]
  },
  "strategy": {
    "positioning": "how this should be positioned in the market — 2-3 sentences with real reasoning",
    "competitive_advantage": "the specific edge this has or must build, explained substantively",
    "differentiation": "what makes this different from alternatives, named specifically where possible"
  },
  "marketing_plan": {
    "target_audience": "the specific customer profile marketing should focus on, in real detail",
    "key_messaging": "the core message/hook that should appear in all marketing, with reasoning for why it will resonate",
    "marketing_channels": ["specific channel 1 (e.g. WhatsApp groups, Instagram), with why it fits this audience", "specific channel 2"],
    "content_strategy": "what kind of content to post and how often, concretely, with reasoning",
    "promotional_tactics": ["specific tactic 1 (e.g. referral discount, launch offer), explained", "specific tactic 2"],
    "customer_acquisition_funnel": "the step-by-step path from stranger to paying customer, specific to this business, described in full",
    "marketing_budget_estimate": "realistic monthly marketing spend given their stated capital, with brief reasoning"
  },
  "execution_plan": {
    "phase_30_days": ["specific task 1 with brief context on why it's first", "specific task 2", "specific task 3"],
    "phase_60_days": ["specific task 1", "specific task 2"],
    "phase_90_days": ["specific task 1", "specific task 2"]
  },
  "financial_snapshot": {
    "estimated_startup_cost": "a figure or narrow range, with 2-3 sentences explaining what makes up this cost",
    "monthly_operating_cost": "a figure or narrow range, with 2-3 sentences explaining the main components driving it",
    "breakeven_estimate": "a timeframe, with 2-3 sentences explaining the assumptions behind it",
    "key_assumption": "the single biggest assumption this plan rests on, explained in full with its implications"
  }
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Build the complete, detailed business plan now, as JSON only.' }], complexity: 'complex', context: { feature: 'entrepreneur_mode', userId: req.userId }, maxTokens: 9000 });
    let plan;
    try {
      plan = extractJSON(raw);
    } catch (e) {
      console.error('Business plan JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate the business plan — please try again');
    }

    // Attach the raw computed figures too (not just the AI's restated prose)
    // so the frontend can optionally show exact numbers alongside them.
    if (computedFinancials) plan.computed_financials = computedFinancials;

    // Clear any previously cached French translation too — otherwise a
    // regenerated plan (e.g. different opportunity chosen, or financial
    // inputs added/changed) would silently keep showing the STALE translation
    // of the OLD content the next time it's viewed in French.
    await pool.query('UPDATE entrepreneur_sessions SET business_plan = $1, business_plan_fr = NULL WHERE id = $2', [JSON.stringify(plan), req.params.sessionId]);

    res.json({ success: true, businessPlan: plan });
  } catch (err) {
    console.error('Business plan error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate business plan. Please try again.' });
  }
});

// Regenerates ONE section of an already-generated business plan, merging it
// into the existing plan rather than requiring a full regeneration — the
// existing plan's OTHER sections are sent as context so the regenerated
// section stays consistent with what's already there instead of drifting.
const BUSINESS_PLAN_SECTION_ARRAY_FIELDS = {
  business_model: ['revenue_streams', 'cost_structure', 'key_resources', 'key_activities', 'key_partners', 'channels'],
  strategy: [],
  marketing_plan: ['marketing_channels', 'promotional_tactics'],
  execution_plan: ['phase_30_days', 'phase_60_days', 'phase_90_days'],
  financial_snapshot: []
};
const BUSINESS_PLAN_SECTION_SHAPES = {
  business_model: `{
  "value_proposition": "the core value delivered — 2-3 sentences with real specificity, not a slogan",
  "customer_segments": "who specifically this serves, described in real detail — demographics, behavior, why they need this",
  "revenue_streams": ["stream 1 with a brief explanation of how it works", "stream 2"],
  "cost_structure": ["major cost 1 with rough scale", "major cost 2"],
  "key_resources": ["what's needed to operate, specifically"],
  "key_activities": ["what must be done regularly, specifically"],
  "key_partners": ["who to partner with, if relevant, and why"],
  "channels": ["how customers are reached, specifically"]
}`,
  strategy: `{
  "positioning": "how this should be positioned in the market — 2-3 sentences with real reasoning",
  "competitive_advantage": "the specific edge this has or must build, explained substantively",
  "differentiation": "what makes this different from alternatives, named specifically where possible"
}`,
  marketing_plan: `{
  "target_audience": "the specific customer profile marketing should focus on, in real detail",
  "key_messaging": "the core message/hook that should appear in all marketing, with reasoning for why it will resonate",
  "marketing_channels": ["specific channel 1 (e.g. WhatsApp groups, Instagram), with why it fits this audience", "specific channel 2"],
  "content_strategy": "what kind of content to post and how often, concretely, with reasoning",
  "promotional_tactics": ["specific tactic 1 (e.g. referral discount, launch offer), explained", "specific tactic 2"],
  "customer_acquisition_funnel": "the step-by-step path from stranger to paying customer, specific to this business, described in full",
  "marketing_budget_estimate": "realistic monthly marketing spend given their stated capital, with brief reasoning"
}`,
  execution_plan: `{
  "phase_30_days": ["specific task 1 with brief context on why it's first", "specific task 2", "specific task 3"],
  "phase_60_days": ["specific task 1", "specific task 2"],
  "phase_90_days": ["specific task 1", "specific task 2"]
}`,
  financial_snapshot: `{
  "estimated_startup_cost": "a figure or narrow range, with 2-3 sentences explaining what makes up this cost",
  "monthly_operating_cost": "a figure or narrow range, with 2-3 sentences explaining the main components driving it",
  "breakeven_estimate": "a timeframe, with 2-3 sentences explaining the assumptions behind it",
  "key_assumption": "the single biggest assumption this plan rests on, explained in full with its implications"
}`
};

app.post('/api/entrepreneur/:sessionId/business-plan/section', authRequired, async (req, res) => {
  const { section, language = 'en' } = req.body;
  if (!BUSINESS_PLAN_SECTION_SHAPES[section]) {
    return res.status(400).json({ error: 'Unknown section. Must be one of: ' + Object.keys(BUSINESS_PLAN_SECTION_SHAPES).join(', ') });
  }
  try {
    const sessionResult = await pool.query(
      'SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2',
      [req.params.sessionId, req.userId]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];
    if (!session.business_plan) return res.status(400).json({ error: 'No business plan exists yet for this session — generate the full plan first.' });

    const isOpp = session.mode === 'opportunity_finder';
    const businessDescription = isOpp
      ? (session.structured_output.opportunities || []).map(o => `${o.name}: ${o.description}`).join(' / ')
      : session.input_data?.idea;
    const context = formatEntrepreneurContext(session.input_data);

    const otherSections = { ...session.business_plan };
    delete otherSections[section];
    delete otherSections.computed_financials;

    // If financial_snapshot is the section being regenerated and verified
    // figures already exist, they must be restated exactly — otherwise the
    // AI has nothing but the vague prose in otherSections to reason from
    // and could invent different numbers than what's actually stored in
    // computed_financials, creating a real inconsistency in the plan.
    let financialInstruction = '';
    if (section === 'financial_snapshot' && session.business_plan.computed_financials) {
      const cf = session.business_plan.computed_financials;
      financialInstruction = language === 'fr'
        ? `\nDONNÉES FINANCIÈRES VÉRIFIÉES (calculées par un moteur déterministe, non estimées — utilisez ces chiffres EXACTS, ne recalculez pas et n'inventez pas d'autres chiffres) :
- Coût de démarrage estimé : ${cf.investment !== null ? cf.investment : 'non fourni'}
- Gain mensuel net (revenu moins coûts) : ${cf.netMonthlyGain}
- Période de rentabilité : ${cf.paybackMonths !== null ? cf.paybackMonths + ' mois' : "n'atteint pas la rentabilité à ce rythme — signalez-le honnêtement dans key_assumption"}
- ROI sur 12 mois : ${cf.roiPct !== null ? cf.roiPct + '%' : 'non calculable (aucun coût de démarrage fourni)'}
Utilisez ces chiffres EXACTS — ne les remplacez jamais par votre propre estimation — mais expliquez le raisonnement derrière eux avec 2-3 phrases par champ.`
        : `\nVERIFIED FINANCIAL BASELINE (computed by deterministic calculator, not estimated — use these EXACT figures, do not recalculate or invent different numbers):
- Estimated startup cost: ${cf.investment !== null ? cf.investment : 'not provided'}
- Net monthly gain (revenue minus costs): ${cf.netMonthlyGain}
- Payback/breakeven period: ${cf.paybackMonths !== null ? cf.paybackMonths + ' months' : 'does not break even at this rate — flag this honestly as key_assumption'}
- 12-month ROI: ${cf.roiPct !== null ? cf.roiPct + '%' : 'not calculable (no startup cost provided)'}
Use these EXACT figures — never substitute your own estimate — but explain the reasoning behind them in 2-3 sentences per field.`;
    }

    const lengthGuidance = 'DEPTH: Write this section in full, professional detail — multiple sentences per field where the topic warrants it, with concrete specifics and genuine reasoning behind each figure or conclusion, rather than vague generalities or a bare number with no justification. Consistent in depth with the rest of the plan shown above. This should read like part of a document worth submitting to an investor.';

    const prompt = `You are a business planning consultant at Arreyon Consult. This founder already has a complete business plan — regenerate ONLY the "${section}" section, keeping it consistent with the rest of the plan shown below. Do not contradict the other sections.

BUSINESS: ${businessDescription}

FOUNDER'S CIRCUMSTANCES:
${context || 'Limited context available.'}
${financialInstruction}

THE REST OF THE EXISTING PLAN (for consistency — do not regenerate these, only use them as context):
${JSON.stringify(otherSections)}

${lengthGuidance}

Return ONLY valid JSON for the "${section}" section, no markdown, in exactly this structure:
${BUSINESS_PLAN_SECTION_SHAPES[section]}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: `Regenerate the ${section} section now, as JSON only.` }], complexity: 'complex', context: { feature: 'entrepreneur_mode_section', userId: req.userId }, maxTokens: 3000 });

    let newSection;
    try {
      newSection = extractJSON(raw);
    } catch (e) {
      console.error(`Business plan section "${section}" JSON parse failed. Length:`, e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not regenerate this section — please try again');
    }
    for (const field of BUSINESS_PLAN_SECTION_ARRAY_FIELDS[section]) {
      if (!Array.isArray(newSection[field])) {
        console.error(`Business plan section "${section}" field "${field}" was not an array:`, typeof newSection[field]);
        throw new Error('Could not regenerate this section — please try again');
      }
    }

    const updatedPlan = { ...session.business_plan, [section]: newSection };
    // The regenerated section invalidates only the cached French translation
    // as a whole (translateStructuredContent has no notion of partial
    // re-translation), same as a full regeneration would.
    await pool.query('UPDATE entrepreneur_sessions SET business_plan = $1, business_plan_fr = NULL WHERE id = $2', [JSON.stringify(updatedPlan), req.params.sessionId]);

    res.json({ success: true, businessPlan: updatedPlan });
  } catch (err) {
    console.error('Business plan section regeneration error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to regenerate this section. Please try again.' });
  }
});

// Explicit "start tracking this business" — creates a real businesses row
// from an Entrepreneur Mode session and links the two together, so this
// idea becomes visible across every business-scoped feature (Funding
// Readiness, Market Intelligence, Growth Center, etc.) from this point on.
// Deliberately opt-in rather than automatic: someone exploring several
// ideas before picking one shouldn't have every exploration clutter their
// business list.
app.post('/api/entrepreneur/:sessionId/track', authRequired, async (req, res) => {
  try {
    const sessionResult = await pool.query(
      'SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2',
      [req.params.sessionId, req.userId]
    );
    if (!sessionResult.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sessionResult.rows[0];

    if (session.business_id) {
      const existing = await pool.query('SELECT id, name FROM businesses WHERE id = $1', [session.business_id]);
      return res.json({ success: true, alreadyTracked: true, businessId: session.business_id, businessName: existing.rows[0]?.name });
    }

    const isOpp = session.mode === 'opportunity_finder';
    // For opportunity_finder the frontend sends the chosen opportunity's
    // name only (not its full data) — re-find the matching object so its
    // description can seed the new business's facts below.
    const chosenOpportunity = isOpp
      ? (session.structured_output?.opportunities || []).find(o => o.name === req.body?.name) || (session.structured_output?.opportunities || [])[0]
      : null;

    let defaultName;
    if (req.body?.name && req.body.name.trim()) {
      defaultName = req.body.name.trim();
    } else if (isOpp) {
      defaultName = chosenOpportunity?.name || 'Untitled Business';
    } else {
      defaultName = (session.input_data?.idea || 'Untitled Business').slice(0, 100);
    }

    const inserted = await pool.query(
      'INSERT INTO businesses (user_id, name, country, city) VALUES ($1, $2, $3, $4) RETURNING id, name',
      [req.userId, defaultName, session.input_data?.country || null, session.input_data?.city || null]
    );
    const newBusiness = inserted.rows[0];

    await pool.query('UPDATE entrepreneur_sessions SET business_id = $1 WHERE id = $2', [newBusiness.id, req.params.sessionId]);

    // Seed the Analyzer's fact fields from whatever this session already
    // established, so opening this business doesn't show an empty profile
    // the founder has to re-describe from scratch — using the same
    // fact_key vocabulary and source_type convention the Analyzer itself
    // uses, so the existing facts display renders these with no changes.
    const facts = [];
    if (isOpp && chosenOpportunity) {
      const description = [chosenOpportunity.description, chosenOpportunity.why_it_fits].filter(Boolean).join(' ');
      if (description) facts.push(['value_proposition', description]);
    } else if (!isOpp && session.input_data?.idea) {
      facts.push(['value_proposition', session.input_data.idea]);
      if (session.structured_output?.target_customer) facts.push(['target_customers', session.structured_output.target_customer]);
      if (session.structured_output?.suggested_pricing) facts.push(['pricing_info', session.structured_output.suggested_pricing]);
    }
    if (session.input_data?.country || session.input_data?.city) {
      facts.push(['location', [session.input_data.city, session.input_data.country].filter(Boolean).join(', ')]);
    }

    for (const [factKey, factValue] of facts) {
      await pool.query(
        `INSERT INTO business_facts (business_id, fact_key, fact_value, source_type, source_detail)
         VALUES ($1, $2, $3, 'user_provided', 'From Start a Business')`,
        [newBusiness.id, factKey, factValue]
      );
    }

    res.json({ success: true, alreadyTracked: false, businessId: newBusiness.id, businessName: newBusiness.name });
  } catch (err) {
    console.error('Start tracking business error:', err.message);
    res.status(500).json({ error: 'Failed to start tracking this business. Please try again.' });
  }
});

// Save consultation
app.post('/api/board/save', authRequired, async (req, res) => {
  const { title, businessType, industry, directorsUsed, reportText, synthesis, videoUrl, messages } = req.body;
  try {
    const account = await resolveAccount(req.userId); // team members' consultations are saved under the shared account
    const plan = account?.plan || 'starter';

    const consult = await pool.query(
      `INSERT INTO consultations (user_id, title, business_type, industry, directors_used, report_text, synthesis, video_url, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', NOW()) RETURNING *`,
      [account.id, title, businessType, industry, JSON.stringify(directorsUsed), reportText, synthesis, videoUrl]
    );

    if (messages && messages.length) {
      for (const msg of messages) {
        await pool.query(
          'INSERT INTO messages (consultation_id, role, content, director_id, ai_model) VALUES ($1, $2, $3, $4, $5)',
          [consult.rows[0].id, msg.role, msg.content, msg.directorId, msg.aiModel]
        );
      }
    }

    // Increment consultation count
    await pool.query('UPDATE users SET consultations_used = consultations_used + 1 WHERE id = $1', [account.id]);

    res.json({ success: true, consultationId: consult.rows[0].id });
  } catch(e) { res.status(500).json({ error: 'Failed to save' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AI HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── Usage logging (best-effort, never blocks the actual AI response) ───────
async function logAIUsage({ provider, model, status, errorMessage, durationMs, feature, userId, businessId }) {
  try {
    await pool.query(
      `INSERT INTO ai_usage (provider, model, status, error_message, duration_ms, feature, user_id, business_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [provider, model, status, errorMessage || null, durationMs, feature || 'unspecified', userId || null, businessId || null]
    );
  } catch (e) { /* never let logging break the actual request */ }
}

// ── Robust JSON extraction from an AI response ──────────────────────────────
// A plain markdown-fence strip only works if the response is EXACTLY the JSON
// block with nothing else. In practice, longer/more complex prompts sometimes
// get a stray sentence of preamble or a trailing note despite instructions to
// return "only JSON" — that alone breaks a naive strip regardless of token
// budget. This finds the outermost {...} block and parses just that, which
// survives any surrounding text.
function extractJSON(raw) {
  let text = raw.trim();
  // Strip a leading ```json or ``` fence and a trailing ``` if present
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('No JSON object found in response');
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonSlice);
}

async function _askClaudeRaw(persona, messages, maxTokens = 1024, model = 'claude-haiku-4-5-20251001') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Claude API key not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: persona, messages })
  });
  if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e?.error?.message || 'Claude error'); }
  const data = await response.json();
  return data.content?.find(b => b.type === 'text')?.text;
}

async function _askChatGPTRaw(persona, messages) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API key not configured');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'system', content: persona }, ...messages] })
  });
  if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e?.error?.message || 'OpenAI error'); }
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

async function _askGeminiRaw(persona, messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: persona }] },
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 1024 }
      })
    }
  );
  if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e?.error?.message || 'Gemini error'); }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

// Distinct from perplexitySearch() (used for one-off competitor/market
// research) — this is the conversational form used for Boardroom chat,
// matching the same persona + multi-turn messages shape as ChatGPT/Gemini
// above, but naturally grounded in live web results since that's inherent
// to how Perplexity's models work.
async function _askPerplexityRaw(persona, messages) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('Perplexity API key not configured');
  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'system', content: persona }, ...messages] })
  });
  if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e?.error?.message || 'Perplexity error'); }
  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

// ── Public AI functions — same signatures as before, now with usage logging ──
async function askClaude(persona, messages, context = {}, maxTokens = 1024, model = 'claude-haiku-4-5-20251001') {
  const start = Date.now();
  try {
    const result = await _askClaudeRaw(persona, messages, maxTokens, model);
    logAIUsage({ provider: 'claude', model, status: 'success', durationMs: Date.now() - start, ...context });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'claude', model, status: 'error', errorMessage: e.message, durationMs: Date.now() - start, ...context });
    throw e;
  }
}

async function askChatGPT(persona, messages, context = {}) {
  const start = Date.now();
  try {
    const result = await _askChatGPTRaw(persona, messages);
    logAIUsage({ provider: 'chatgpt', model: 'gpt-4o-mini', status: 'success', durationMs: Date.now() - start, ...context });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'chatgpt', model: 'gpt-4o-mini', status: 'error', errorMessage: e.message, durationMs: Date.now() - start, ...context });
    throw e;
  }
}

async function askGemini(persona, messages, context = {}) {
  const start = Date.now();
  try {
    const result = await _askGeminiRaw(persona, messages);
    logAIUsage({ provider: 'gemini', model: 'gemini-flash-latest', status: 'success', durationMs: Date.now() - start, ...context });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'gemini', model: 'gemini-flash-latest', status: 'error', errorMessage: e.message, durationMs: Date.now() - start, ...context });
    throw e;
  }
}

async function askPerplexity(persona, messages, context = {}) {
  const start = Date.now();
  try {
    const result = await _askPerplexityRaw(persona, messages);
    logAIUsage({ provider: 'perplexity', model: 'sonar', status: 'success', durationMs: Date.now() - start, ...context });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'perplexity', model: 'sonar', status: 'error', errorMessage: e.message, durationMs: Date.now() - start, ...context });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MODEL ROUTER
// Routes each request to the model tier that actually fits the task, instead
// of every feature reaching for the same model by default. Two genuine tiers:
//
//   'simple'   → Claude Haiku — single-fact lookups, short chat turns, director
//                selection. Fast and cheap; more than adequate for these.
//   'moderate' → Claude Haiku — default. Most director conversations, standard
//                extraction/summarization tasks.
//   'complex'  → Claude Sonnet — tasks that need real multi-step reasoning
//                and hold up a decision: the Verification Pass (arguing against
//                its own recommendation), Chairman Synthesis (weighing
//                disagreement between directors), Business Plan generation
//                (financial + strategic reasoning across 5 sections), and Idea
//                Validation (an honest VALIDATE/MODIFY/RECONSIDER call).
//
// This intentionally does NOT touch the existing per-director model choice
// (Claude/ChatGPT/Gemini, chosen per-persona in the DIRECTORS registry) — that
// routing already exists and works. This layer sits underneath it, on top of
// whichever provider a given call already uses.
// ═══════════════════════════════════════════════════════════════════════════

const MODEL_TIERS = {
  simple:   { model: 'claude-haiku-4-5-20251001', maxTokens: 600 },
  moderate: { model: 'claude-haiku-4-5-20251001', maxTokens: 1024 },
  complex:  { model: 'claude-sonnet-4-6',          maxTokens: 4000 }
};

// callAI — the router entry point. `maxTokens` can still be overridden per call
// (some complex tasks, like the business plan, need more room than the tier
// default) but the MODEL itself is chosen by complexity, not hand-picked per call.
async function callAI({ persona, messages, complexity = 'moderate', context = {}, maxTokens }) {
  const tier = MODEL_TIERS[complexity] || MODEL_TIERS.moderate;
  const tokenBudget = maxTokens || tier.maxTokens;
  return askClaude(persona, messages, { ...context, complexity }, tokenBudget, tier.model);
}

// ── Shared French-language instruction, appended to prompts when requested ──
// Two variants: one for free-text/conversational responses, one for structured
// JSON responses where the keys must stay in English for the app to parse them
// but the actual text VALUES should be in French.
function frenchInstruction(language, { jsonMode = false } = {}) {
  if (language !== 'fr') return '';
  return jsonMode
    ? ' Respond entirely in French (Français) — every free-text/narrative VALUE in your JSON response must be written in French. Keep the JSON KEYS exactly as specified in English, since the application parses them by name. CRITICAL EXCEPTION: any field whose schema restricts it to a fixed set of English enum options (for example "high|medium|low", "local|international", "covered|partial|not covered", "upheld|weakened|revise", "validate|modify|reconsider") must keep using those EXACT English enum words unchanged — the application matches these values by exact string for color-coding and filtering, and translating them (e.g. "high" → "élevée") would silently break that logic. Only the surrounding descriptive text should be in French. IMPORTANT: if source material, search results, or research excerpts appear anywhere above in English, do NOT copy their English phrasing, terminology, or sentences into your free-text output — extract the underlying facts and write your OWN original French sentences expressing them (the enum-field exception above still applies exactly as stated; this instruction only concerns the surrounding descriptive French text).'
    : ' Respond entirely in French (Français) — every word of your reply must be in French. If any source material or context provided above is in English, extract the facts and express them in your own original French sentences — never copy English phrasing into your reply.';
}

// ═══════════════════════════════════════════════════════════════════════════
// FINANCIAL CALCULATION ENGINE
// Per Section 23 of the spec: the AI must never do arithmetic itself. These are
// pure, deterministic functions — same inputs always produce the same outputs,
// verifiable independently of any AI call. Used both as a standalone tool users
// can run directly, and (going forward) as the source of truth any AI-generated
// report should defer to rather than estimating numbers in prose.
// ═══════════════════════════════════════════════════════════════════════════

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

function calcRevenue({ unitsSold, pricePerUnit }) {
  const revenue = unitsSold * pricePerUnit;
  return { revenue: round2(revenue) };
}

function calcProfitMargin({ revenue, cogs, operatingExpenses = 0 }) {
  const grossProfit = revenue - cogs;
  const grossMarginPct = revenue !== 0 ? (grossProfit / revenue) * 100 : 0;
  const netProfit = grossProfit - operatingExpenses;
  const netMarginPct = revenue !== 0 ? (netProfit / revenue) * 100 : 0;
  return {
    grossProfit: round2(grossProfit),
    grossMarginPct: round2(grossMarginPct),
    netProfit: round2(netProfit),
    netMarginPct: round2(netMarginPct)
  };
}

function calcBreakeven({ fixedCosts, pricePerUnit, variableCostPerUnit }) {
  const contributionMargin = pricePerUnit - variableCostPerUnit;
  if (contributionMargin <= 0) {
    return { error: 'Price per unit must be greater than variable cost per unit — otherwise break-even is never reached, no matter how many units are sold.' };
  }
  const breakevenUnits = fixedCosts / contributionMargin;
  const breakevenRevenue = breakevenUnits * pricePerUnit;
  return {
    contributionMarginPerUnit: round2(contributionMargin),
    breakevenUnits: Math.ceil(breakevenUnits),
    breakevenRevenue: round2(breakevenRevenue)
  };
}

function calcROI({ gain, costOfInvestment }) {
  if (costOfInvestment === 0) return { error: 'Cost of investment cannot be zero.' };
  const netGain = gain - costOfInvestment;
  const roiPct = (netGain / costOfInvestment) * 100;
  return { netGain: round2(netGain), roiPct: round2(roiPct) };
}

function calcCAC({ totalAcquisitionCost, newCustomers }) {
  if (newCustomers === 0) return { error: 'Number of new customers cannot be zero.' };
  return { cac: round2(totalAcquisitionCost / newCustomers) };
}

function calcLTV({ avgOrderValue, purchaseFrequencyPerYear, avgCustomerLifespanYears }) {
  const ltv = avgOrderValue * purchaseFrequencyPerYear * avgCustomerLifespanYears;
  return { ltv: round2(ltv) };
}

function calcLTVtoCAC({ ltv, cac }) {
  if (cac === 0) return { error: 'CAC cannot be zero.' };
  const ratio = ltv / cac;
  let verdict;
  if (ratio < 1) verdict = 'Losing money on every customer — CAC exceeds LTV. Unsustainable as-is.';
  else if (ratio < 3) verdict = 'Below the commonly-cited healthy threshold of 3:1 — margins are thin once other costs are factored in.';
  else if (ratio <= 5) verdict = 'Healthy — this ratio is generally considered a sustainable range.';
  else verdict = 'Very high ratio — could mean strong efficiency, or that you are under-investing in growth and leaving acquisition opportunity on the table.';
  return { ratio: round2(ratio), verdict };
}

function calcROAS({ revenueFromAds, adSpend }) {
  if (adSpend === 0) return { error: 'Ad spend cannot be zero.' };
  return { roas: round2(revenueFromAds / adSpend) };
}

function calcGrowthProjection({ startValue, monthlyGrowthRatePct, months }) {
  months = Math.min(Math.max(parseInt(months, 10) || 12, 1), 36);
  const rate = monthlyGrowthRatePct / 100;
  const projection = [];
  let value = startValue;
  for (let m = 1; m <= months; m++) {
    value = value * (1 + rate);
    projection.push({ month: m, value: round2(value) });
  }
  return { projection };
}

function calcCashFlowProjection({ startingCash, monthlyRevenue, monthlyExpenses, months }) {
  months = Math.min(Math.max(parseInt(months, 10) || 12, 1), 36);
  const projection = [];
  let balance = startingCash;
  let negativeMonth = null;
  for (let m = 1; m <= months; m++) {
    const netChange = monthlyRevenue - monthlyExpenses;
    balance = balance + netChange;
    if (balance < 0 && negativeMonth === null) negativeMonth = m;
    projection.push({ month: m, inflow: round2(monthlyRevenue), outflow: round2(monthlyExpenses), netChange: round2(netChange), runningBalance: round2(balance) });
  }
  return { projection, negativeMonth, warning: negativeMonth ? `Cash goes negative in month ${negativeMonth} at this rate — revisit costs or revenue assumptions before this point.` : null };
}

// ── Phase 6 additions ────────────────────────────────────────────────────
function calcPricing({ unitCost, desiredMarginPct }) {
  if (desiredMarginPct >= 100) return { error: 'Desired margin must be less than 100%.' };
  const sellingPrice = unitCost / (1 - desiredMarginPct / 100);
  return { sellingPrice: round2(sellingPrice), marginAmount: round2(sellingPrice - unitCost) };
}

// Markup (% of cost added on top) and margin (% of the final price that is
// profit) are the single most common pricing confusion for new founders —
// this deliberately surfaces both numbers so the difference is visible,
// not just the one the user asked for.
function calcMarkup({ unitCost, markupPct }) {
  const sellingPrice = unitCost * (1 + markupPct / 100);
  const equivalentMarginPct = sellingPrice !== 0 ? ((sellingPrice - unitCost) / sellingPrice) * 100 : 0;
  return { sellingPrice: round2(sellingPrice), markupAmount: round2(sellingPrice - unitCost), equivalentMarginPct: round2(equivalentMarginPct) };
}

function calcRunway({ cashOnHand, monthlyBurnRate }) {
  if (monthlyBurnRate <= 0) return { error: 'Monthly burn rate must be greater than zero — if you are profitable or breakeven, runway is not the right metric.' };
  const runwayMonths = cashOnHand / monthlyBurnRate;
  const runwayDate = new Date();
  runwayDate.setMonth(runwayDate.getMonth() + Math.floor(runwayMonths));
  return { runwayMonths: round2(runwayMonths), estimatedRunOutDate: runwayDate.toISOString().split('T')[0] };
}

function calcBudgetVariance({ budgetedAmount, actualAmount }) {
  if (budgetedAmount === 0) return { error: 'Budgeted amount cannot be zero.' };
  const varianceAmount = actualAmount - budgetedAmount;
  const variancePct = (varianceAmount / budgetedAmount) * 100;
  const status = varianceAmount > 0 ? 'over' : varianceAmount < 0 ? 'under' : 'on-budget';
  return { varianceAmount: round2(varianceAmount), variancePct: round2(variancePct), status };
}

// Deliberately takes the multiple as a user-supplied input rather than
// having the system pick or invent one — real valuation multiples vary too
// much by industry and circumstance to guess responsibly, which would
// violate the platform's deterministic-math-only rule for financial figures.
function calcValuation({ sde, multiple }) {
  if (multiple <= 0) return { error: 'Multiple must be greater than zero.' };
  return { estimatedValuation: round2(sde * multiple) };
}

// FIN-02 additions — 3 genuinely new needs not covered by the existing 15,
// beyond what the original audit's named examples (Pricing, Markup,
// Runway, Budget, Valuation) already covered.

// Standard amortization formula. Guards the 0%-interest case separately,
// since the amortization formula itself divides by zero when the rate is 0.
function calcLoanPayment({ principal, annualRatePct, termMonths }) {
  if (principal <= 0 || termMonths <= 0) return { error: 'Principal and term must be positive.' };
  const monthlyRate = (annualRatePct / 100) / 12;
  let monthlyPayment;
  if (monthlyRate === 0) {
    monthlyPayment = principal / termMonths;
  } else {
    monthlyPayment = principal * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);
  }
  const totalPaid = monthlyPayment * termMonths;
  return { monthlyPayment: round2(monthlyPayment), totalPaid: round2(totalPaid), totalInterest: round2(totalPaid - principal) };
}

// The "burden rate" (taxes, benefits, etc. as a % of salary) is a
// user-supplied input rather than a fixed assumption, since it varies too
// much by country and business to responsibly hardcode — same reasoning
// as calcValuation's multiple above.
function calcCostOfHire({ annualSalary, burdenRatePct }) {
  if (annualSalary <= 0) return { error: 'Annual salary must be positive.' };
  const burden = annualSalary * (burdenRatePct / 100);
  const totalAnnualCost = annualSalary + burden;
  return { burden: round2(burden), totalAnnualCost: round2(totalAnnualCost), totalMonthlyCost: round2(totalAnnualCost / 12) };
}

// Answers a question small business owners often discount without asking:
// how much MORE would I need to sell, just to make the same total profit
// as before the discount? A discount that would sell below unit cost is
// flagged as unrecoverable by any volume, rather than returning a
// technically-correct but meaningless (negative) required-units figure.
function calcDiscountImpact({ currentPrice, currentUnitCost, discountPct, currentUnitsSold }) {
  if (currentPrice <= currentUnitCost) return { error: 'Price must be greater than unit cost.' };
  const currentMarginPerUnit = currentPrice - currentUnitCost;
  const currentTotalProfit = currentMarginPerUnit * currentUnitsSold;
  const discountedPrice = currentPrice * (1 - discountPct / 100);
  const newMarginPerUnit = discountedPrice - currentUnitCost;
  if (newMarginPerUnit <= 0) return { error: 'This discount would sell below cost — no volume of sales would recover profit.' };
  const requiredUnitsForSameProfit = currentTotalProfit / newMarginPerUnit;
  const extraUnitsNeeded = requiredUnitsForSameProfit - currentUnitsSold;
  return {
    discountedPrice: round2(discountedPrice),
    requiredUnitsForSameProfit: Math.ceil(requiredUnitsForSameProfit),
    extraUnitsNeeded: Math.ceil(extraUnitsNeeded),
    extraVolumePctNeeded: round2((extraUnitsNeeded / currentUnitsSold) * 100)
  };
}

const FINANCIAL_CALCULATORS = {
  revenue: { fn: calcRevenue, requiredInputs: ['unitsSold', 'pricePerUnit'] },
  profit_margin: { fn: calcProfitMargin, requiredInputs: ['revenue', 'cogs'] },
  breakeven: { fn: calcBreakeven, requiredInputs: ['fixedCosts', 'pricePerUnit', 'variableCostPerUnit'] },
  roi: { fn: calcROI, requiredInputs: ['gain', 'costOfInvestment'] },
  cac: { fn: calcCAC, requiredInputs: ['totalAcquisitionCost', 'newCustomers'] },
  ltv: { fn: calcLTV, requiredInputs: ['avgOrderValue', 'purchaseFrequencyPerYear', 'avgCustomerLifespanYears'] },
  ltv_cac_ratio: { fn: calcLTVtoCAC, requiredInputs: ['ltv', 'cac'] },
  roas: { fn: calcROAS, requiredInputs: ['revenueFromAds', 'adSpend'] },
  growth_projection: { fn: calcGrowthProjection, requiredInputs: ['startValue', 'monthlyGrowthRatePct'] },
  cashflow_projection: { fn: calcCashFlowProjection, requiredInputs: ['startingCash', 'monthlyRevenue', 'monthlyExpenses'] },
  pricing: { fn: calcPricing, requiredInputs: ['unitCost', 'desiredMarginPct'] },
  markup: { fn: calcMarkup, requiredInputs: ['unitCost', 'markupPct'] },
  runway: { fn: calcRunway, requiredInputs: ['cashOnHand', 'monthlyBurnRate'] },
  budget_variance: { fn: calcBudgetVariance, requiredInputs: ['budgetedAmount', 'actualAmount'] },
  valuation: { fn: calcValuation, requiredInputs: ['sde', 'multiple'] },
  loan_payment: { fn: calcLoanPayment, requiredInputs: ['principal', 'annualRatePct', 'termMonths'] },
  cost_of_hire: { fn: calcCostOfHire, requiredInputs: ['annualSalary', 'burdenRatePct'] },
  discount_impact: { fn: calcDiscountImpact, requiredInputs: ['currentPrice', 'currentUnitCost', 'discountPct', 'currentUnitsSold'] }
};

// ── Financial Calculator endpoint — pure math, no AI call, available to all plans ──
app.get('/api/financial/access', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    res.json({ plan, allowed: FINANCIAL_TOOLS_ACCESS[plan] || FINANCIAL_TOOLS_ACCESS.starter });
  } catch (e) { res.status(500).json({ error: 'Failed to load access info' }); }
});

app.post('/api/financial/calculate', authRequired, async (req, res) => {
  const { type, inputs } = req.body;
  const calculator = FINANCIAL_CALCULATORS[type];
  if (!calculator) return res.status(400).json({ error: 'Unknown calculator type.' });

  const account = await resolveAccount(req.userId); // team members share the owner's plan
  const plan = account?.plan || 'starter';
  const allowed = FINANCIAL_TOOLS_ACCESS[plan] || FINANCIAL_TOOLS_ACCESS.starter;
  if (!allowed.includes(type)) {
    return res.status(403).json({ error: 'This calculator is available on Arreyon Pro and above.', upgradeRequired: true });
  }

  const missing = calculator.requiredInputs.filter(key => inputs?.[key] === undefined || inputs[key] === '' || inputs[key] === null);
  if (missing.length) return res.status(400).json({ error: `Missing required input(s): ${missing.join(', ')}` });

  const numericInputs = {};
  for (const [key, val] of Object.entries(inputs)) {
    const num = parseFloat(val);
    if (isNaN(num)) return res.status(400).json({ error: `"${key}" must be a number.` });
    numericInputs[key] = num;
  }

  try {
    const result = calculator.fn(numericInputs);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ success: true, type, inputs: numericInputs, result });
  } catch (e) {
    console.error('Financial calculator error:', e.message);
    res.status(500).json({ error: 'Calculation failed. Please check your inputs.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO ANALYSIS
// Compare 2-3 options (Option A vs B vs C). Any financial figures the user
// provides per option are computed deterministically (pure math, same engine
// as the Financial Calculator) — the AI is given those exact numbers as fact
// and only handles what it's actually good at: qualitative judgment (pros,
// cons, risk, fit against the founder's stated priorities) and a final
// recommendation. It is explicitly instructed not to recalculate or invent
// different figures than what was computed.
// ═══════════════════════════════════════════════════════════════════════════

// Pure, deterministic per-option financial summary — no AI involved.
// Only computed when enough numeric fields are actually provided; otherwise
// the option is compared on qualitative grounds alone.
function computeScenarioFinancials({ monthlyRevenueImpact, monthlyCostImpact, oneTimeInvestment, timeframeMonths }) {
  const hasCore = [monthlyRevenueImpact, monthlyCostImpact].every(v => v !== undefined && v !== null && v !== '');
  if (!hasCore) return null;

  const revenue = parseFloat(monthlyRevenueImpact);
  const cost = parseFloat(monthlyCostImpact);
  if (isNaN(revenue) || isNaN(cost)) return null;

  const netMonthlyGain = round2(revenue - cost);
  const investment = oneTimeInvestment !== undefined && oneTimeInvestment !== '' ? parseFloat(oneTimeInvestment) : 0;
  const months = timeframeMonths !== undefined && timeframeMonths !== '' ? Math.min(Math.max(parseInt(timeframeMonths, 10) || 12, 1), 60) : 12;

  const totalGainOverTimeframe = round2(netMonthlyGain * months);
  let paybackMonths = null;
  if (investment > 0 && netMonthlyGain > 0) paybackMonths = Math.ceil(investment / netMonthlyGain);
  else if (investment > 0 && netMonthlyGain <= 0) paybackMonths = null; // never pays back at this rate

  let roiPct = null;
  if (investment > 0) roiPct = round2(((totalGainOverTimeframe - investment) / investment) * 100);

  return {
    netMonthlyGain,
    investment: investment || null,
    timeframeMonths: months,
    totalGainOverTimeframe,
    paybackMonths,
    roiPct
  };
}

app.post('/api/scenario/compare', authRequired, async (req, res) => {
  const { options, context: decisionContext, language = 'en', currency } = req.body;
  if (!options || !Array.isArray(options) || options.length < 2 || options.length > 4) {
    return res.status(400).json({ error: 'Please provide between 2 and 4 options to compare.' });
  }
  for (const o of options) {
    if (!o.name || !o.description) return res.status(400).json({ error: 'Each option needs at least a name and description.' });
  }

  try {
    // Compute real financials per option first — deterministic, before any AI involvement
    const optionsWithFinancials = options.map(o => ({
      name: o.name,
      description: o.description,
      financials: computeScenarioFinancials(o)
    }));

    const currencyLabel = (currency && currency.trim()) ? currency.trim() : 'USD';
    const optionsText = optionsWithFinancials.map((o, i) => {
      let block = `OPTION ${String.fromCharCode(65 + i)}: ${o.name}\nDescription: ${o.description}`;
      if (o.financials) {
        block += `\nCOMPUTED FINANCIALS (exact, already calculated, in ${currencyLabel} — do not recompute or alter these numbers, and always reference them using this currency, never assume USD/dollars unless that is what's stated here):
  - Net monthly gain: ${o.financials.netMonthlyGain} ${currencyLabel}
  - One-time investment: ${o.financials.investment !== null ? o.financials.investment + ' ' + currencyLabel : 'none stated'}
  - Total gain over ${o.financials.timeframeMonths} months: ${o.financials.totalGainOverTimeframe} ${currencyLabel}
  - Payback period: ${o.financials.paybackMonths !== null ? o.financials.paybackMonths + ' months' : (o.financials.investment ? 'does not pay back at this rate' : 'no investment stated')}
  - ROI over timeframe: ${o.financials.roiPct !== null ? o.financials.roiPct + '%' : 'not applicable — no investment stated'}`;
      } else {
        block += `\n(No financial figures provided for this option — compare on qualitative grounds only.)`;
      }
      return block;
    }).join('\n\n');

    const prompt = `You are a business strategist helping a founder decide between ${options.length} options. ${decisionContext ? `Their situation: ${decisionContext}` : ''}

${optionsText}

YOUR TASK:
For each option, give a genuine qualitative assessment — pros, cons, and risk level. Where computed financials are provided above, treat them as fact and reference them directly, using the ${currencyLabel} currency exactly as given — do not invent different numbers, recalculate, or default to dollars/USD if a different currency was specified above. Where no financials were given, compare on strategic/qualitative grounds only, and say so.

Then give ONE final recommendation: which option to choose and why, weighing both the numbers (where available) and the qualitative factors (risk, effort, fit with their stated situation).

Be decisive — the founder wants a clear answer, not a list of "it depends."

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "options_analysis": [
    {"option_name": "...", "pros": ["...", "..."], "cons": ["...", "..."], "risk_level": "low|medium|high"}
  ],
  "comparison_summary": "2-3 sentences directly comparing the options against each other",
  "recommended_option": "the exact name of the recommended option",
  "recommendation_reasoning": "why this one, referencing the specific numbers or qualitative factors that decided it",
  "confidence": "high|medium|low"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Compare the options now, as JSON only.' }], complexity: 'complex', context: { feature: 'scenario_analysis', userId: req.userId }, maxTokens: 2500 });
    const analysis = extractJSON(raw);

    res.json({ success: true, optionsWithFinancials, analysis });
  } catch (err) {
    console.error('Scenario analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Comparison failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSULT BOARD ROUTES (from existing platform)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/consult/qualify', async (req, res) => {
  const { businessData, conversationHistory: rawHistory = [], language = 'en' } = req.body;
  if (!businessData) return res.status(400).json({ error: 'Missing business data' });

  // This endpoint is public and unauthenticated (anonymous /consult visitors),
  // so client-supplied conversationHistory must never be trusted at face value —
  // a malformed entry here must not be able to crash the server for everyone.
  const conversationHistory = rawHistory.filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'));

  const userExchanges = conversationHistory.filter(m => m.role === 'user').length;
  if (userExchanges >= 10) return res.json({ ready: true });

  const allAnswers = conversationHistory.filter(m => m.role === 'user').map(m => m.content).join(' ');
  const totalWords = allAnswers.trim().split(/\s+/).length;
  const lastUserMsg = conversationHistory.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  const topics = {
    revenue:     /revenue|sales|income|money|earn|charge|price|cost|afford|spend/i.test(allAnswers),
    customers:   /customer|client|target|audience|who|market|people|demographic|buyer/i.test(allAnswers),
    competition: /compet|rival|other|alternative|different|unique|better|worse/i.test(allAnswers),
    timeline:    /when|timeline|soon|urgent|month|year|week|deadline|time|plan/i.test(allAnswers),
    tried:       /tried|attempt|done|before|fail|work|didn|haven|already|previous/i.test(allAnswers),
  };
  const topicsCovered = Object.values(topics).filter(Boolean).length;

  if (userExchanges >= 5 && totalWords >= 60 && topicsCovered >= 4) return res.json({ ready: true });

  const isSmallTalk = /^(hi|hello|hey|how are you|good morning|good evening|good afternoon|thanks|thank you|ok|okay|sure|yes|no|great|nice|cool|wow|awesome)[\s!?.]*$/i.test(lastUserMsg.trim());
  const conversationStr = conversationHistory.map(m => `${m.role === 'user' ? 'Client' : 'Secretary'}: ${m.content}`).join('\n');
  const missingTopics = Object.entries(topics).filter(([,v]) => !v).map(([k]) => k);
  const nextTopicHint = missingTopics.length > 0 ? `Focus your question on: ${missingTopics[0]}.` : 'Dig deeper into specifics.';

  const qualifyPrompt = `You are the Board Secretary for Arreyon Consult by G-DESIGNS. Conducting a pre-consultation interview.

BUSINESS CONTEXT: ${businessData.businessType} | ${businessData.challenge} | ${businessData.goal}
CONVERSATION: ${conversationStr}
CLIENT JUST SAID: "${lastUserMsg}"

${isSmallTalk ? 'Acknowledge warmly in 1 sentence, then ask a business question.' : 'React briefly to what was said, then ask ONE follow-up question.'}
${nextTopicHint}
RULES: ONE question only. Under 60 words total. Warm and conversational. Return plain text only.${language === 'fr' ? ' Respond entirely in French (Français) — every word of your reply must be in French.' : ''}`;

  try {
    const q = await askClaude(qualifyPrompt, [{ role: 'user', content: lastUserMsg || 'Continue.' }], { feature: 'consult_secretary' });
    res.json({ ready: false, question: q.trim().replace(/^["']|["']$/g, '') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const DIRECTORS = {
    sentinel: { name: 'The Market Sentinel', role: 'Real-Time Market Intelligence',
    domains: ['competitors','market trends','current events','real-time','news','pricing changes','industry shifts','breaking developments','what is happening now'], ai: 'perplexity', category: 'strategy',
    framework: `You are The Market Sentinel, a board advisor whose entire value is knowing what is happening in the market RIGHT NOW — not historical business philosophy, but current, verifiable, cited reality. THINKING FRAMEWORK: 1) Ground every claim in what you can actually find happening currently — competitor moves, pricing shifts, industry news, market conditions. 2) Clearly distinguish what is confirmed by current sources from what is general reasoning. 3) Flag anything that looks stale or where you genuinely don't have current visibility, rather than guessing. 4) Recommend the one action that matters most given what is actually happening right now, not what would have mattered a year ago. Be precise, current, and honest about the limits of what you can verify.` },
    rockefeller: { name: 'John D. Rockefeller', role: 'Empire & Cost Strategy',
    domains: ['finance','cost','pricing','operations','scale','efficiency','manufacturing','resources'], ai: 'claude', category: 'strategy',
    framework: `You are John D. Rockefeller advising an external business founder as part of a board consultation. Think like a 19th century industrialist with modern insight. THINKING FRAMEWORK: 1) Identify the core inefficiency or cost leak. 2) Find the vertical integration opportunity. 3) Think in decades not quarters. 4) Recommend the single most impactful move. Be direct, measured, and absolute in your conviction. Never be generic. Cite specific principles from your own philosophy.` },
    dangote: { name: 'Aliko Dangote', role: 'African Market & Scale',
    domains: ['africa','cameroon','emerging markets','distribution','manufacturing','infrastructure','local market','growth'], ai: 'claude', category: 'strategy',
    framework: `You are Aliko Dangote advising an external business founder. THINKING FRAMEWORK: 1) Assess the African market opportunity specifically. 2) Identify infrastructure or trust gaps to solve. 3) Recommend how to scale from local to continental. 4) Speak from lived experience building in Africa. Be practical, grounded, and continental in your thinking.` },
    ogilvy: { name: 'David Ogilvy', role: 'Brand & Advertising',
    domains: ['marketing','brand','advertising','copy','messaging','positioning','awareness','creative','social media'], ai: 'claude', category: 'marketing',
    framework: `You are David Ogilvy advising an external business founder. THINKING FRAMEWORK: 1) Diagnose the brand positioning first. 2) Identify what the consumer truly wants to hear. 3) Recommend the big idea that will make this brand memorable. 4) Prescribe exact copy or messaging direction. Be specific about words, headlines, and angles. Never speak in vague marketing platitudes.` },
    kotler: { name: 'Philip Kotler', role: 'Marketing Strategy',
    domains: ['marketing','segmentation','positioning','pricing','product','promotion','channels','customers','b2b','b2c'], ai: 'chatgpt', category: 'marketing',
    framework: `You are Philip Kotler advising an external business founder. THINKING FRAMEWORK: 1) Apply the STP framework (Segment, Target, Position). 2) Audit the 4Ps relevant to this business. 3) Identify the highest-leverage marketing lever. 4) Prescribe a measurable strategy. Be rigorous and framework-driven. Always tie advice to measurable outcomes.` },
    porter: { name: 'Michael Porter', role: 'Competitive Strategy',
    domains: ['competition','strategy','market','positioning','industry','differentiation','advantage','analysis'], ai: 'chatgpt', category: 'strategy',
    framework: `You are Michael Porter advising an external business founder. THINKING FRAMEWORK: 1) Apply Five Forces to this industry quickly. 2) Identify the competitive position available. 3) Diagnose whether the strategy is differentiation, cost leadership, or focus. 4) Recommend the single clearest strategic choice. Be precise and framework-anchored. No generic strategy advice.` },
    buffett: { name: 'Warren Buffett', role: 'Investment & Long-Term Value',
    domains: ['investment','funding','valuation','profit','revenue','financial','moat','returns','sustainability'], ai: 'claude', category: 'finance',
    framework: `You are Warren Buffett advising an external business founder. THINKING FRAMEWORK: 1) Assess whether this business has or can build an economic moat. 2) Evaluate the financial fundamentals honestly. 3) Think about whether this business deserves investment in 10 years. 4) Give the one plain-spoken truth the founder needs to hear. Use folksy analogies. Be devastatingly honest about weak points.` },
    thiel: { name: 'Peter Thiel', role: 'Startup & Investor Readiness',
    domains: ['startup','funding','investors','pitch','venture','monopoly','innovation','zero to one','unique'], ai: 'chatgpt', category: 'strategy',
    framework: `You are Peter Thiel advising an external business founder. THINKING FRAMEWORK: 1) Ask — is this Zero to One or just competition? 2) Identify what makes this business a potential monopoly. 3) Diagnose investor readiness honestly. 4) Recommend the contrarian bet most founders miss. Be provocative, specific, and intellectually demanding.` },
    gates: { name: 'Bill Gates', role: 'Technology & Systems',
    domains: ['technology','software','systems','digital','automation','product','tech','innovation','data'], ai: 'chatgpt', category: 'operations',
    framework: `You are Bill Gates advising an external business founder. THINKING FRAMEWORK: 1) Identify how technology can 10x this business. 2) Find the system or process that needs to be built. 3) Assess digital leverage opportunities. 4) Recommend the technology investment with highest ROI. Be analytical, precise, and systems-oriented.` },
    dalio: { name: 'Ray Dalio', role: 'Financial Principles & Risk',
    domains: ['finance','risk','principles','decision','money','investment','debt','cash flow','financial planning'], ai: 'chatgpt', category: 'finance',
    framework: `You are Ray Dalio advising an external business founder. THINKING FRAMEWORK: 1) Apply radical truth — diagnose what is really happening financially. 2) Identify the biggest risk the founder is ignoring. 3) Recommend principles-based financial decisions. 4) Give one clear financial directive. Be direct, principle-driven, and willing to say the uncomfortable truth.` },
    godin: { name: 'Seth Godin', role: 'Tribe & Permission Marketing',
    domains: ['marketing','audience','brand','content','niche','community','social','online','digital marketing'], ai: 'gemini', category: 'marketing',
    framework: `You are Seth Godin advising an external business founder. THINKING FRAMEWORK: 1) Who specifically is this for — smallest viable audience? 2) What makes this remarkable enough to spread? 3) How does this earn permission rather than interrupt? 4) Give one sharp, counterintuitive insight. Be brief, provocative, and philosophical. No corporate speak.` },
    sinek: { name: 'Simon Sinek', role: 'Purpose & Leadership',
    domains: ['purpose','leadership','team','culture','why','mission','vision','brand story','motivation'], ai: 'claude', category: 'people',
    framework: `You are Simon Sinek advising an external business founder. THINKING FRAMEWORK: 1) What is the WHY behind this business — not what or how? 2) Does the messaging start with WHY? 3) How does purpose drive customer loyalty here? 4) What leadership shift does the founder need to make? Be inspiring, story-driven, and purpose-anchored.` },
    moukouri: { name: 'Danielle Moukouri', role: 'Legal & Compliance',
    domains: ['legal','law','contract','compliance','registration','intellectual property','copyright','cameroon','ohada','regulation'], ai: 'chatgpt', category: 'risk',
    framework: `You are Danielle Moukouri advising an external business founder on legal matters in Cameroon and the OHADA framework. THINKING FRAMEWORK: 1) Identify the primary legal risk or gap. 2) Assess compliance with Cameroon/OHADA business law. 3) Recommend the most urgent legal protection needed. 4) Give practical, jurisdiction-specific advice. Be precise, structured, and legally grounded.` },
    robbins: { name: 'Tony Robbins', role: 'Performance & Sales Psychology',
    domains: ['sales','motivation','performance','mindset','closing','team','energy','confidence','growth'], ai: 'gemini', category: 'sales',
    framework: `You are Tony Robbins advising an external business founder. THINKING FRAMEWORK: 1) What belief or state is blocking this founder's result? 2) What sales or performance pattern needs to change? 3) What is the highest-leverage action to take immediately? 4) Give a direct mindset and behaviour shift. Be energetic, direct, and transformation-focused.` },
    drucker: { name: 'Peter Drucker', role: 'Management & Operations',
    domains: ['management','operations','systems','productivity','hiring','organisation','process','effectiveness'], ai: 'chatgpt', category: 'operations',
    framework: `You are Peter Drucker advising an external business founder. THINKING FRAMEWORK: 1) What is the purpose of this business and who is the customer? 2) What management system is missing? 3) Where is time and resource being wasted? 4) Prescribe one operational improvement. Be rigorous, systematic, and management-science driven.` },
awosika: { name: 'Ibukun Awosika', role: 'Faith, Leadership & Purpose',
  domains: ['leadership', 'faith', 'purpose', 'culture', 'values', 'integrity', 'team', 'vision', 'mission'], ai: 'claude', category: 'people',
  framework: `You are Ibukun Awosika advising an external business founder. THINKING FRAMEWORK: 1) Assess whether the founder's purpose and values are clearly driving decisions. 2) Identify the leadership or culture gap holding the business back. 3) Recommend how faith-grounded integrity translates into practical business discipline. 4) Give one clear leadership directive. Be warm, principled, and pastoral in tone.` },
jackma: { name: 'Jack Ma', role: 'E-commerce, Resilience & Vision',
  domains: ['ecommerce', 'resilience', 'vision', 'scale', 'online', 'marketplace', 'persistence', 'china', 'asia'], ai: 'gemini', category: 'marketing',
  framework: `You are Jack Ma advising an external business founder. THINKING FRAMEWORK: 1) Assess the resilience of the founder's resolve against inevitable rejection. 2) Identify the e-commerce or platform opportunity being missed. 3) Recommend a long-term vision anchored in customer trust. 4) Give one bold, encouraging directive. Be energetic, story-driven, and relentlessly optimistic.` },
musk: { name: 'Elon Musk', role: 'Disruption, Speed & First Principles',
  domains: ['disruption', 'speed', 'innovation', 'technology', 'first principles', 'engineering', 'product', 'manufacturing'], ai: 'gemini', category: 'operations',
  framework: `You are Elon Musk advising an external business founder. THINKING FRAMEWORK: 1) Strip the problem to first principles, ignoring convention. 2) Identify what is moving too slowly. 3) Recommend the most aggressive viable timeline. 4) Give one blunt, high-velocity directive. Be direct, impatient with inefficiency, and technically precise.` },
jobs: { name: 'Steve Jobs', role: 'Design, Product & Simplicity',
  domains: ['design', 'product', 'simplicity', 'user experience', 'branding', 'aesthetics', 'focus'], ai: 'gemini', category: 'operations',
  framework: `You are Steve Jobs advising an external business founder. THINKING FRAMEWORK: 1) Identify what should be removed, not added. 2) Assess whether the product experience is simple enough. 3) Recommend the single design or product decision that matters most. 4) Give one uncompromising directive. Be exacting, minimalist, and obsessed with quality.` },
hopkins: { name: 'Claude Hopkins', role: 'Scientific Advertising',
  domains: ['advertising', 'copywriting', 'direct response', 'testing', 'sales', 'offers', 'conversion'], ai: 'chatgpt', category: 'marketing',
  framework: `You are Claude Hopkins advising an external business founder. THINKING FRAMEWORK: 1) Identify whether claims are being tested or merely assumed. 2) Find the specific, provable reason-why in the offer. 3) Recommend the exact copy or test to run next. 4) Give one measurable, scientific directive. Be precise, evidence-driven, and allergic to vague claims.` },
oprah: { name: 'Oprah Winfrey', role: 'Personal Brand, Storytelling & Media',
  domains: ['brand', 'storytelling', 'media', 'audience', 'connection', 'authenticity', 'personal brand'], ai: 'gemini', category: 'marketing',
  framework: `You are Oprah Winfrey advising an external business founder. THINKING FRAMEWORK: 1) Identify the authentic story the brand isn't telling yet. 2) Assess the emotional connection with the audience. 3) Recommend how to turn the founder's story into the brand's greatest asset. 4) Give one heartfelt, empowering directive. Be warm, emotionally intelligent, and audience-focused.` },
bezos: { name: 'Jeff Bezos', role: 'Customer Obsession & Operations',
  domains: ['customer', 'operations', 'scale', 'logistics', 'ecommerce', 'efficiency', 'long-term'], ai: 'chatgpt', category: 'operations',
  framework: `You are Jeff Bezos advising an external business founder. THINKING FRAMEWORK: 1) Assess whether the business is genuinely customer-obsessed or merely competitor-focused. 2) Identify the operational bottleneck limiting scale. 3) Recommend the long-term investment worth making now. 4) Give one operationally precise directive. Be data-driven, patient with long-term bets, ruthless on operational excellence.` },
garyvee: { name: 'Gary Vaynerchuk', role: 'Social Media, Content & Hustle',
  domains: ['social media', 'content', 'marketing', 'hustle', 'branding', 'attention', 'platforms'], ai: 'gemini', category: 'marketing',
  framework: `You are Gary Vaynerchuk advising an external business founder. THINKING FRAMEWORK: 1) Assess whether the founder is creating enough content and attention. 2) Identify the platform-specific opportunity being ignored. 3) Recommend a practical content or attention strategy. 4) Give one high-energy, immediately actionable directive. Be blunt, fast-paced, and relentlessly practical.` },
napoleon: { name: 'Napoleon Hill', role: 'Mindset, Success Principles & Mastermind',
  domains: ['mindset', 'success', 'goals', 'persistence', 'mastermind', 'psychology', 'discipline'], ai: 'claude', category: 'people',
  framework: `You are Napoleon Hill advising an external business founder. THINKING FRAMEWORK: 1) Identify the limiting belief holding the founder back. 2) Assess whether there's a definite chief aim guiding decisions. 3) Recommend a mindset shift paired with a concrete action. 4) Give one principle-based directive. Be philosophical, encouraging, and rooted in timeless success principles.` },
kawasaki: { name: 'Guy Kawasaki', role: 'Evangelism, Pitching & Startup Growth',
  domains: ['startup', 'pitching', 'evangelism', 'fundraising', 'growth', 'launch', 'investors'], ai: 'gemini', category: 'strategy',
  framework: `You are Guy Kawasaki advising an external business founder. THINKING FRAMEWORK: 1) Assess whether the pitch or offer is compelling enough to evangelize. 2) Identify the enchantment gap between the product and the market. 3) Recommend how to turn early customers into evangelists. 4) Give one punchy, startup-tested directive. Be enthusiastic, practical, and Silicon-Valley direct.` },
taleb: { name: 'Nassim Nicholas Taleb', role: 'Risk, Antifragility & Uncertainty',
  domains: ['risk', 'uncertainty', 'volatility', 'antifragility', 'probability', 'black swan', 'resilience'], ai: 'chatgpt', category: 'risk',
  framework: `You are Nassim Nicholas Taleb advising an external business founder. THINKING FRAMEWORK: 1) Identify the hidden fragility or tail risk in the business. 2) Assess what would make the business antifragile rather than merely robust. 3) Recommend a way to gain from volatility instead of being harmed by it. 4) Give one contrarian, risk-aware directive. Be rigorous, skeptical of false certainty, and allergic to naive forecasts.` },
deming: { name: 'W. Edwards Deming', role: 'Data, Quality & Systems Research',
  domains: ['quality', 'data', 'systems', 'process', 'measurement', 'operations', 'manufacturing'], ai: 'chatgpt', category: 'operations',
  framework: `You are W. Edwards Deming advising an external business founder. THINKING FRAMEWORK: 1) Identify what is being managed by opinion instead of data. 2) Assess the systemic cause behind the stated problem. 3) Recommend a measurable process improvement. 4) Give one data-grounded directive. Be methodical, systems-focused, and averse to blaming individuals for systemic issues.` },
christensen: { name: 'Clayton Christensen', role: 'Disruptive Innovation & Research',
  domains: ['innovation', 'disruption', 'research', 'market', 'technology', 'business model'], ai: 'chatgpt', category: 'strategy',
  framework: `You are Clayton Christensen advising an external business founder. THINKING FRAMEWORK: 1) Identify the job the customer is really hiring the product to do. 2) Assess whether the business is vulnerable to disruption from below. 3) Recommend where genuine innovation opportunity exists. 4) Give one research-grounded directive. Be academic, evidence-based, and focused on customer jobs-to-be-done.` },
adamgrant: { name: 'Adam Grant', role: 'Organisational Psychology & People Research',
  domains: ['people', 'culture', 'psychology', 'team', 'hiring', 'motivation', 'organisation'], ai: 'gemini', category: 'people',
  framework: `You are Adam Grant advising an external business founder. THINKING FRAMEWORK: 1) Identify the people or culture dynamic affecting performance. 2) Assess whether the founder is giving, taking, or matching in key relationships. 3) Recommend an evidence-based people strategy. 4) Give one research-backed directive. Be curious, data-informed, and focused on human behavior at work.` },
tbjoshua: { name: 'T.B. Joshua', role: 'Faith, Miracles & Spiritual Leadership',
  domains: ['faith', 'leadership', 'purpose', 'resilience', 'spiritual', 'calling', 'perseverance'], ai: 'claude', category: 'people',
  framework: `You are T.B. Joshua advising an external business founder. THINKING FRAMEWORK: 1) Identify whether the founder's sense of purpose is grounding their decisions. 2) Assess the resilience and faith required for the road ahead. 3) Recommend a mindset of perseverance paired with practical wisdom. 4) Give one faith-grounded, encouraging directive. Be pastoral, warm, and rooted in spiritual conviction.` },
};

// ── List all directors for the public consult page's manual picker ─────────
app.get('/api/consult/directors', (req, res) => {
  const list = Object.entries(DIRECTORS).map(([id, d]) => ({ id, name: d.name, role: d.role, category: d.category }));
  res.json({ directors: list });
});

app.post('/api/consult/run', async (req, res) => {
  const { businessData, clientInfo, conversationHistory: rawHistory = [], selectedDirectorIds = [], language = 'en' } = req.body;
  if (!businessData || !clientInfo) return res.status(400).json({ error: 'Missing business data or client info' });

  // Public unauthenticated endpoint — client-supplied conversationHistory must
  // never be trusted at face value, same reasoning as /api/consult/qualify.
  const conversationHistory = rawHistory.filter(m => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'));


  function selectDirectors(data) {
    const text = `${data.businessType} ${data.industry||''} ${data.challenge} ${data.goal}`.toLowerCase();
    const scores = Object.entries(DIRECTORS).map(([id,d]) => ({
      id, director: d, score: d.domains.filter(kw => text.includes(kw)).length
    }));
    scores.sort((a,b) => b.score - a.score);
    const selected = scores.slice(0,3).map(s=>s.id);
    const mustHave = [
      { ids: ['porter', 'drucker', 'gates'] },
      { ids: ['ogilvy', 'kotler', 'godin'] },
      { ids: ['buffett', 'dalio', 'thiel'] }
    ];
    mustHave.forEach(({ ids }) => {
      if (!ids.some(id => selected.includes(id)) && selected.length < 6) {
        const best = scores.find(s => ids.includes(s.id));
        if (best) selected.push(best.id);
      }
    });
    return [...new Set(selected)].slice(0,6).map(id => ({ id, ...DIRECTORS[id] }));
  }

  // Manual selection (if the user picked directors themselves) takes priority;
  // otherwise fall back to automatic keyword-based matching as before.
  const validManualIds = (selectedDirectorIds || []).filter(id => DIRECTORS[id]).slice(0, 6);
  const directors = validManualIds.length
    ? validManualIds.map(id => ({ id, ...DIRECTORS[id] }))
    : selectDirectors(businessData);
  const businessContext = `
CLIENT: ${clientInfo.name} (${clientInfo.email})
BUSINESS TYPE: ${businessData.businessType}
INDUSTRY: ${businessData.industry || 'Not specified'}
LOCATION: ${businessData.location || 'Not specified'}
GROWTH STAGE: ${businessData.stage || 'Early stage'}
MAIN CHALLENGE: ${businessData.challenge}
GOAL: ${businessData.goal}
ADDITIONAL CONTEXT FROM CONVERSATION:
${conversationHistory.map(m => `${m.role === 'user' ? 'Client' : 'Board'}: ${m.content}`).join('\n')}
  `.trim();

  try {
    const insights = [];
    for (const director of directors) {
      const directorPrompt = `${director.framework}

You are providing ONE section of a structured board consultation report for a client of Arreyon Consult by G-DESIGNS LTD.

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

Format your response as plain text paragraphs. No headers. No bullet points.${language === 'fr' ? ' Respond entirely in French (Français) — every word of your reply must be in French, written as ' + director.name + ' would express it in French.' : ''}`;

      let insight;
      try {
        if (director.ai === 'chatgpt') insight = await askChatGPT(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }], { feature: 'consult_board' });
        else if (director.ai === 'gemini') insight = await askGemini(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }], { feature: 'consult_board' });
        else if (director.ai === 'perplexity') insight = await askPerplexity(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }], { feature: 'consult_board' });
        else insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }], { feature: 'consult_board' });
      } catch (dirErr) {
        try { insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }], { feature: 'consult_board' }); }
        catch (fallbackErr) { insight = `${director.name} was unavailable for this consultation.`; }
      }

      insights.push({ id: director.id, name: director.name, role: director.role, ai: director.ai, insight: insight.trim() });
    }

    const synthesisPrompt = `You are the Chief Strategy Officer of Arreyon Consult by G-DESIGNS LTD synthesising a board consultation report.

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

Keep each section concise and actionable. Total: 400-500 words.${language === 'fr' ? '\n\nIMPORTANT: Keep the five section header labels EXACTLY as written above, in English (EXECUTIVE SUMMARY, KEY STRATEGIC RECOMMENDATIONS, RISK ANALYSIS, 90-DAY ACTION PLAN, FINAL VERDICT) — the application parses the report by matching these exact English labels. But write ALL the actual content under each header entirely in French (Français).' : ''}`;

    const synthesis = await askClaude(synthesisPrompt, [{ role: 'user', content: 'Synthesise the board consultation.' }], { feature: 'consult_board' });

    res.json({
      success: true, client: clientInfo, businessData,
      directors: directors.map(d => ({ id: d.id, name: d.name, role: d.role, ai: d.ai })),
      insights, synthesis: synthesis.trim(), generatedAt: new Date().toISOString()
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

function getVideoDimensions(deviceType) {
  switch(deviceType) {
    case 'mobile':  return { width: 720,  height: 1280, aspect_ratio: '9:16' };
    case 'tablet':  return { width: 1080, height: 1080, aspect_ratio: '1:1'  };
    default:        return { width: 1280, height: 720,  aspect_ratio: '16:9' };
  }
}

async function generateHeyGenVideo(script, deviceType = 'desktop') {
  if (!HEYGEN_KEY || !HEYGEN_AVATAR || !HEYGEN_VOICE) {
    throw new Error('HeyGen credentials not configured');
  }

  const { width, height, aspect_ratio } = getVideoDimensions(deviceType);

  const createRes = await fetch(`${HEYGEN_API}/v2/video/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': HEYGEN_KEY },
    body: JSON.stringify({
      video_inputs: [{
        character: { type: 'avatar', avatar_id: HEYGEN_AVATAR, avatar_style: 'normal' },
        voice: { type: 'text', input_text: script, voice_id: HEYGEN_VOICE, speed: 1.0 },
        background: { type: 'color', value: '#09090f' }
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
    if (status === 'failed') throw new Error('HeyGen video generation failed: ' + (statusData?.data?.error || 'Unknown error'));
  }
  throw new Error('HeyGen video generation timed out after 3 minutes');
}

app.post('/api/heygen/welcome', async (req, res) => {
  const { clientName, businessType, deviceType = 'desktop' } = req.body;
  if (!clientName || !businessType) return res.status(400).json({ error: 'Missing clientName or businessType' });

  const welcomeScriptPrompt = `Write a very short welcome video script for ${clientName} who is consulting the Arreyon Consult Board of Directors about their ${businessType} business.

STRICT RULES:
- Maximum 22 words total — count carefully, this is a hard limit
- Must take no more than 10 seconds to speak aloud
- Warm, personal, single sentence or two short sentences
- Mention their name
- Return ONLY the script, nothing else

Example length/style: "Welcome ${clientName}. Your board is ready. Let's understand your ${businessType} business and get you real strategic advice."`;

  try {
    const script = await askClaude(welcomeScriptPrompt, [{ role: 'user', content: 'Write the welcome script now. Maximum 22 words — hard limit, must be under 10 seconds spoken.' }], { feature: 'heygen_video' });
    const { videoUrl } = await generateHeyGenVideo(script.trim(), deviceType);
    res.json({ success: true, videoUrl, deviceType });
  } catch (err) {
    console.error('HeyGen welcome error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/heygen/report', async (req, res) => {
  const { clientName, businessType, synthesis, deviceType = 'desktop' } = req.body;
  if (!clientName || !synthesis) return res.status(400).json({ error: 'Missing clientName or synthesis' });

  const scriptPrompt = `You are creating a 25-40 second video script for an AI presenter delivering board recommendation highlights.

Extract only the most critical points from this board synthesis and turn them into a natural, confident spoken script.

CLIENT: ${clientName}
BUSINESS: ${businessType}
SYNTHESIS: ${synthesis}

SCRIPT RULES:
- Start with: "Good day ${clientName}. Here is your Arreyon Board verdict on your ${businessType}."
- Cover ONLY: the single most important finding and top 2 action items
- End with: "Your full report with all board insights is ready below."
- Spoken, natural language — conversational not formal
- Between 60 and 95 words total — strictly no more than 95 words
- Return ONLY the script text, nothing else`;

  try {
    const script = await askClaude(scriptPrompt, [{ role: 'user', content: 'Generate the video script now.' }], { feature: 'heygen_video' });
    const { videoUrl } = await generateHeyGenVideo(script.trim(), deviceType);
    res.json({ success: true, videoUrl, deviceType });
  } catch (err) {
    console.error('HeyGen report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE BOARD (existing, password protected)
// ═══════════════════════════════════════════════════════════════════════════

const BOARD_PASSWORD = process.env.BOARD_PASSWORD || 'gdesigns2026';
app.post('/api/board-auth', (req, res) => {
  const { password } = req.body;
  if (password === BOARD_PASSWORD) res.json({ success: true });
  else res.status(401).json({ success: false });
});

// ── Internal board single-director chat (no auth/plan limits — password-gated) ──
app.post('/api/chat', async (req, res) => {
  const { persona, messages, ai, language = 'en' } = req.body;
  if (!persona || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing persona or messages' });
  }
  try {
    const localizedPersona = persona + frenchInstruction(language);
    let reply;
    const model = ai || 'claude';
    if (model === 'chatgpt') reply = await askChatGPT(localizedPersona, messages, { feature: 'internal_board_chat' });
    else if (model === 'gemini') reply = await askGemini(localizedPersona, messages, { feature: 'internal_board_chat' });
    else if (model === 'perplexity') reply = await askPerplexity(localizedPersona, messages, { feature: 'internal_board_chat' });
    else reply = await askClaude(localizedPersona, messages, { feature: 'internal_board_chat' });
    res.json({ reply, ai: model });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Internal board auto-match (no auth — /board is password-gated at UI level) ──
app.post('/api/board-match', async (req, res) => {
  const { challenge, directors: rawDirectors } = req.body;
  if (!challenge || !rawDirectors || !rawDirectors.length) {
    return res.status(400).json({ error: 'Missing challenge or director list' });
  }
  // Defensively drop any malformed entries (null/undefined, or missing the
  // fields we need) rather than letting one bad entry crash the whole
  // request — client-supplied data should never be able to take the server down.
  const directors = rawDirectors.filter(d => d && d.id && d.name && d.role);
  if (!directors.length) {
    return res.status(400).json({ error: 'No valid directors in the provided list' });
  }

  try {
    const matchPrompt = `A founder described this challenge: "${challenge}"

Here is the list of available board directors, each with their specialty:
${directors.map(d => `- ${d.id}: ${d.name} — ${d.role}`).join('\n')}

Pick the ONE director whose specialty best matches this challenge. Return ONLY the director's id, nothing else.`;

    const result = await askClaude(matchPrompt, [{ role: 'user', content: 'Which director id matches best?' }], { feature: 'internal_board_match' });
    const matchedId = result.trim().toLowerCase().replace(/[^a-z]/g, '');
    const valid = directors.find(d => d.id === matchedId);
    res.json({ directorId: valid ? matchedId : directors[0].id });
  } catch (err) {
    console.error('Board match error:', err.message);
    res.json({ directorId: directors[0].id });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL BOARD — ephemeral BI utilities (no auth, nothing persisted to DB)
// Password-gated at the UI level, same as /api/chat and /api/board-match above.
// Website Analyzer, Research, and Chairman Synthesis are genuinely portable
// here since they don't depend on a saved account/business profile. Entrepreneur
// Mode and Business Plans are intentionally NOT duplicated here — they're
// multi-step, saved workflows already fully available on the real dashboard.
// ═══════════════════════════════════════════════════════════════════════════

// ── Quick Website Analyzer — same extraction logic, nothing saved ──────────
app.post('/api/board-analyze', async (req, res) => {
  const { url, language = 'en' } = req.body;
  if (!url) return res.status(400).json({ error: 'Website URL is required' });

  let normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = 'https://' + normalizedUrl;

  try {
    const pages = await analyzeWebsite(normalizedUrl);
    const facts = await structureBusinessFacts(pages, normalizedUrl, null, language);
    res.json({ success: true, analyzedUrl: normalizedUrl, pagesAnalyzed: pages.map(p => p.url), facts });
  } catch (err) {
    console.error('Board website analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please check the URL and try again.' });
  }
});

// ── Quick Market Research — takes ad-hoc business info, nothing saved ──────
app.post('/api/board-research', async (req, res) => {
  const { businessName, industry, city, country, scope, language = 'en' } = req.body;
  if (!businessName && !industry) return res.status(400).json({ error: 'Please provide at least a business name or industry.' });

  try {
    const adHocBusiness = { name: businessName || 'This business', industry: industry || '', city: city || '', country: country || '' };
    const { structured, sources } = await runBusinessResearch(adHocBusiness, null, scope === 'national' ? 'national' : 'both', {}, language);
    res.json({ success: true, structured, sources });
  } catch (err) {
    console.error('Board research error:', err.message);
    res.status(500).json({ error: err.message || 'Research failed. Please try again.' });
  }
});

// ── Quick Verification — verify a set of recommendations just generated ────
app.post('/api/board-verify', async (req, res) => {
  const { structured, sources, language = 'en' } = req.body;
  if (!structured) return res.status(400).json({ error: 'No research results to verify.' });

  try {
    const verification = await runVerificationPass(structured, sources || [], null, language);
    res.json({ success: true, verification });
  } catch (err) {
    console.error('Board verification error:', err.message);
    res.status(500).json({ error: err.message || 'Verification failed. Please try again.' });
  }
});

// ── Chairman's Board Verdict — same synthesis as Boardroom, no auth needed ──
app.post('/api/board-synthesize', async (req, res) => {
  const { conversations, language = 'en' } = req.body;
  if (!conversations || !Array.isArray(conversations) || !conversations.length) {
    return res.status(400).json({ error: 'No conversations to synthesize. Chat with at least one director first.' });
  }

  try {
    const transcripts = conversations.map(c => {
      const lines = (c.messages || []).slice(-16).map(m => `${m.from === 'you' ? 'Founder' : c.directorName}: ${m.text}`).join('\n');
      return `=== ${c.directorName} (${c.directorRole || 'Board Member'}) ===\n${lines}`;
    }).join('\n\n');

    const multiDirector = conversations.length > 1;

    const prompt = `You are the Chairman of the Board at Arreyon Consult, synthesizing a live boardroom session into one final decision for the founder.

${multiDirector ? `The founder spoke with ${conversations.length} different board members in this session.` : `The founder spoke with one board member in this session.`}

FULL CONVERSATION TRANSCRIPTS:
${transcripts.slice(0, 10000)}

YOUR TASK:
1. Identify the founder's core problem or question, based on what they actually discussed.
2. Summarize the key advice given${multiDirector ? ' by each director' : ''}.
${multiDirector ? '3. Identify any disagreements or tensions between what different directors advised — do not paper over conflicting advice, name it explicitly.\n4. Weigh the disagreement and determine which position is better supported by sound business reasoning, or whether it depends on a specific unstated assumption (state what that assumption is).\n5.' : '3.'} Produce ONE final, clear recommendation — the Chairman's verdict — that the founder should act on.
${multiDirector ? '6.' : '4.'} State your confidence in this verdict and why.

Be decisive. The founder came to the board for a boardroom-grade final answer, not a menu of options.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "core_problem": "the founder's actual problem or question, in one sentence",
  "key_advice": [
    {"director": "Director Name", "summary": "their core advice, 1-2 sentences"}
  ],
  "disagreements": "Only include this key if multiple directors gave conflicting advice — describe the disagreement and which side has stronger reasoning, or omit this key entirely if directors were aligned or only one director was consulted",
  "chairman_verdict": "The final, decisive recommendation — 2-4 sentences, clear and actionable",
  "confidence": "high|medium|low",
  "confidence_reason": "why this confidence level — what's solid vs. uncertain about this verdict"
}`;

    const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Produce the Chairman synthesis now, as JSON only.' }], complexity: 'complex', context: { feature: 'chairman_synthesis' }, maxTokens: 2000 });
    const synthesis = extractJSON(raw);
    res.json({ success: true, synthesis });
  } catch (err) {
    console.error('Board synthesis error:', err.message);
    res.status(500).json({ error: err.message || 'Synthesis failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH ENGINE — Increment 3
// Provider-agnostic ResearchProvider abstraction. Tavily is the first (and
// currently only) implementation — switching providers later means adding
// one new function here, not touching any call site.
// ═══════════════════════════════════════════════════════════════════════════

const RESEARCH_LIMITS = { starter: 0, pro: 5, business: -1 };

// ── ResearchProvider: Tavily implementation ─────────────────────────────────
async function tavilySearch(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error('Research is not configured yet');

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      max_results: maxResults
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.detail || `Tavily search failed with status ${res.status}`);
  }
  const data = await res.json();
  return (data.results || []).map(r => ({
    title: r.title, url: r.url, snippet: r.content, publishedDate: r.published_date || null
  }));
}

// ── ResearchProvider: Perplexity implementation ─────────────────────────────
// Used specifically for competitor and market-context research (Phase 5),
// not as a replacement for researchSearch()/tavilySearch() — those stay on
// Tavily for every other feature. Perplexity's API returns one synthesized,
// already-cited answer rather than a list of raw snippets like Tavily, so
// this reshapes that into the same {title, url, snippet, publishedDate}
// array shape the rest of the codebase already expects, keeping it a
// drop-in wherever it's used.
async function perplexitySearch(query, { maxResults = 5 } = {}) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('Perplexity research is not configured yet');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }]
    })
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `Perplexity search failed with status ${res.status}`);
  }
  const data = await res.json();
  const answer = data.choices?.[0]?.message?.content;
  const citations = (data.citations || []).slice(0, maxResults);

  const results = [];
  if (answer) {
    // The synthesized answer itself is the most useful single result —
    // already grounded and summarized, unlike a raw scraped snippet.
    results.push({ title: 'Perplexity research summary', url: citations[0] || null, snippet: answer, publishedDate: null });
  }
  citations.slice(answer ? 1 : 0).forEach(url => {
    results.push({ title: 'Source', url, snippet: '', publishedDate: null });
  });
  return results;
}

// ── Provider-agnostic entry point — swap the implementation here, nowhere else ──
async function researchSearch(query, options) {
  return tavilySearch(query, options);
}

// ── Run market/competitor research for a business, save sources, synthesize ──
async function runBusinessResearch(business, userId, scope = 'both', knownFacts = {}, language = 'en') {
  const bizName = business.name || business.website;
  const industry = business.industry || '';
  const country = business.country || '';
  const city = business.city || '';
  const includeInternational = scope === 'both';

  const queries = [];

  if (country) {
    queries.push(`best ${industry} companies in ${city ? city + ', ' : ''}${country}`.trim());
    queries.push(`${industry} competitors ${bizName} ${country}`.trim());
    if (includeInternational) {
      queries.push(`international ${industry} companies operating in ${country} Africa`.trim());
    }
    queries.push(`${industry} market trends ${country} 2026`.trim());
  } else {
    queries.push(`${bizName} competitors ${industry}`.trim());
    queries.push(`${industry} market trends 2026`.trim());
  }

  const allSources = [];
  for (const q of queries) {
    try {
      const results = await researchSearch(q, { maxResults: 6 });
      allSources.push(...results.map(r => ({ ...r, query: q })));
    } catch (e) {
      continue;
    }
  }

  if (!allSources.length) {
    throw new Error('No research results could be retrieved. Please try again later.');
  }

  const seen = new Set();
  const uniqueSources = allSources.filter(s => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  const sourcesText = uniqueSources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.snippet}`).join('\n\n');

  const businessContext = country
    ? `${bizName} is based in ${city ? city + ', ' : ''}${country}, operating in the ${industry || 'general'} industry.`
    : `${bizName} operates in the ${industry || 'general'} industry. Its specific country/location was not determined during analysis.`;

  const scopeInstruction = includeInternational
    ? `Include BOTH kinds of competitors found: companies based only in ${country || 'the local market'} ("scope": "local"), and companies that operate across multiple countries or globally while also serving ${country || 'this market'} ("scope": "international"). Do not exclude international competitors.`
    : `The client asked for NATIONAL research only. Only include competitors based in or primarily operating within ${country || 'the local market'} ("scope": "local"). Exclude international/global-only players even if they appear in search results — do not include one just to reach a higher competitor count. It is better to return 2 genuinely local competitors than 8 that include international ones. Every competitor listed must be tagged "scope": "local" — never "scope": "international" for this request.`;

  // What we already know about the business itself, for a real gap comparison
  const knownFactsText = Object.entries(knownFacts).filter(([,v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const knownFactsBlock = knownFactsText
    ? `\nWHAT WE ALREADY KNOW ABOUT ${bizName.toUpperCase()} (from its own website/description):\n${knownFactsText}\n`
    : `\n(No detailed profile of ${bizName}'s own offerings was available — skip the competitive gap comparison and omit "competitive_gaps" entirely.)\n`;

  const synthesisPrompt = `You are a senior market research analyst and business strategist producing a formal, detailed report. ${businessContext}

Research scope requested by the client: ${includeInternational ? 'National + International' : 'National only'}.
${knownFactsBlock}
Below are real search results from queries aimed at finding this business's competitors and market context.

SEARCH RESULTS:
${sourcesText.slice(0, 14000)}

YOUR TASK:
Produce a complete, professional-grade report based ONLY on the search results above and the known facts about ${bizName} — written as if for a real investor or strategic decision, not a summary. (1) full detailed market and competitor analysis, (2) a competitive gap comparison, (3) a summary and audit of research reliability, (4) recommendations broken into clear, structured sections — not one paragraph.

CRITICAL RULES:
- Every competitor and claim must be traceable to one of the numbered sources above — cite using the source number in "source_ref"
- ${scopeInstruction}
- If the search results don't clearly answer something, say so explicitly rather than guessing — do not invent competitor names, statistics, or facts not present above. Depth means writing substantively about what the evidence actually supports, never padding with invented specifics.
- For "competitive_gaps": compare what competitors are shown doing/offering against what we know ${bizName} offers. Only list a gap if a specific competitor's description clearly shows something ${bizName}'s known facts do NOT mention. Do not guess at gaps with no evidence.
- Each recommendation must have a short title, a substantive solution/strategy with real reasoning, and 2-4 concrete action steps — no vague advice
- The audit section must honestly assess coverage gaps, not just praise the findings

Return ONLY valid JSON, no markdown formatting, in exactly this structure:
{
  "market_context": "4-6 sentences on the overall market situation — size and growth if the evidence supports an estimate, key dynamics, and what's actually driving demand",
  "full_analysis": "A detailed, substantive analysis (aim for 8-10 sentences) covering market dynamics, competitive intensity, barriers to entry, pricing dynamics, customer behavior, and positioning implications for ${bizName} specifically — written with the depth of a professional analyst's report",
  "local_coverage_note": "Only include this key if results were thin overall — explain what was actually found instead",
  "competitors": [
    {"name": "...", "description": "what they offer, their apparent scale and reach, and how they're positioned — 2-3 sentences with real substance", "differentiator": "their apparent edge or weakness, explained with reasoning, not just a label", "scope": "local", "source_ref": "1"}
  ],
  "competitive_gaps": [
    {"gap": "specific thing competitors offer that ${bizName} does not appear to, explained with enough context to understand why it matters", "competitor_names": ["Name1","Name2"], "source_ref": "1"}
  ],
  "opportunity_gap": "The clearest gap or underserved angle this business could exploit — 2-3 sentences explaining why it's real and what capturing it would take",
  "audit_summary": "3-4 sentences honestly assessing how complete and reliable this research is",
  "audit_coverage": [
    {"area": "e.g. Local competitor pricing", "status": "covered|partial|not covered", "note": "explanation with enough detail to be useful, not just a label"}
  ],
  "strategic_recommendations": [
    {
      "title": "short 3-6 word recommendation title",
      "problem_addressed": "the specific gap or finding this responds to, explained with real context",
      "solution": "the recommended solution or strategy, explained substantively with reasoning — 2-3 sentences",
      "action_steps": ["concrete step 1", "concrete step 2", "concrete step 3"],
      "priority": "high|medium|low"
    }
  ]
}

List up to 8 competitors total${includeInternational ? ', aiming for a mix of local and international where results support it' : ' (national only)'}. Up to 4 competitive_gaps (omit the key entirely if none can be evidenced). Up to 4 strategic_recommendations, ranked by priority. Up to 4 audit_coverage rows. Omit "local_coverage_note" entirely if results were adequate.`;

  const raw = await askClaude(synthesisPrompt + frenchInstruction(language, { jsonMode: true }), [{ role: 'user', content: 'Produce the complete structured report now, as JSON only.' }], { feature: 'research_engine', userId }, 6000);
  let structured;
  try {
    structured = extractJSON(raw);
  } catch (e) {
    console.error('Research JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
    throw new Error('Could not parse market research — please try again');
  }

  // The prompt instructs the model to exclude international competitors for
  // a national-only request, but a prompt instruction is not a guarantee —
  // enforce it deterministically here rather than trusting compliance.
  // Only removes competitors EXPLICITLY tagged "international"; a missing
  // or malformed scope tag is never treated as a reason to remove one,
  // since that risks losing a genuine local competitor the model simply
  // forgot to tag.
  if (!includeInternational && Array.isArray(structured.competitors)) {
    const beforeCount = structured.competitors.length;
    structured.competitors = structured.competitors.filter(c => c.scope !== 'international');
    const removedCount = beforeCount - structured.competitors.length;
    if (removedCount > 0) {
      const filterNote = language === 'fr'
        ? `${removedCount} concurrent(s) international(aux) trouvé(s) dans les résultats de recherche ont été exclus conformément à votre demande de portée nationale uniquement.`
        : `${removedCount} international competitor${removedCount === 1 ? '' : 's'} found in the search results ${removedCount === 1 ? 'was' : 'were'} excluded per your national-only request.`;
      structured.local_coverage_note = structured.local_coverage_note ? `${structured.local_coverage_note} ${filterNote}` : filterNote;
    }
  }

  const flatSummary = [
    structured.market_context,
    structured.local_coverage_note ? `Note: ${structured.local_coverage_note}` : '',
    structured.competitors?.length ? 'Competitors: ' + structured.competitors.map(c => c.name).join(', ') : '',
    structured.opportunity_gap ? `Opportunity: ${structured.opportunity_gap}` : '',
    structured.strategic_recommendations?.length ? 'Recommendations: ' + structured.strategic_recommendations.map(r => r.title).join('; ') : ''
  ].filter(Boolean).join('\n\n');

  return { summary: flatSummary, structured, sources: uniqueSources, queries, scope };
}

// ── Research endpoint ────────────────────────────────────────────────────────
app.post('/api/business/:id/research', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    const limit = RESEARCH_LIMITS[plan] ?? 0;

    if (limit === 0) {
      return res.status(403).json({ error: 'Market research is available on Arreyon Pro and above.', upgradeRequired: true });
    }
    if (limit !== -1) {
      const usedThisMonth = await pool.query(
        `SELECT COUNT(*) FROM research_sessions WHERE user_id = $1
         AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
        [account.id]
      );
      const used = parseInt(usedThisMonth.rows[0].count, 10);
      if (used >= limit) {
        return res.status(403).json({ error: `You've used your ${limit} research reports this month. Upgrade for more.`, upgradeRequired: true });
      }
    }

    const biz = await pool.query('SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    // Latest known fact per key — this is what lets research compare "what we offer" vs competitors
    const factsResult = await pool.query(
      `SELECT DISTINCT ON (fact_key) fact_key, fact_value FROM business_facts
       WHERE business_id = $1 AND fact_key IN ('products_services', 'value_proposition', 'positioning', 'target_customers', 'pricing_info')
       ORDER BY fact_key, created_at DESC`,
      [req.params.id]
    );
    const knownFacts = {};
    factsResult.rows.forEach(r => { knownFacts[r.fact_key] = r.fact_value; });

    const requestedScope = req.body?.scope === 'national' ? 'national' : 'both';
    const requestedLanguage = req.body?.language === 'fr' ? 'fr' : 'en';
    const { summary, structured, sources, queries } = await runBusinessResearch(biz.rows[0], req.userId, requestedScope, knownFacts, requestedLanguage);

    const session = await pool.query(
      `INSERT INTO research_sessions (business_id, user_id, query, summary, scope, structured_data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.params.id, account.id, queries.join(' | '), summary, requestedScope, JSON.stringify(structured)]
    );
    const sessionId = session.rows[0].id;

    for (const s of sources) {
      await pool.query(
        `INSERT INTO research_sources (research_session_id, title, url, snippet, published_date) VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, s.title, s.url, s.snippet, s.publishedDate]
      );
    }

    // Also save the summary as a labeled business fact
    await pool.query(
      `INSERT INTO business_facts (business_id, fact_key, fact_value, source_type, source_detail)
       VALUES ($1, 'market_research', $2, 'research', $3)`,
      [req.params.id, summary, `${sources.length} sources, ${new Date().toISOString().slice(0,10)}`]
    );

    // Per plan: Starter gets a manual "Verify" button only. Pro/Business get automatic
    // verification right after research completes (and can still manually re-trigger).
    let verification = null;
    if (plan === 'pro' || plan === 'business') {
      try {
        verification = await runVerificationPass(structured, sources, req.userId, requestedLanguage);
        await pool.query('UPDATE research_sessions SET verification_data = $1, verification_data_fr = NULL WHERE id = $2', [JSON.stringify(verification), sessionId]);
      } catch (e) {
        console.error('Auto-verification failed (non-fatal):', e.message);
        // Verification failing shouldn't block the research result itself — the
        // manual "Verify" button remains available if this happens.
      }
    }

    res.json({ success: true, sessionId, summary, structured, sources, verification, autoVerified: !!verification });
  } catch (err) {
    console.error('Research error:', err.message);
    res.status(500).json({ error: err.message || 'Research failed. Please try again.' });
  }
});

// ── Get a business's research history ───────────────────────────────────────
app.get('/api/business/:id/research', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const sessions = await pool.query(
      'SELECT * FROM research_sessions WHERE business_id = $1 ORDER BY created_at DESC', [req.params.id]
    );
    const sessionsWithSources = [];
    for (const session of sessions.rows) {
      const sources = await pool.query('SELECT * FROM research_sources WHERE research_session_id = $1', [session.id]);
      sessionsWithSources.push({ ...session, sources: sources.rows });
    }

    // Only the LATEST session is ever actually displayed in the UI (older ones
    // sit in history, rarely re-opened) — translate just that one on demand
    // rather than burning AI calls on an entire history nobody's viewing.
    if (lang === 'fr' && sessionsWithSources.length) {
      const latest = sessionsWithSources[0];
      try {
        if (latest.structured_data && !latest.structured_data_fr) {
          const translated = await translateStructuredContent(latest.structured_data, 'market research report');
          await pool.query('UPDATE research_sessions SET structured_data_fr = $1 WHERE id = $2', [JSON.stringify(translated), latest.id]);
          latest.structured_data_fr = translated;
        }
        if (latest.verification_data && !latest.verification_data_fr) {
          const translatedV = await translateStructuredContent(latest.verification_data, 'verification report');
          await pool.query('UPDATE research_sessions SET verification_data_fr = $1 WHERE id = $2', [JSON.stringify(translatedV), latest.id]);
          latest.verification_data_fr = translatedV;
        }
      } catch (e) {
        console.error('Research auto-translate failed (non-fatal, falling back to English):', e.message);
      }
      if (latest.structured_data_fr) latest.structured_data = latest.structured_data_fr;
      if (latest.verification_data_fr) latest.verification_data = latest.verification_data_fr;
    }

    res.json({ sessions: sessionsWithSources });
  } catch (e) { res.status(500).json({ error: 'Failed to load research history' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// VERIFICATION ENGINE — Increment 4, part 2
// Self-challenge pass: for each recommendation, identify the strongest argument
// against it, check whether the actual evidence supports that objection, and
// revise the recommendation if the objection holds. Produces a confidence report.
// ═══════════════════════════════════════════════════════════════════════════

async function runVerificationPass(structured, sources, userId, language = 'en') {
  const recs = structured.strategic_recommendations || [];
  if (!recs.length) {
    return { overall_confidence: 'low', evidence_quality: 'low', data_completeness_note: 'No recommendations were generated to verify.', main_uncertainty: 'No recommendations available.', recommendation_checks: [] };
  }

  const sourcesText = (sources || []).map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet || ''}`).join('\n\n');
  const recsText = recs.map((r, i) => `${i + 1}. ${r.title || r.action}\nSolution: ${r.solution || r.reason}\nAddresses: ${r.problem_addressed || 'N/A'}`).join('\n\n');

  const prompt = `You are a skeptical senior reviewer performing a verification pass on a set of business recommendations before they are finalized for a client. Your job is to stress-test them, not to praise them.

ORIGINAL EVIDENCE / SOURCES USED:
${sourcesText.slice(0, 6000)}

MARKET CONTEXT: ${structured.market_context || ''}
OPPORTUNITY GAP IDENTIFIED: ${structured.opportunity_gap || 'None stated'}

RECOMMENDATIONS TO VERIFY:
${recsText}

YOUR TASK — for EACH recommendation:
1. Identify the single strongest argument against it (the best case for why it might be wrong or premature).
2. Check honestly: does the evidence above actually support that objection, or is the objection weak/unsupported?
3. Give a verdict: "upheld" (objection doesn't hold, recommendation stands), "weakened" (objection has some merit, recommendation is still reasonable but less certain), or "revise" (objection is strong enough that the recommendation should change — in this case briefly state what the revised approach should be).

Then give an OVERALL assessment of this entire research pass:
- Overall confidence (high/medium/low) in the recommendations as a whole
- Evidence quality (high/medium/low) — were sources specific and relevant, or thin/generic?
- Data completeness — what's the most important missing piece of information that would have made this more reliable?
- Main uncertainty — the single biggest thing that could change the picture if it turned out to be wrong

Be genuinely critical. If a recommendation is weak, say "revise", don't soften it to "upheld" out of politeness.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "overall_confidence": "high|medium|low",
  "evidence_quality": "high|medium|low",
  "data_completeness_note": "the most important missing piece of information",
  "main_uncertainty": "the single biggest uncertainty that could change the recommendations",
  "recommendation_checks": [
    {"recommendation_title": "...", "strongest_objection": "...", "objection_supported_by_evidence": true, "verdict": "upheld|weakened|revise", "note": "brief explanation; if verdict is revise, state the revised approach here"}
  ]
}`;

  const raw = await callAI({ persona: prompt + frenchInstruction(language, { jsonMode: true }), messages: [{ role: 'user', content: 'Perform the verification pass now, as JSON only.' }], complexity: 'complex', context: { feature: 'verification_engine', userId }, maxTokens: 2500 });
  try {
    return extractJSON(raw);
  } catch (e) {
    console.error('Verification JSON parse failed.', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
    throw new Error('Could not complete verification — please try again');
  }
}

// ── Verification endpoint — manual trigger (all plans) or called automatically
// right after research completes for Pro/Business (see /research endpoint) ──
app.post('/api/business/:id/research/:sessionId/verify', authRequired, async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT rs.* FROM research_sessions rs
       JOIN businesses b ON b.id = rs.business_id
       WHERE rs.id = $1 AND rs.business_id = $2 AND b.user_id = $3`,
      [req.params.sessionId, req.params.id, req.userId]
    );
    if (!session.rows.length) return res.status(404).json({ error: 'Research session not found' });
    const sessionRow = session.rows[0];
    if (!sessionRow.structured_data) return res.status(400).json({ error: 'This research session has no recommendations to verify' });

    const sourcesResult = await pool.query('SELECT * FROM research_sources WHERE research_session_id = $1', [req.params.sessionId]);

    const requestedLanguage = req.body?.language === 'fr' ? 'fr' : 'en';
    const verification = await runVerificationPass(sessionRow.structured_data, sourcesResult.rows, req.userId, requestedLanguage);

    await pool.query('UPDATE research_sessions SET verification_data = $1, verification_data_fr = NULL WHERE id = $2', [JSON.stringify(verification), req.params.sessionId]);

    res.json({ success: true, verification });
  } catch (err) {
    console.error('Verification error:', err.message);
    res.status(500).json({ error: err.message || 'Verification failed. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// WEBSITE BUSINESS ANALYZER — Increment 2
// SSRF-safe fetcher + HTML extractor + AI structuring into business_facts
// ═══════════════════════════════════════════════════════════════════════════

const PRIVATE_IP_RANGES = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,           // link-local (covers cloud metadata 169.254.169.254)
  /^0\./, /^::1$/, /^fc00:/i, /^fe80:/i
];

function isPrivateIP(ip) {
  return PRIVATE_IP_RANGES.some(re => re.test(ip));
}

// Resolve hostname and reject if it points to a private/internal address
// ── WordPress REST API client (Phase 8 / Website Intelligence) ─────────────
// Authenticates via HTTP Basic Auth with a WordPress Application Password
// (base64 of username:app_password) — the native WordPress mechanism since
// 5.6, requiring no plugin. Reuses assertPublicHost() rather than
// duplicating SSRF protection: a user-supplied site URL is exactly the
// kind of input that could otherwise be abused to reach internal
// infrastructure. Requires HTTPS, since Basic Auth credentials sent over
// plain HTTP are visible to anyone on the network path.
function buildWpUrl(siteUrl, endpoint) {
  const base = siteUrl.trim().replace(/\/+$/, '');
  return base + '/wp-json' + endpoint;
}

async function wpApiRequest(siteUrl, username, appPassword, endpoint, options = {}) {
  const url = buildWpUrl(siteUrl, endpoint);
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('WordPress connections must use https:// — WordPress Application Passwords are not safe to use over plain http.');
  }
  await assertPublicHost(parsed.hostname);

  const authHeader = 'Basic ' + Buffer.from(`${username}:${appPassword}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      signal: controller.signal,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'ArreyonConsult/1.0 (+https://consult.gdesignsme.com)',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPublicHost(hostname) {
  if (['localhost', '0.0.0.0'].includes(hostname.toLowerCase())) {
    throw new Error('URLs pointing to local/internal hosts are not allowed');
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (e) {
    throw new Error('Could not resolve hostname');
  }
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error('URLs pointing to private/internal IP ranges are not allowed');
    }
  }
}

// SSRF-safe fetch: validates scheme, host, redirects, size, and applies a timeout
async function safeFetch(urlStr, { maxBytes = 2_000_000, timeoutMs = 8000, maxRedirects = 3 } = {}) {
  let current = urlStr;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try { parsed = new URL(current); } catch { throw new Error('Invalid URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http and https URLs are allowed');
    }
    await assertPublicHost(parsed.hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'ArreyonConsult/1.0 (+https://consult.gdesignsme.com)' }
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Redirect with no location header');
      current = new URL(location, current).toString();
      continue; // re-validate the new host on next loop iteration
    }

    if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('URL did not return HTML content');
    }

    // Read body with a hard size cap
    const reader = res.body.getReader();
    let received = 0;
    let chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error('Response too large');
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
    return { html: buffer.toString('utf-8'), finalUrl: current };
  }
  throw new Error('Too many redirects');
}

// Minimal HTML text/metadata extraction — no external HTML parser dependency
function extractFromHTML(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  // Strip script/style, then tags, collapse whitespace to get readable body text
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  // Cap body text sent to the AI — keep it focused and cheap
  body = body.slice(0, 6000);

  // Pull same-domain internal links whose text/href hints at key pages
  const linkPattern = /<a\s+[^>]*href=["']([^"'#]+)["'][^>]*>([^<]*)<\/a>/gi;
  const keyPageHints = ['about', 'service', 'product', 'pricing', 'contact', 'faq'];
  const foundLinks = [];
  let m;
  while ((m = linkPattern.exec(html)) !== null && foundLinks.length < 20) {
    const href = m[1];
    const text = (m[2] || '').toLowerCase();
    if (keyPageHints.some(hint => href.toLowerCase().includes(hint) || text.includes(hint))) {
      foundLinks.push(href);
    }
  }

  return {
    title: (titleMatch?.[1] || ogTitleMatch?.[1] || '').trim(),
    description: (descMatch?.[1] || ogDescMatch?.[1] || '').trim(),
    bodyText: body,
    candidateLinks: [...new Set(foundLinks)].slice(0, 4) // crawl budget: max 4 extra pages
  };
}

// Fetch homepage + up to 4 key sub-pages (about/services/pricing/contact), within crawl budget
// ── Source Adapter registry ─────────────────────────────────────────────────
// The spec calls for different adapters per source type rather than one
// generic crawler. WebsiteSourceAdapter (below, existing behavior) handles
// normal websites; SocialSourceAdapter handles known social platforms, whose
// real content is JS-rendered and inaccessible to a plain server-side fetch —
// it extracts only what's genuinely available (Open Graph meta tags) and is
// explicit with the user about that limitation rather than pretending a full
// profile read happened.
const SOCIAL_PLATFORMS = {
  'instagram.com': 'Instagram', 'www.instagram.com': 'Instagram',
  'facebook.com': 'Facebook', 'www.facebook.com': 'Facebook', 'fb.com': 'Facebook',
  'tiktok.com': 'TikTok', 'www.tiktok.com': 'TikTok',
  'linkedin.com': 'LinkedIn', 'www.linkedin.com': 'LinkedIn',
  'twitter.com': 'Twitter/X', 'x.com': 'Twitter/X',
  'youtube.com': 'YouTube', 'www.youtube.com': 'YouTube'
};

function detectSourceType(urlStr) {
  try {
    const hostname = new URL(urlStr).hostname.toLowerCase();
    if (SOCIAL_PLATFORMS[hostname]) return { type: 'social', platform: SOCIAL_PLATFORMS[hostname] };
    return { type: 'website' };
  } catch (e) {
    return { type: 'website' };
  }
}

// SocialSourceAdapter — best-effort OG-tag extraction only, explicitly labeled
async function analyzeSocialProfile(url, platform) {
  const { html, finalUrl } = await safeFetch(url, { timeoutMs: 6000 });
  const extracted = extractFromHTML(html);
  const hasRealContent = (extracted.title && extracted.title.length > 3) || (extracted.description && extracted.description.length > 10);

  return {
    pages: [{ url: finalUrl, ...extracted }],
    isSocialProfile: true,
    platform,
    limitedData: !hasRealContent,
    limitationNote: `${platform} profiles are JavaScript-rendered — only the page title and description metadata could be read, not the full bio, posts, or follower count. For a fuller analysis, paste your main website if you have one.`
  };
}

async function analyzeWebsite(startUrl) {
  const { html, finalUrl } = await safeFetch(startUrl);
  const home = extractFromHTML(html);

  const pages = [{ url: finalUrl, ...home }];
  const base = new URL(finalUrl);

  for (const link of home.candidateLinks) {
    if (pages.length >= 5) break; // crawl budget: homepage + max 4
    try {
      const absoluteUrl = new URL(link, base).toString();
      const linkedUrl = new URL(absoluteUrl);
      if (linkedUrl.hostname !== base.hostname) continue; // same-domain only
      const { html: pageHtml, finalUrl: pageFinalUrl } = await safeFetch(absoluteUrl, { timeoutMs: 6000 });
      const extracted = extractFromHTML(pageHtml);
      pages.push({ url: pageFinalUrl, ...extracted });
    } catch (e) {
      // A sub-page failing is not fatal — continue with what we have
      continue;
    }
  }

  return pages;
}

// Ask Claude to structure raw page content into labeled business facts
async function structureBusinessFacts(pages, submittedUrl, userId, language = 'en') {
  const combined = pages.map(p => `PAGE: ${p.url}\nTITLE: ${p.title}\nDESCRIPTION: ${p.description}\nCONTENT: ${p.bodyText}`).join('\n\n---\n\n');
  const isDescriptionOnly = pages.length === 1 && pages[0].url.startsWith('User-provided description');

  const prompt = isDescriptionOnly
    ? `You are a business analyst extracting structured facts from a business owner's own written description of their business. They do not have a website yet.

OWNER'S DESCRIPTION:
${combined.slice(0, 12000)}

YOUR TASK:
Extract what the owner has genuinely told you. For EVERY fact, you must label it as one of:
- "observed" — directly and explicitly stated by the owner in their description
- "inferred" — a reasonable conclusion you're drawing from context, NOT explicitly stated

`
    : `You are a business analyst extracting structured facts from a real website's content. You will be shown raw text scraped from ${pages.length} page(s) of ${submittedUrl}.

RAW WEBSITE CONTENT:
${combined.slice(0, 12000)}

YOUR TASK:
Extract what you can genuinely observe from this content. For EVERY fact, you must label it as one of:
- "observed" — directly and explicitly stated on the page (e.g. a stated business name, a listed price, a stated location)
- "inferred" — a reasonable conclusion you're drawing from context, NOT explicitly stated (e.g. inferring "small business" from tone and lack of enterprise language)

`;
  const promptTail = `CRITICAL RULES:
- NEVER invent information that isn't supported by the text above
- If something isn't mentioned, omit it entirely — do not guess
- Prices, contact details, and business names must be "observed" only if literally present in the text
- Return ONLY valid JSON, no markdown formatting, no commentary

Return this exact JSON structure:
{
  "business_name": {"value": "...", "source_type": "observed|inferred"},
  "industry": {"value": "...", "source_type": "observed|inferred"},
  "value_proposition": {"value": "...", "source_type": "observed|inferred"},
  "products_services": {"value": "...", "source_type": "observed|inferred"},
  "target_customers": {"value": "...", "source_type": "observed|inferred"},
  "pricing_info": {"value": "...", "source_type": "observed|inferred"},
  "location": {"value": "...", "source_type": "observed|inferred"},
  "contact_info": {"value": "...", "source_type": "observed|inferred"},
  "positioning": {"value": "...", "source_type": "observed|inferred"},
  "notable_gaps": {"value": "${isDescriptionOnly ? 'What important business information is missing from what the owner shared, that a customer or investor would want to know' : 'What important business information is missing from this website that a customer or investor would want to know'}", "source_type": "inferred"}
}

Omit any key entirely if you have no supporting evidence for it. Do not include keys with empty or null values.`;

  const fullPrompt = prompt + promptTail + frenchInstruction(language, { jsonMode: true });
  const raw = await askClaude(fullPrompt, [{ role: 'user', content: 'Extract the structured business facts now, as JSON only.' }], { feature: 'website_analyzer', userId }, 1800);
  try {
    return extractJSON(raw);
  } catch (e) {
    console.error('Business facts JSON parse failed.', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
    throw new Error('Could not parse business analysis — please try again');
  }
}

// Website Analyzer monthly limits per plan (Section 27 tier matrix, agreed)
const ANALYZER_LIMITS = { starter: 1, pro: 10, business: -1 };

// ── Website Analyzer endpoint (also handles no-website description input) ──
app.post('/api/business/analyze', authRequired, async (req, res) => {
  const { url, description, businessName, userCountry, userRegion, userCity, marketScope } = req.body;
  const hasUrl = url && url.trim();
  const hasDescription = description && description.trim().length >= 20;

  if (!hasUrl && !hasDescription) {
    return res.status(400).json({ error: 'Please provide a website URL, or describe your business in at least a few sentences.' });
  }

  try {
    const account = await resolveAccount(req.userId);
    const plan = account?.plan || 'starter';
    const limit = ANALYZER_LIMITS[plan] ?? 1;

    if (limit !== -1) {
      // ai_usage.user_id stays attributed to whichever person actually made
      // each call (kept that way deliberately, for meaningful admin
      // analytics) — so counting a SHARED team quota here needs to look
      // across every member of the account, not just the owner's own calls.
      const usedThisMonth = await pool.query(
        `SELECT COUNT(*) FROM ai_usage WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_owner_id = $1) AND feature = 'website_analyzer'
         AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
        [account.id]
      );
      const used = parseInt(usedThisMonth.rows[0].count, 10);
      if (used >= limit) {
        return res.status(403).json({
          error: `You've used your ${limit} business ${limit === 1 ? 'analysis' : 'analyses'} this month. Upgrade for more.`,
          upgradeRequired: true
        });
      }
    }

    let normalizedUrl = null;
    let pages, sourceLabel;
    let socialInfo = null;

    if (hasUrl) {
      normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = 'https://' + normalizedUrl;

      const sourceType = detectSourceType(normalizedUrl);
      if (sourceType.type === 'social') {
        const socialResult = await analyzeSocialProfile(normalizedUrl, sourceType.platform);
        pages = socialResult.pages;
        sourceLabel = `${sourceType.platform} profile (${normalizedUrl})`;
        socialInfo = { platform: sourceType.platform, limitedData: socialResult.limitedData, limitationNote: socialResult.limitationNote };
      } else {
        pages = await analyzeWebsite(normalizedUrl);
        sourceLabel = normalizedUrl;
      }
    } else {
      // No website — treat the user's own description as the sole "page" to extract facts from
      pages = [{ url: 'User-provided description (no website)', title: businessName || '', description: '', bodyText: description.trim() }];
      sourceLabel = 'business description (no website)';
    }

    const requestedLanguage = req.body?.language === 'fr' ? 'fr' : 'en';
    const facts = await structureBusinessFacts(pages, sourceLabel, req.userId, requestedLanguage);

    // User-stated location is authoritative — only fall back to what the
    // AI extracted from the website/description text when the person
    // didn't tell us directly. Relying solely on AI extraction is exactly
    // what caused a Buea, Cameroon business to get USA-centric analysis:
    // if the source text never clearly states a location, extraction
    // silently comes back empty and every downstream analysis defaults to
    // ungrounded assumptions instead.
    let parsedCity = (userCity && userCity.trim()) || null;
    let parsedCountry = (userCountry && userCountry.trim()) || null;
    const parsedRegion = (userRegion && userRegion.trim()) || null;
    if (!parsedCity && !parsedCountry && facts.location?.value) {
      const parts = facts.location.value.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) { parsedCity = parts[0]; parsedCountry = parts[parts.length - 1]; }
      else if (parts.length === 1) { parsedCountry = parts[0]; }
    }
    const resolvedMarketScope = ['local', 'national', 'international'].includes(marketScope) ? marketScope : 'local';
    const parsedIndustry = facts.industry?.value || null;

    let businessId;
    if (normalizedUrl) {
      // URL path: reuse an existing business profile for this account + URL if one exists
      const existing = await pool.query(
        'SELECT id FROM businesses WHERE user_id = $1 AND website = $2 AND is_active = true LIMIT 1',
        [account.id, normalizedUrl]
      );
      if (existing.rows.length) {
        businessId = existing.rows[0].id;
        await pool.query(
          `UPDATE businesses SET updated_at = NOW(),
           industry = COALESCE($2, industry), city = COALESCE($3, city), country = COALESCE($4, country),
           region = COALESCE($5, region), market_scope = $6
           WHERE id = $1`,
          [businessId, parsedIndustry, parsedCity, parsedCountry, parsedRegion, resolvedMarketScope]
        );
      } else {
        const inserted = await pool.query(
          `INSERT INTO businesses (user_id, name, website, industry, city, country, region, market_scope) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [account.id, businessName || facts.business_name?.value || normalizedUrl, normalizedUrl, parsedIndustry, parsedCity, parsedCountry, parsedRegion, resolvedMarketScope]
        );
        businessId = inserted.rows[0].id;
      }
    } else {
      // Description-only path: no natural unique key, always create a fresh profile
      const inserted = await pool.query(
        `INSERT INTO businesses (user_id, name, website, industry, city, country, region, market_scope) VALUES ($1, $2, NULL, $3, $4, $5, $6, $7) RETURNING id`,
        [account.id, businessName || facts.business_name?.value || 'My Business', parsedIndustry, parsedCity, parsedCountry, parsedRegion, resolvedMarketScope]
      );
      businessId = inserted.rows[0].id;
    }

    // Store each fact, tagged with its source type
    for (const [key, data] of Object.entries(facts)) {
      if (!data || !data.value) continue;
      await pool.query(
        `INSERT INTO business_facts (business_id, fact_key, fact_value, source_type, source_detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [businessId, key, data.value, data.source_type || 'inferred', `Analyzed from ${sourceLabel}`]
      );
    }

    res.json({
      success: true,
      businessId,
      analyzedUrl: normalizedUrl || null,
      isDescriptionOnly: !normalizedUrl,
      pagesAnalyzed: normalizedUrl ? pages.map(p => p.url) : ['Business description'],
      facts,
      socialInfo
    });
  } catch (err) {
    console.error('Website analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ── List user's analyzed businesses ─────────────────────────────────────────
app.get('/api/business', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      'SELECT id, name, website, industry, created_at, updated_at FROM businesses WHERE user_id = $1 AND is_active = true ORDER BY updated_at DESC',
      [account.id]
    );
    res.json({ businesses: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load businesses' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// REPORT GENERATION — HTML, PDF, and Word (DOCX) downloadable reports
// ═══════════════════════════════════════════════════════════════════════════

const REPORT_FACT_LABELS = {
  business_name: 'Business Name', industry: 'Industry', value_proposition: 'Value Proposition',
  products_services: 'Products & Services', target_customers: 'Target Customers',
  pricing_info: 'Pricing', location: 'Location', contact_info: 'Contact Info',
  positioning: 'Positioning', notable_gaps: "What's Missing", market_research: 'Market Research'
};

function sanitizeFilename(name) {
  return (name || 'business-report').replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').slice(0, 60);
}

// ── Generate a real chart PNG via QuickChart (free, no API key) ────────────
// Used by both PDF and DOCX so embedded charts are pixel-identical and never
// suffer manual-drawing alignment issues.
async function fetchChartImage(labels, values, colors, titleText) {
  const config = {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false }, title: { display: true, text: titleText, font: { size: 13 } } },
      scales: { x: { ticks: { precision: 0 } } }
    }
  };
  const url = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(config))}&width=420&height=${80 + labels.length * 40}&backgroundColor=white&format=png`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Chart image fetch failed');
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// Build the four standard chart datasets from report data, skipping any with no values
function buildChartDatasets({ facts, structured: s }) {
  const datasets = [];

  const factCounts = { observed: 0, inferred: 0 };
  Object.values(facts || {}).forEach(f => { if (f?.source_type && factCounts[f.source_type] !== undefined) factCounts[f.source_type]++; });
  if (factCounts.observed + factCounts.inferred > 0) {
    datasets.push({ key: 'facts', title: 'Profile Data: Observed vs Inferred', labels: ['Observed', 'AI Inferred'], values: [factCounts.observed, factCounts.inferred], colors: ['#10b981', '#8b5cf6'] });
  }

  if (s) {
    const scopeCounts = { local: 0, international: 0 };
    (s.competitors || []).forEach(c => { if (scopeCounts[c.scope] !== undefined) scopeCounts[c.scope]++; });
    if (scopeCounts.local + scopeCounts.international > 0) {
      datasets.push({ key: 'scope', title: 'Competitors by Scope', labels: ['Local', 'International'], values: [scopeCounts.local, scopeCounts.international], colors: ['#10b981', '#f59e0b'] });
    }

    const priorityCounts = { high: 0, medium: 0, low: 0 };
    (s.strategic_recommendations || []).forEach(r => { if (r.priority) priorityCounts[r.priority]++; });
    if (priorityCounts.high + priorityCounts.medium + priorityCounts.low > 0) {
      datasets.push({ key: 'priority', title: 'Recommendations by Priority', labels: ['High', 'Medium', 'Low'], values: [priorityCounts.high, priorityCounts.medium, priorityCounts.low], colors: ['#ef4444', '#f59e0b', '#6b7280'] });
    }

    const auditCounts = { covered: 0, partial: 0, 'not covered': 0 };
    (s.audit_coverage || []).forEach(c => { if (auditCounts[c.status] !== undefined) auditCounts[c.status]++; });
    if (auditCounts.covered + auditCounts.partial + auditCounts['not covered'] > 0) {
      datasets.push({ key: 'audit', title: 'Research Coverage', labels: ['Covered', 'Partial', 'Not Covered'], values: [auditCounts.covered, auditCounts.partial, auditCounts['not covered']], colors: ['#10b981', '#f59e0b', '#6b7280'] });
    }
  }

  return datasets;
}

// Fetch all chart images in parallel; any single failure is dropped, not fatal
async function fetchAllChartImages(datasets) {
  const results = await Promise.all(datasets.map(async d => {
    try {
      const buffer = await fetchChartImage(d.labels, d.values, d.colors, d.title);
      return { ...d, buffer };
    } catch (e) {
      console.error('Chart image fetch failed for', d.key, e.message);
      return { ...d, buffer: null };
    }
  }));
  return results.filter(r => r.buffer);
}

// ── HTML report (existing style, now server-generated from saved data) ─────
function buildReportHTML({ business, facts, structured: s, sources, scope, verification: v }) {
  const bizName = business.name || business.website || 'Business Report';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const factsHtml = Object.entries(facts).filter(([, f]) => f && f.value).map(([key, fact]) => `
    <tr><td style="padding:8px 12px;font-weight:600;width:180px;vertical-align:top">${REPORT_FACT_LABELS[key] || key}</td>
    <td style="padding:8px 12px;vertical-align:top">${fact.value} <span style="font-size:10px;color:#888">(${fact.source_type === 'observed' ? 'Observed' : 'AI Inferred'})</span></td></tr>`).join('');

  const competitorRows = (s?.competitors || []).map(c => `
    <tr><td style="padding:8px 12px;font-weight:600">${c.name || '—'}</td><td style="padding:8px 12px">${c.description || '—'}</td>
    <td style="padding:8px 12px">${c.differentiator || '—'}</td><td style="padding:8px 12px;text-transform:capitalize">${c.scope || 'unknown'}</td></tr>`).join('');

  const gapsHtml = (s?.competitive_gaps || []).map(g => `
    <div style="margin-bottom:10px;padding:10px 12px;background:#fff8e6;border-left:3px solid #d97706">
      <div style="font-weight:600">${g.gap}</div>
      ${g.competitor_names?.length ? `<div style="font-size:12px;color:#666">Seen at: ${g.competitor_names.join(', ')}</div>` : ''}
    </div>`).join('');

  const auditRows = (s?.audit_coverage || []).map(c => `
    <tr><td style="padding:6px 12px;font-weight:600">${c.area}</td><td style="padding:6px 12px;text-transform:capitalize">${c.status}</td><td style="padding:6px 12px">${c.note || ''}</td></tr>`).join('');

  const recsHtml = (s?.strategic_recommendations || []).map((r, i) => `
    <div style="margin-bottom:18px;padding:14px 16px;border:1px solid #e5e5e5;border-radius:8px;page-break-inside:avoid">
      <div style="font-weight:700;font-size:15px;margin-bottom:6px">${i + 1}. ${r.title || r.action || ''} ${r.priority ? `<span style="font-size:10px;font-weight:700;text-transform:uppercase;color:#888;border:1px solid #ccc;border-radius:4px;padding:1px 6px;margin-left:6px">${r.priority} priority</span>` : ''}</div>
      ${r.problem_addressed ? `<div style="font-size:12.5px;color:#777;margin-bottom:6px"><em>Addresses: ${r.problem_addressed}</em></div>` : ''}
      <div style="font-size:13.5px;margin-bottom:8px">${r.solution || r.reason || ''}</div>
      ${r.action_steps?.length ? `<ul style="margin:0;padding-left:20px;font-size:13px">${r.action_steps.map(step => `<li style="margin-bottom:4px">${step}</li>`).join('')}</ul>` : ''}
    </div>`).join('');

  const sourcesHtml = (sources || []).map((src, i) => `
    <div style="font-size:12px;margin-bottom:6px"><strong>[${i + 1}]</strong> ${src.title || src.url} — <a href="${src.url}">${src.url}</a></div>`).join('');

  // Charts (light theme for print)
  function buildChart(data) {
    const maxVal = Math.max(...data.map(d => d.value), 1);
    const labelW = 110, chartW = 220, barHeight = 22, gap = 10;
    const height = data.length * (barHeight + gap) + gap;
    const bars = data.map((d, i) => {
      const y = gap + i * (barHeight + gap);
      const barW = Math.max((d.value / maxVal) * chartW, 2);
      return `<text x="0" y="${y + barHeight / 2 + 4}" font-size="11" fill="#333">${d.label}</text>
        <rect x="${labelW}" y="${y}" width="${chartW}" height="${barHeight}" fill="#eee" rx="3"></rect>
        <rect x="${labelW}" y="${y}" width="${barW}" height="${barHeight}" fill="${d.color}" rx="3"></rect>
        <text x="${labelW + barW + 8}" y="${y + barHeight / 2 + 4}" font-size="11" font-weight="700" fill="${d.color}">${d.value}</text>`;
    }).join('');
    return `<svg viewBox="0 0 400 ${height}" width="380">${bars}</svg>`;
  }

  let chartsHtml = '';
  if (s) {
    const scopeCounts = { local: 0, international: 0 };
    (s.competitors || []).forEach(c => { if (scopeCounts[c.scope] !== undefined) scopeCounts[c.scope]++; });
    const scopeData = [{ label: 'Local', value: scopeCounts.local, color: '#10b981' }, { label: 'International', value: scopeCounts.international, color: '#d97706' }].filter(d => d.value > 0);

    const priorityCounts = { high: 0, medium: 0, low: 0 };
    (s.strategic_recommendations || []).forEach(r => { if (r.priority) priorityCounts[r.priority]++; });
    const priorityData = [{ label: 'High', value: priorityCounts.high, color: '#dc2626' }, { label: 'Medium', value: priorityCounts.medium, color: '#d97706' }, { label: 'Low', value: priorityCounts.low, color: '#6b7280' }].filter(d => d.value > 0);

    const factSourceCounts = { observed: 0, inferred: 0 };
    Object.values(facts).forEach(f => { if (f?.source_type && factSourceCounts[f.source_type] !== undefined) factSourceCounts[f.source_type]++; });
    const factData = [{ label: 'Observed', value: factSourceCounts.observed, color: '#10b981' }, { label: 'AI Inferred', value: factSourceCounts.inferred, color: '#8b5cf6' }].filter(d => d.value > 0);

    const auditCounts = { covered: 0, partial: 0, 'not covered': 0 };
    (s.audit_coverage || []).forEach(c => { if (auditCounts[c.status] !== undefined) auditCounts[c.status]++; });
    const auditData = [{ label: 'Covered', value: auditCounts.covered, color: '#10b981' }, { label: 'Partial', value: auditCounts.partial, color: '#d97706' }, { label: 'Not Covered', value: auditCounts['not covered'], color: '#6b7280' }].filter(d => d.value > 0);

    const chartBlocks = [
      factData.length ? `<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">Profile Data: Observed vs Inferred</div>${buildChart(factData)}</div>` : '',
      scopeData.length ? `<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">Competitors by Scope</div>${buildChart(scopeData)}</div>` : '',
      priorityData.length ? `<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">Recommendations by Priority</div>${buildChart(priorityData)}</div>` : '',
      auditData.length ? `<div><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:8px">Research Coverage</div>${buildChart(auditData)}</div>` : ''
    ].filter(Boolean).join('');

    if (chartBlocks) chartsHtml = `<div style="display:flex;gap:40px;flex-wrap:wrap;margin:16px 0">${chartBlocks}</div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${bizName} — Business Report</title>
<style>
body{font-family:Georgia,serif;color:#1a1a1a;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
h1{font-size:26px;border-bottom:3px solid #6C3Bff;padding-bottom:12px;margin-bottom:6px}
h2{font-size:17px;color:#6C3Bff;margin-top:32px;margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em}
.meta{color:#777;font-size:13px;margin-bottom:24px}
table{width:100%;border-collapse:collapse;font-size:13px}
tr{border-bottom:1px solid #e5e5e5}
th{text-align:left;padding:8px 12px;background:#f5f5f5;font-size:11px;text-transform:uppercase;color:#666}
p{font-size:14px}
.footer{margin-top:50px;padding-top:16px;border-top:1px solid #ddd;font-size:11px;color:#999;text-align:center}
@media print{body{margin:0}}
</style></head><body>
<h1>${bizName}</h1>
<div class="meta">Business Intelligence Report · Generated ${dateStr} · Arreyon Consult by G-DESIGNS LTD</div>
<h2>Business Profile</h2>
<table>${factsHtml || '<tr><td style="padding:8px 12px">No profile data available</td></tr>'}</table>
${s ? `
<h2>Market Context</h2><p>${s.market_context || ''}</p>
<h2>Full Detailed Analysis</h2><p>${s.full_analysis || ''}</p>
${s.local_coverage_note ? `<p style="color:#a06800"><em>Note: ${s.local_coverage_note}</em></p>` : ''}
<h2>Competitor Analysis (${scope === 'national' ? 'National' : 'National + International'})</h2>
<table><tr><th>Competitor</th><th>Offers</th><th>Edge / Weakness</th><th>Scope</th></tr>${competitorRows || '<tr><td colspan="4" style="padding:8px 12px">No competitors identified</td></tr>'}</table>
${chartsHtml}
${gapsHtml ? `<h2>What Competitors Do That You Don't</h2>${gapsHtml}` : ''}
${s.opportunity_gap ? `<h2>Opportunity Gap</h2><p>${s.opportunity_gap}</p>` : ''}
<h2>Summary &amp; Audit</h2><p>${s.audit_summary || ''}</p>
${auditRows ? `<table><tr><th>Area</th><th>Status</th><th>Note</th></tr>${auditRows}</table>` : ''}
<h2>Recommendations, Solutions &amp; Strategy</h2>
${recsHtml || '<p>No specific recommendations available.</p>'}
${v ? `<h2>Verification Pass</h2>
<p><strong>Overall Confidence:</strong> ${(v.overall_confidence||'').toUpperCase()} &nbsp;|&nbsp; <strong>Evidence Quality:</strong> ${(v.evidence_quality||'').toUpperCase()}</p>
<p><strong>Main Uncertainty:</strong> ${v.main_uncertainty || ''}</p>
<p><strong>Missing Data:</strong> ${v.data_completeness_note || ''}</p>
${(v.recommendation_checks||[]).map(c => `
<div style="border-left:3px solid ${c.verdict==='upheld'?'#10b981':c.verdict==='weakened'?'#d97706':'#dc2626'};padding:8px 12px;margin-bottom:10px">
  <strong>${c.recommendation_title||''}</strong> — ${(c.verdict||'').toUpperCase()}<br>
  <span style="font-size:12px;color:#666">Strongest objection: ${c.strongest_objection||''}</span><br>
  ${c.note||''}
</div>`).join('')}` : ''}
<h2>Sources</h2>${sourcesHtml || '<p>No sources recorded.</p>'}
` : `<p style="margin-top:30px;color:#888"><em>Market research was not run for this business. Only the website analysis profile is included above.</em></p>`}
<div class="footer">Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This report was AI-generated and should be independently verified before major business decisions.</div>
</body></html>`;
}

// ── PDF report (pdfkit — pure JS, no native/chromium dependency) ───────────
async function buildReportPDF({ business, facts, structured: s, sources, scope, verification: v }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const bizName = business.name || business.website || 'Business Report';
  const purple = '#6C3Bff';
  const MARGIN = 50;
  const WIDTH = 495;

  // Fetch chart images up front — embedding real images avoids any manual-drawing
  // alignment issues and keeps PDF/DOCX visually identical.
  const chartDatasets = buildChartDatasets({ facts, structured: s });
  const charts = await fetchAllChartImages(chartDatasets);

  // Every text call below is a single, single-style, single-line (or wrapped) call
  // at the page margin — no {continued:true} + style-switch combinations, which is
  // what caused the previous misalignment bug in pdfkit.
  function line(text, { size = 10, color = '#222', bold = false, gapAfter = 4 } = {}) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color)
      .text(text, MARGIN, doc.y, { width: WIDTH });
    doc.moveDown(gapAfter / 10);
  }
  function h2(text) {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.6);
    line(text.toUpperCase(), { size: 12.5, color: purple, bold: true, gapAfter: 3 });
  }
  function ensureSpace(minSpace) {
    if (doc.y > 792 - minSpace) doc.addPage();
  }

  // Title
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#111').text(bizName, MARGIN, MARGIN, { width: WIDTH });
  doc.moveTo(MARGIN, doc.y + 6).lineTo(MARGIN + WIDTH, doc.y + 6).strokeColor(purple).lineWidth(2).stroke();
  doc.moveDown(0.8);
  line(`Business Intelligence Report · Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult by G-DESIGNS LTD`, { size: 9, color: '#777', gapAfter: 6 });

  // Business Profile
  h2('Business Profile');
  const factEntries = Object.entries(facts).filter(([, f]) => f && f.value);
  if (factEntries.length) {
    factEntries.forEach(([key, fact]) => {
      line(`${REPORT_FACT_LABELS[key] || key}: ${fact.value} (${fact.source_type === 'observed' ? 'Observed' : 'AI Inferred'})`, { size: 9.5 });
    });
  } else {
    line('No profile data available.', { size: 9.5, color: '#888' });
  }

  if (s) {
    h2('Market Context');
    line(s.market_context || '', { size: 10 });

    h2('Full Detailed Analysis');
    line(s.full_analysis || '', { size: 10 });
    if (s.local_coverage_note) line(`Note: ${s.local_coverage_note}`, { size: 9.5, color: '#a06800' });

    h2(`Competitor Analysis (${scope === 'national' ? 'National' : 'National + International'})`);
    if (s.competitors?.length) {
      s.competitors.forEach(c => {
        ensureSpace(60);
        line(`${c.name || '—'}  [${(c.scope || 'unknown').toUpperCase()}]`, { size: 10.5, bold: true, gapAfter: 2 });
        if (c.description) line(c.description, { size: 9, color: '#444', gapAfter: 2 });
        if (c.differentiator) line(`Edge/weakness: ${c.differentiator}`, { size: 9, color: '#666', gapAfter: 5 });
      });
    } else {
      line('No competitors identified.', { size: 9.5, color: '#888' });
    }

    // Embedded chart images — real PNGs, guaranteed alignment
    for (const chart of charts) {
      ensureSpace(160);
      doc.moveDown(0.5);
      doc.image(chart.buffer, MARGIN, doc.y, { width: 300 });
      doc.moveDown(11);
    }

    if (s.competitive_gaps?.length) {
      h2("What Competitors Do That You Don't");
      s.competitive_gaps.forEach(g => {
        line(`• ${g.gap}`, { size: 9.5, gapAfter: 1 });
        if (g.competitor_names?.length) line(`   Seen at: ${g.competitor_names.join(', ')}`, { size: 8.5, color: '#888', gapAfter: 4 });
      });
    }

    if (s.opportunity_gap) {
      h2('Opportunity Gap');
      line(s.opportunity_gap, { size: 10 });
    }

    h2('Summary & Audit');
    line(s.audit_summary || '', { size: 10 });
    (s.audit_coverage || []).forEach(c => {
      line(`${c.area}: ${c.status}${c.note ? ' — ' + c.note : ''}`, { size: 9, color: '#555', gapAfter: 2 });
    });

    h2('Recommendations, Solutions & Strategy');
    if (s.strategic_recommendations?.length) {
      s.strategic_recommendations.forEach((r, i) => {
        ensureSpace(120);
        line(`${i + 1}. ${r.title || r.action || ''}${r.priority ? '   [' + r.priority.toUpperCase() + ' PRIORITY]' : ''}`, { size: 11.5, bold: true, gapAfter: 2 });
        if (r.problem_addressed) line(`Addresses: ${r.problem_addressed}`, { size: 8.5, color: '#888', gapAfter: 2 });
        line(r.solution || r.reason || '', { size: 9.5, color: '#333', gapAfter: 3 });
        (r.action_steps || []).forEach(step => line(`   •  ${step}`, { size: 9, color: '#444', gapAfter: 1 }));
        doc.moveDown(0.5);
      });
    } else {
      line('No specific recommendations available.', { size: 9.5, color: '#888' });
    }

    if (v) {
      h2('Verification Pass');
      const vColor = { high: '#10b981', medium: '#d97706', low: '#dc2626' };
      line(`Overall Confidence: ${(v.overall_confidence||'').toUpperCase()}  |  Evidence Quality: ${(v.evidence_quality||'').toUpperCase()}`, { size: 10, bold: true, color: vColor[v.overall_confidence]||'#333', gapAfter: 3 });
      line(`Main Uncertainty: ${v.main_uncertainty || ''}`, { size: 9.5, gapAfter: 2 });
      line(`Missing Data: ${v.data_completeness_note || ''}`, { size: 9.5, gapAfter: 4 });
      (v.recommendation_checks || []).forEach(c => {
        ensureSpace(60);
        line(`${c.recommendation_title || ''} — ${(c.verdict||'').toUpperCase()}`, { size: 10, bold: true, color: vColor[c.verdict==='upheld'?'high':c.verdict==='weakened'?'medium':'low']||'#333', gapAfter: 2 });
        line(`Strongest objection: ${c.strongest_objection || ''}`, { size: 8.5, color: '#888', gapAfter: 2 });
        line(c.note || '', { size: 9, color: '#444', gapAfter: 4 });
      });
    }

    h2('Sources');
    (sources || []).forEach((src, i) => {
      line(`[${i + 1}] ${src.title || src.url} — ${src.url}`, { size: 8.5, color: '#444', gapAfter: 2 });
    });
  } else {
    doc.moveDown(1);
    line('Market research was not run for this business. Only the website analysis profile is included above.', { size: 9.5, color: '#888' });
  }

  doc.moveDown(1.5);
  line('Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This report was AI-generated and should be independently verified before major business decisions.', { size: 7.5, color: '#aaa' });

  return doc;
}

// ── Word/DOCX report (docx library — real editable Word document) ──────────
async function buildReportDOCX({ business, facts, structured: s, sources, scope, verification: v }) {
  const bizName = business.name || business.website || 'Business Report';
  const purple = '6C3Bff';
  const children = [];

  children.push(new Paragraph({ text: bizName, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Business Intelligence Report · Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult by G-DESIGNS LTD`, italics: true, size: 18, color: '777777' })]
  }));
  children.push(new Paragraph({ text: '' }));

  function heading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 })); }
  function subheading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2 })); }
  function para(text) { children.push(new Paragraph({ text: text || '', spacing: { after: 150 } })); }
  function bullet(text) { children.push(new Paragraph({ text, bullet: { level: 0 } })); }

  heading('Business Profile');
  const factRows = Object.entries(facts).filter(([, f]) => f && f.value).map(([key, fact]) => new TableRow({
    children: [
      new TableCell({ width: { size: 25, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: REPORT_FACT_LABELS[key] || key, bold: true })] }),
      new TableCell({ width: { size: 75, type: WidthType.PERCENTAGE }, children: [new Paragraph({ text: `${fact.value} (${fact.source_type === 'observed' ? 'Observed' : 'AI Inferred'})` })] })
    ]
  }));
  if (factRows.length) {
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: factRows }));
  } else {
    para('No profile data available.');
  }
  children.push(new Paragraph({ text: '' }));

  if (s) {
    heading('Market Context');
    para(s.market_context);

    heading('Full Detailed Analysis');
    para(s.full_analysis);
    if (s.local_coverage_note) para(`Note: ${s.local_coverage_note}`);

    heading(`Competitor Analysis (${scope === 'national' ? 'National' : 'National + International'})`);
    if (s.competitors?.length) {
      const compHeaderRow = new TableRow({
        children: ['Competitor', 'Offers', 'Edge / Weakness', 'Scope'].map(t =>
          new TableCell({ children: [new Paragraph({ text: t, bold: true })] }))
      });
      const compRows = s.competitors.map(c => new TableRow({
        children: [
          new TableCell({ children: [new Paragraph({ text: c.name || '—' })] }),
          new TableCell({ children: [new Paragraph({ text: c.description || '—' })] }),
          new TableCell({ children: [new Paragraph({ text: c.differentiator || '—' })] }),
          new TableCell({ children: [new Paragraph({ text: c.scope || 'unknown' })] })
        ]
      }));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [compHeaderRow, ...compRows] }));
    } else {
      para('No competitors identified.');
    }
    children.push(new Paragraph({ text: '' }));

    // Embedded chart images — same PNGs used in the PDF, fetched once and reused
    const chartDatasets = buildChartDatasets({ facts, structured: s });
    const charts = await fetchAllChartImages(chartDatasets);
    if (charts.length) {
      heading('Data Analysis');
      charts.forEach(chart => {
        children.push(new Paragraph({ children: [new ImageRun({ data: chart.buffer, transformation: { width: 380, height: 80 + chart.labels.length * 40 } })] }));
        children.push(new Paragraph({ text: '' }));
      });
    }

    if (s.competitive_gaps?.length) {
      heading("What Competitors Do That You Don't");
      s.competitive_gaps.forEach(g => {
        bullet(`${g.gap}${g.competitor_names?.length ? ' (seen at: ' + g.competitor_names.join(', ') + ')' : ''}`);
      });
      children.push(new Paragraph({ text: '' }));
    }

    if (s.opportunity_gap) { heading('Opportunity Gap'); para(s.opportunity_gap); }

    heading('Summary & Audit');
    para(s.audit_summary);
    (s.audit_coverage || []).forEach(c => bullet(`${c.area}: ${c.status}${c.note ? ' — ' + c.note : ''}`));
    children.push(new Paragraph({ text: '' }));

    heading('Recommendations, Solutions & Strategy');
    (s.strategic_recommendations || []).forEach((r, i) => {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: `${i + 1}. ${r.title || r.action || ''}` }), r.priority ? new TextRun({ text: `  [${r.priority.toUpperCase()} PRIORITY]`, size: 16, color: '888888' }) : new TextRun('')]
      }));
      if (r.problem_addressed) children.push(new Paragraph({ children: [new TextRun({ text: `Addresses: ${r.problem_addressed}`, italics: true, size: 18 })] }));
      para(r.solution || r.reason);
      (r.action_steps || []).forEach(step => bullet(step));
      children.push(new Paragraph({ text: '' }));
    });
    if (!s.strategic_recommendations?.length) para('No specific recommendations available.');

    if (v) {
      heading('Verification Pass');
      para(`Overall Confidence: ${(v.overall_confidence||'').toUpperCase()} | Evidence Quality: ${(v.evidence_quality||'').toUpperCase()}`);
      para(`Main Uncertainty: ${v.main_uncertainty || ''}`);
      para(`Missing Data: ${v.data_completeness_note || ''}`);
      (v.recommendation_checks || []).forEach(c => {
        subheading(`${c.recommendation_title || ''} — ${(c.verdict||'').toUpperCase()}`);
        para(`Strongest objection: ${c.strongest_objection || ''}`);
        para(c.note || '');
      });
    }

    heading('Sources');
    (sources || []).forEach((src, i) => para(`[${i + 1}] ${src.title || src.url} — ${src.url}`));
  } else {
    para('Market research was not run for this business. Only the website analysis profile is included above.');
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This report was AI-generated and should be independently verified before major business decisions.', size: 15, color: 'AAAAAA', italics: true })],
    alignment: AlignmentType.CENTER
  }));

  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Report download endpoint — supports html, pdf, docx ─────────────────────
app.get('/api/business/:id/report', authRequired, async (req, res) => {
  const format = (req.query.format || 'html').toLowerCase();
  if (!['html', 'pdf', 'docx'].includes(format)) return res.status(400).json({ error: 'Invalid format. Use html, pdf, or docx.' });
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';

  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];

    const factsResult = await pool.query(
      `SELECT DISTINCT ON (fact_key) id, fact_key, fact_value, fact_value_fr, source_type FROM business_facts
       WHERE business_id = $1 ORDER BY fact_key, created_at DESC`,
      [req.params.id]
    );

    if (lang === 'fr') {
      const missing = factsResult.rows.filter(f => f.fact_value && !f.fact_value_fr);
      if (missing.length) {
        try {
          const toTranslate = Object.fromEntries(missing.map(f => [f.fact_key, f.fact_value]));
          const translated = await translateBusinessFacts(toTranslate);
          for (const f of missing) {
            const frValue = translated[f.fact_key];
            if (frValue) {
              await pool.query('UPDATE business_facts SET fact_value_fr = $1 WHERE id = $2', [frValue, f.id]);
              f.fact_value_fr = frValue;
            }
          }
        } catch (e) { console.error('Report facts auto-translate failed (non-fatal, falling back to English):', e.message); }
      }
    }
    const facts = {};
    factsResult.rows.forEach(r => { facts[r.fact_key] = { value: (lang === 'fr' && r.fact_value_fr) ? r.fact_value_fr : r.fact_value, source_type: r.source_type }; });

    const sessionResult = await pool.query(
      'SELECT * FROM research_sessions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );
    let structured = null, sources = [], scope = 'both', verification = null;
    if (sessionResult.rows.length) {
      const session = sessionResult.rows[0];
      scope = session.scope || 'both';

      if (lang === 'fr') {
        try {
          if (session.structured_data && !session.structured_data_fr) {
            const translated = await translateStructuredContent(session.structured_data, 'market research report');
            await pool.query('UPDATE research_sessions SET structured_data_fr = $1 WHERE id = $2', [JSON.stringify(translated), session.id]);
            session.structured_data_fr = translated;
          }
          if (session.verification_data && !session.verification_data_fr) {
            const translatedV = await translateStructuredContent(session.verification_data, 'verification report');
            await pool.query('UPDATE research_sessions SET verification_data_fr = $1 WHERE id = $2', [JSON.stringify(translatedV), session.id]);
            session.verification_data_fr = translatedV;
          }
        } catch (e) { console.error('Report research auto-translate failed (non-fatal, falling back to English):', e.message); }
      }
      structured = (lang === 'fr' && session.structured_data_fr) ? session.structured_data_fr : (session.structured_data || null);
      verification = (lang === 'fr' && session.verification_data_fr) ? session.verification_data_fr : (session.verification_data || null);

      const sourcesResult = await pool.query('SELECT * FROM research_sources WHERE research_session_id = $1', [session.id]);
      sources = sourcesResult.rows;
    }

    const reportData = { business, facts, structured, sources, scope, verification };
    const filename = sanitizeFilename(business.name || business.website);

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}-report.html"`);
      return res.send(buildReportHTML(reportData));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}-report.pdf"`);
      const doc = await buildReportPDF(reportData);
      doc.pipe(res);
      doc.end();
      return;
    }
    if (format === 'docx') {
      const buffer = await buildReportDOCX(reportData);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}-report.docx"`);
      return res.send(buffer);
    }
  } catch (err) {
    console.error('Report generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate report. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENTREPRENEUR MODE REPORT — downloadable HTML/PDF/DOCX for opportunity
// searches, idea validations, and generated business plans
// ═══════════════════════════════════════════════════════════════════════════

function planSectionText(plan) {
  if (!plan) return null;
  const bm = plan.business_model || {}, st = plan.strategy || {}, mk = plan.marketing_plan || {}, ex = plan.execution_plan || {}, fin = plan.financial_snapshot || {};
  return { bm, st, mk, ex, fin };
}

function buildEntrepreneurReportHTML(session) {
  const isOpp = session.mode === 'opportunity_finder';
  const dateStr = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const title = isOpp ? 'Business Opportunity Report' : 'Business Idea Validation Report';
  const s = session.structured_output || {};

  const inputRows = Object.entries(session.input_data || {}).filter(([,v]) => v).map(([k,v]) =>
    `<tr><td style="padding:6px 12px;font-weight:600;width:160px">${k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}</td><td style="padding:6px 12px">${v}</td></tr>`
  ).join('');

  let bodyHtml = '';
  if (isOpp) {
    const oppRows = (s.opportunities || []).map(o => `
      <div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px;margin-bottom:12px;page-break-inside:avoid">
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">${o.name}</div>
        <div style="font-size:13px;margin-bottom:6px">${o.description || ''}</div>
        <div style="font-size:12.5px;color:#666;font-style:italic;margin-bottom:8px">Why it fits: ${o.why_it_fits || ''}</div>
        <table style="width:100%;font-size:11.5px"><tr>
          <td>Demand: <strong>${o.demand||'—'}</strong></td><td>Competition: <strong>${o.competition||'—'}</strong></td><td>Margin: <strong>${o.potential_margin||'—'}</strong></td>
        </tr><tr>
          <td>Acquisition: <strong>${o.customer_acquisition_difficulty||'—'}</strong></td><td>Scalability: <strong>${o.scalability||'—'}</strong></td><td>Risk: <strong>${o.risk||'—'}</strong></td>
        </tr></table>
        <div style="font-size:12px;margin-top:6px">Startup cost: ${o.startup_cost_estimate||'—'} · Time to revenue: ${o.time_to_first_revenue||'—'}</div>
      </div>`).join('');
    bodyHtml = `<h2>Opportunities Found</h2>${oppRows}
      <h2>Where to Start</h2><p>${s.overall_recommendation || ''}</p>
      ${s.what_to_learn_first ? `<p><em>First, learn: ${s.what_to_learn_first}</em></p>` : ''}`;
  } else {
    const verdictColor = { validate: '#10b981', modify: '#d97706', reconsider: '#dc2626' }[s.verdict] || '#666';
    bodyHtml = `
      <div style="border:2px solid ${verdictColor};border-radius:10px;padding:16px;text-align:center;margin-bottom:20px">
        <div style="font-size:20px;font-weight:800;color:${verdictColor}">${(s.verdict||'').toUpperCase()}</div>
        <div style="font-size:13px;margin-top:6px">${s.verdict_reasoning || ''}</div>
      </div>
      <h2>Assessment</h2>
      <p><strong>Problem Addressed:</strong> ${s.problem_addressed || ''}</p>
      <p><strong>Target Customer:</strong> ${s.target_customer || ''}</p>
      <p><strong>Demand Assessment:</strong> ${s.demand_assessment || ''}</p>
      <p><strong>Existing Alternatives:</strong> ${(s.existing_alternatives||[]).join(', ')}</p>
      <p><strong>Competition Level:</strong> ${s.competition_level || ''}</p>
      <p><strong>Suggested Pricing:</strong> ${s.suggested_pricing || ''}</p>
      <p><strong>Startup Requirements:</strong> ${s.startup_requirements || ''}</p>
      <p><strong>Unit Economics:</strong> ${s.unit_economics_note || ''}</p>
      <p><strong>Distribution Channels:</strong> ${s.distribution_channels || ''}</p>
      <p><strong>Customer Acquisition:</strong> ${s.customer_acquisition_strategy || ''}</p>
      <p><strong>Differentiation Opportunity:</strong> ${s.differentiation_opportunity || ''}</p>
      <p><strong>Scalability:</strong> ${s.scalability_note || ''}</p>
      ${(s.risks||[]).length ? `<p><strong>Risks:</strong></p><ul>${s.risks.map(r=>`<li>${r}</li>`).join('')}</ul>` : ''}`;
  }

  const p = planSectionText(session.business_plan);
  const planHtml = p ? `
    <h2>Business Plan</h2>
    <h3 style="color:#6C3Bff;font-size:14px">Business Model</h3>
    <p><strong>Value Proposition:</strong> ${p.bm.value_proposition||''}<br><strong>Customer Segments:</strong> ${p.bm.customer_segments||''}</p>
    <p><strong>Revenue Streams:</strong> ${(p.bm.revenue_streams||[]).join(', ')}<br><strong>Cost Structure:</strong> ${(p.bm.cost_structure||[]).join(', ')}</p>
    <h3 style="color:#6C3Bff;font-size:14px">Strategy</h3>
    <p><strong>Positioning:</strong> ${p.st.positioning||''}<br><strong>Competitive Advantage:</strong> ${p.st.competitive_advantage||''}<br><strong>Differentiation:</strong> ${p.st.differentiation||''}</p>
    <h3 style="color:#6C3Bff;font-size:14px">Marketing Plan</h3>
    <p><strong>Target Audience:</strong> ${p.mk.target_audience||''}<br><strong>Key Messaging:</strong> ${p.mk.key_messaging||''}</p>
    <p><strong>Channels:</strong> ${(p.mk.marketing_channels||[]).join(', ')}<br><strong>Content Strategy:</strong> ${p.mk.content_strategy||''}</p>
    <p><strong>Promotional Tactics:</strong> ${(p.mk.promotional_tactics||[]).join(', ')}<br><strong>Acquisition Funnel:</strong> ${p.mk.customer_acquisition_funnel||''}</p>
    <p><strong>Marketing Budget:</strong> ${p.mk.marketing_budget_estimate||''}</p>
    <h3 style="color:#6C3Bff;font-size:14px">Execution Plan</h3>
    <p><strong>First 30 Days:</strong></p><ul>${(p.ex.phase_30_days||[]).map(t=>`<li>${t}</li>`).join('')}</ul>
    <p><strong>Days 31-60:</strong></p><ul>${(p.ex.phase_60_days||[]).map(t=>`<li>${t}</li>`).join('')}</ul>
    <p><strong>Days 61-90:</strong></p><ul>${(p.ex.phase_90_days||[]).map(t=>`<li>${t}</li>`).join('')}</ul>
    <h3 style="color:#6C3Bff;font-size:14px">Financial Snapshot</h3>
    <p><strong>Startup Cost:</strong> ${p.fin.estimated_startup_cost||''}<br><strong>Monthly Operating Cost:</strong> ${p.fin.monthly_operating_cost||''}</p>
    <p><strong>Breakeven Estimate:</strong> ${p.fin.breakeven_estimate||''}<br><strong>Key Assumption:</strong> ${p.fin.key_assumption||''}</p>` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>
body{font-family:Georgia,serif;color:#1a1a1a;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6}
h1{font-size:24px;border-bottom:3px solid #6C3Bff;padding-bottom:10px}
h2{font-size:16px;color:#6C3Bff;margin-top:26px;text-transform:uppercase;letter-spacing:.04em}
.meta{color:#777;font-size:13px;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:13px}
p{font-size:13.5px}
.footer{margin-top:40px;padding-top:14px;border-top:1px solid #ddd;font-size:11px;color:#999;text-align:center}
</style></head><body>
<h1>${title}</h1>
<div class="meta">Generated ${dateStr} · Arreyon Consult by G-DESIGNS LTD ${session.research_backed ? '· Research-backed' : '· AI estimate only, not research-backed'}</div>
<h2>Your Circumstances</h2><table>${inputRows}</table>
${bodyHtml}
${planHtml}
<div class="footer">Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · AI-generated — independently verify before major decisions.</div>
</body></html>`;
}

async function buildEntrepreneurReportPDF(session) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const isOpp = session.mode === 'opportunity_finder';
  const purple = '#6C3Bff';
  const MARGIN = 50, WIDTH = 495;
  const s = session.structured_output || {};

  function line(text, { size = 10, color = '#222', bold = false, gapAfter = 4 } = {}) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color).text(text, MARGIN, doc.y, { width: WIDTH });
    doc.moveDown(gapAfter / 10);
  }
  function h2(text) {
    if (doc.y > 700) doc.addPage();
    doc.moveDown(0.6);
    line(text.toUpperCase(), { size: 12.5, color: purple, bold: true, gapAfter: 3 });
  }
  function ensureSpace(min) { if (doc.y > 792 - min) doc.addPage(); }

  const title = isOpp ? 'Business Opportunity Report' : 'Business Idea Validation Report';
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(title, MARGIN, MARGIN, { width: WIDTH });
  doc.moveTo(MARGIN, doc.y + 6).lineTo(MARGIN + WIDTH, doc.y + 6).strokeColor(purple).lineWidth(2).stroke();
  doc.moveDown(0.8);
  line(`Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult · ${session.research_backed ? 'Research-backed' : 'AI estimate only'}`, { size: 9, color: '#777', gapAfter: 6 });

  h2('Your Circumstances');
  Object.entries(session.input_data || {}).filter(([,v]) => v).forEach(([k,v]) => {
    line(`${k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}: ${v}`, { size: 9.5 });
  });

  if (isOpp) {
    h2('Opportunities Found');
    (s.opportunities || []).forEach(o => {
      ensureSpace(90);
      line(o.name, { size: 12, bold: true, gapAfter: 2 });
      line(o.description || '', { size: 9.5, color: '#444', gapAfter: 2 });
      line(`Why it fits: ${o.why_it_fits || ''}`, { size: 9, color: '#666', gapAfter: 2 });
      line(`Demand: ${o.demand||'—'}  |  Competition: ${o.competition||'—'}  |  Margin: ${o.potential_margin||'—'}  |  Risk: ${o.risk||'—'}`, { size: 9, gapAfter: 2 });
      line(`Startup cost: ${o.startup_cost_estimate||'—'}  |  Time to revenue: ${o.time_to_first_revenue||'—'}`, { size: 9, color: '#666', gapAfter: 6 });
    });
    h2('Where to Start');
    line(s.overall_recommendation || '', { size: 10 });
    if (s.what_to_learn_first) line(`First, learn: ${s.what_to_learn_first}`, { size: 9.5, color: '#666' });
  } else {
    h2('Verdict');
    const verdictColor = { validate: '#10b981', modify: '#d97706', reconsider: '#dc2626' }[s.verdict] || '#666';
    line((s.verdict || '').toUpperCase(), { size: 16, bold: true, color: verdictColor, gapAfter: 3 });
    line(s.verdict_reasoning || '', { size: 10, gapAfter: 6 });

    h2('Assessment');
    const rows = [['Problem Addressed', s.problem_addressed], ['Target Customer', s.target_customer], ['Demand Assessment', s.demand_assessment],
      ['Existing Alternatives', (s.existing_alternatives||[]).join(', ')], ['Competition Level', s.competition_level], ['Suggested Pricing', s.suggested_pricing],
      ['Startup Requirements', s.startup_requirements], ['Unit Economics', s.unit_economics_note], ['Distribution Channels', s.distribution_channels],
      ['Customer Acquisition', s.customer_acquisition_strategy], ['Differentiation', s.differentiation_opportunity], ['Scalability', s.scalability_note]].filter(([,v])=>v);
    rows.forEach(([label, val]) => { ensureSpace(30); line(`${label}: ${val}`, { size: 9.5, gapAfter: 3 }); });
    if (s.risks?.length) { h2('Risks'); s.risks.forEach(r => line(`• ${r}`, { size: 9.5, color: '#a00', gapAfter: 2 })); }
  }

  const p = planSectionText(session.business_plan);
  if (p) {
    h2('Business Plan — Business Model');
    line(`Value Proposition: ${p.bm.value_proposition||''}`, { size: 9.5, gapAfter: 2 });
    line(`Customer Segments: ${p.bm.customer_segments||''}`, { size: 9.5, gapAfter: 2 });
    line(`Revenue Streams: ${(p.bm.revenue_streams||[]).join(', ')}`, { size: 9.5, gapAfter: 2 });
    line(`Cost Structure: ${(p.bm.cost_structure||[]).join(', ')}`, { size: 9.5, gapAfter: 6 });

    h2('Strategy');
    line(`Positioning: ${p.st.positioning||''}`, { size: 9.5, gapAfter: 2 });
    line(`Competitive Advantage: ${p.st.competitive_advantage||''}`, { size: 9.5, gapAfter: 2 });
    line(`Differentiation: ${p.st.differentiation||''}`, { size: 9.5, gapAfter: 6 });

    h2('Marketing Plan');
    line(`Target Audience: ${p.mk.target_audience||''}`, { size: 9.5, gapAfter: 2 });
    line(`Key Messaging: ${p.mk.key_messaging||''}`, { size: 9.5, gapAfter: 2 });
    line(`Channels: ${(p.mk.marketing_channels||[]).join(', ')}`, { size: 9.5, gapAfter: 2 });
    line(`Content Strategy: ${p.mk.content_strategy||''}`, { size: 9.5, gapAfter: 2 });
    line(`Promotional Tactics: ${(p.mk.promotional_tactics||[]).join(', ')}`, { size: 9.5, gapAfter: 2 });
    line(`Acquisition Funnel: ${p.mk.customer_acquisition_funnel||''}`, { size: 9.5, gapAfter: 2 });
    line(`Marketing Budget: ${p.mk.marketing_budget_estimate||''}`, { size: 9.5, gapAfter: 6 });

    h2('Execution Plan');
    line('First 30 Days:', { size: 9.5, bold: true, gapAfter: 1 });
    (p.ex.phase_30_days||[]).forEach(t => line(`  • ${t}`, { size: 9, gapAfter: 1 }));
    line('Days 31-60:', { size: 9.5, bold: true, gapAfter: 1 });
    (p.ex.phase_60_days||[]).forEach(t => line(`  • ${t}`, { size: 9, gapAfter: 1 }));
    line('Days 61-90:', { size: 9.5, bold: true, gapAfter: 1 });
    (p.ex.phase_90_days||[]).forEach(t => line(`  • ${t}`, { size: 9, gapAfter: 1 }));
    doc.moveDown(0.4);

    h2('Financial Snapshot');
    line(`Startup Cost: ${p.fin.estimated_startup_cost||''}`, { size: 9.5, gapAfter: 2 });
    line(`Monthly Operating Cost: ${p.fin.monthly_operating_cost||''}`, { size: 9.5, gapAfter: 2 });
    line(`Breakeven Estimate: ${p.fin.breakeven_estimate||''}`, { size: 9.5, gapAfter: 2 });
    line(`Key Assumption: ${p.fin.key_assumption||''}`, { size: 9.5, gapAfter: 2 });
  }

  doc.moveDown(1.5);
  line('Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · AI-generated — independently verify before major decisions.', { size: 7.5, color: '#aaa' });

  return doc;
}

async function buildEntrepreneurReportDOCX(session) {
  const isOpp = session.mode === 'opportunity_finder';
  const s = session.structured_output || {};
  const children = [];

  const title = isOpp ? 'Business Opportunity Report' : 'Business Idea Validation Report';
  children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({ children: [new TextRun({ text: `Generated ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})} · Arreyon Consult · ${session.research_backed ? 'Research-backed' : 'AI estimate only'}`, italics: true, size: 18, color: '777777' })] }));
  children.push(new Paragraph({ text: '' }));

  function heading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 })); }
  function subheading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_2 })); }
  function para(text) { children.push(new Paragraph({ text: text || '', spacing: { after: 120 } })); }
  function bullet(text) { children.push(new Paragraph({ text, bullet: { level: 0 } })); }

  heading('Your Circumstances');
  Object.entries(session.input_data || {}).filter(([,v]) => v).forEach(([k,v]) => {
    para(`${k.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())}: ${v}`);
  });

  if (isOpp) {
    heading('Opportunities Found');
    (s.opportunities || []).forEach(o => {
      subheading(o.name);
      para(o.description);
      para(`Why it fits: ${o.why_it_fits || ''}`);
      para(`Demand: ${o.demand||'—'} | Competition: ${o.competition||'—'} | Margin: ${o.potential_margin||'—'} | Risk: ${o.risk||'—'}`);
      para(`Startup cost: ${o.startup_cost_estimate||'—'} | Time to revenue: ${o.time_to_first_revenue||'—'}`);
    });
    heading('Where to Start');
    para(s.overall_recommendation);
    if (s.what_to_learn_first) para(`First, learn: ${s.what_to_learn_first}`);
  } else {
    heading('Verdict');
    children.push(new Paragraph({ children: [new TextRun({ text: (s.verdict||'').toUpperCase(), bold: true, size: 28 })] }));
    para(s.verdict_reasoning);

    heading('Assessment');
    const rows = [['Problem Addressed', s.problem_addressed], ['Target Customer', s.target_customer], ['Demand Assessment', s.demand_assessment],
      ['Existing Alternatives', (s.existing_alternatives||[]).join(', ')], ['Competition Level', s.competition_level], ['Suggested Pricing', s.suggested_pricing],
      ['Startup Requirements', s.startup_requirements], ['Unit Economics', s.unit_economics_note], ['Distribution Channels', s.distribution_channels],
      ['Customer Acquisition', s.customer_acquisition_strategy], ['Differentiation', s.differentiation_opportunity], ['Scalability', s.scalability_note]].filter(([,v])=>v);
    rows.forEach(([label, val]) => para(`${label}: ${val}`));
    if (s.risks?.length) { subheading('Risks'); s.risks.forEach(r => bullet(r)); }
  }

  const p = planSectionText(session.business_plan);
  if (p) {
    heading('Business Plan');
    subheading('Business Model');
    para(`Value Proposition: ${p.bm.value_proposition||''}`);
    para(`Customer Segments: ${p.bm.customer_segments||''}`);
    para(`Revenue Streams: ${(p.bm.revenue_streams||[]).join(', ')}`);
    para(`Cost Structure: ${(p.bm.cost_structure||[]).join(', ')}`);

    subheading('Strategy');
    para(`Positioning: ${p.st.positioning||''}`);
    para(`Competitive Advantage: ${p.st.competitive_advantage||''}`);
    para(`Differentiation: ${p.st.differentiation||''}`);

    subheading('Marketing Plan');
    para(`Target Audience: ${p.mk.target_audience||''}`);
    para(`Key Messaging: ${p.mk.key_messaging||''}`);
    para(`Channels: ${(p.mk.marketing_channels||[]).join(', ')}`);
    para(`Content Strategy: ${p.mk.content_strategy||''}`);
    para(`Promotional Tactics: ${(p.mk.promotional_tactics||[]).join(', ')}`);
    para(`Acquisition Funnel: ${p.mk.customer_acquisition_funnel||''}`);
    para(`Marketing Budget: ${p.mk.marketing_budget_estimate||''}`);

    subheading('Execution Plan');
    para('First 30 Days:'); (p.ex.phase_30_days||[]).forEach(t => bullet(t));
    para('Days 31-60:'); (p.ex.phase_60_days||[]).forEach(t => bullet(t));
    para('Days 61-90:'); (p.ex.phase_90_days||[]).forEach(t => bullet(t));

    subheading('Financial Snapshot');
    para(`Startup Cost: ${p.fin.estimated_startup_cost||''}`);
    para(`Monthly Operating Cost: ${p.fin.monthly_operating_cost||''}`);
    para(`Breakeven Estimate: ${p.fin.breakeven_estimate||''}`);
    para(`Key Assumption: ${p.fin.key_assumption||''}`);
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · AI-generated — independently verify before major decisions.', size: 15, color: 'AAAAAA', italics: true })],
    alignment: AlignmentType.CENTER
  }));

  const doc = new DocxDocument({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ── Entrepreneur Mode report download endpoint ──────────────────────────────
app.get('/api/entrepreneur/:sessionId/report', authRequired, async (req, res) => {
  const format = (req.query.format || 'html').toLowerCase();
  if (!['html', 'pdf', 'docx'].includes(format)) return res.status(400).json({ error: 'Invalid format. Use html, pdf, or docx.' });
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';

  try {
    const result = await pool.query('SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2', [req.params.sessionId, req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = result.rows[0];

    if (lang === 'fr') {
      try {
        if (session.structured_output && !session.structured_output_fr) {
          const translated = await translateStructuredContent(session.structured_output, session.mode === 'opportunity_finder' ? 'business opportunity report' : 'business idea validation report');
          await pool.query('UPDATE entrepreneur_sessions SET structured_output_fr = $1 WHERE id = $2', [JSON.stringify(translated), session.id]);
          session.structured_output_fr = translated;
        }
        if (session.business_plan && !session.business_plan_fr) {
          // computed_financials is language-neutral numeric data, not narrative
          // text — strip it before sending to AI translation (an atypical
          // numeric-only object risks being silently dropped or altered by
          // the translation pass) and re-attach it unchanged afterward.
          const { computed_financials, ...planForTranslation } = session.business_plan;
          const translatedPlan = await translateStructuredContent(planForTranslation, 'business plan');
          if (computed_financials) translatedPlan.computed_financials = computed_financials;
          await pool.query('UPDATE entrepreneur_sessions SET business_plan_fr = $1 WHERE id = $2', [JSON.stringify(translatedPlan), session.id]);
          session.business_plan_fr = translatedPlan;
        }
      } catch (e) { console.error('Entrepreneur report auto-translate failed (non-fatal, falling back to English):', e.message); }
      if (session.structured_output_fr) session.structured_output = session.structured_output_fr;
      if (session.business_plan_fr) session.business_plan = session.business_plan_fr;
    }

    const filename = sanitizeFilename(session.mode === 'opportunity_finder' ? 'opportunity-report' : (session.input_data?.idea || 'idea-validation'));

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.html"`);
      return res.send(buildEntrepreneurReportHTML(session));
    }
    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
      const doc = await buildEntrepreneurReportPDF(session);
      doc.pipe(res);
      doc.end();
      return;
    }
    if (format === 'docx') {
      const buffer = await buildEntrepreneurReportDOCX(session);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
      return res.send(buffer);
    }
  } catch (err) {
    console.error('Entrepreneur report generation error:', err.message);
    res.status(500).json({ error: 'Failed to generate report. Please try again.' });
  }
});

// ── Get one business profile with its current facts (latest value per key) ──
app.get('/api/business/:id', authRequired, async (req, res) => {
  const lang = req.query.lang === 'fr' ? 'fr' : 'en';
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query(
      'SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]
    );
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    // Latest fact per key — DISTINCT ON gives current state; full history stays in the table
    const facts = await pool.query(
      `SELECT DISTINCT ON (fact_key) id, fact_key, fact_value, fact_value_fr, source_type, source_detail, created_at
       FROM business_facts WHERE business_id = $1
       ORDER BY fact_key, created_at DESC`,
      [req.params.id]
    );

    if (lang === 'fr') {
      const missing = facts.rows.filter(f => f.fact_value && !f.fact_value_fr);
      if (missing.length) {
        try {
          const toTranslate = Object.fromEntries(missing.map(f => [f.fact_key, f.fact_value]));
          const translated = await translateBusinessFacts(toTranslate);
          for (const f of missing) {
            const frValue = translated[f.fact_key];
            if (frValue) {
              await pool.query('UPDATE business_facts SET fact_value_fr = $1 WHERE id = $2', [frValue, f.id]);
              f.fact_value_fr = frValue;
            }
          }
        } catch (e) {
          console.error('Business facts auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      facts.rows.forEach(f => { if (f.fact_value_fr) f.fact_value = f.fact_value_fr; });

      // Same discipline for the Business Intelligence snapshot (Phase 2) —
      // translate it ONCE on first French view and cache the result, rather
      // than silently showing stale English or requiring the user to click
      // Regenerate (which would burn a full fresh AI analysis call just to
      // get a different language, and could even produce a DIFFERENT
      // analysis than the English version, since it's not a translation at
      // that point — it's a brand new one).
      const business = biz.rows[0];
      if (business.intelligence_snapshot && !business.intelligence_snapshot_fr) {
        try {
          const translatedIntelligence = await translateStructuredContent(business.intelligence_snapshot, 'business intelligence analysis');
          await pool.query('UPDATE businesses SET intelligence_snapshot_fr = $1 WHERE id = $2', [JSON.stringify(translatedIntelligence), business.id]);
          business.intelligence_snapshot_fr = translatedIntelligence;
        } catch (e) {
          console.error('Business intelligence auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.intelligence_snapshot_fr) business.intelligence_snapshot = business.intelligence_snapshot_fr;

      // Same discipline for Business X-Ray (Phase 2 completion).
      if (business.business_xray && !business.business_xray_fr) {
        try {
          const translatedXray = await translateStructuredContent(business.business_xray, 'Business X-Ray diagnostic');
          await pool.query('UPDATE businesses SET business_xray_fr = $1 WHERE id = $2', [JSON.stringify(translatedXray), business.id]);
          business.business_xray_fr = translatedXray;
        } catch (e) {
          console.error('Business X-Ray auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.business_xray_fr) business.business_xray = business.business_xray_fr;

      // Same discipline for Market Context (Phase 5, Step 2).
      if (business.market_context && !business.market_context_fr) {
        try {
          const translatedContext = await translateStructuredContent(business.market_context, 'market context analysis');
          await pool.query('UPDATE businesses SET market_context_fr = $1 WHERE id = $2', [JSON.stringify(translatedContext), business.id]);
          business.market_context_fr = translatedContext;
        } catch (e) {
          console.error('Market context auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.market_context_fr) business.market_context = business.market_context_fr;

      // Same discipline for Marketing Strategy (Phase 7, Step 1).
      if (business.marketing_strategy && !business.marketing_strategy_fr) {
        try {
          const translatedStrategy = await translateStructuredContent(business.marketing_strategy, 'marketing strategy');
          await pool.query('UPDATE businesses SET marketing_strategy_fr = $1 WHERE id = $2', [JSON.stringify(translatedStrategy), business.id]);
          business.marketing_strategy_fr = translatedStrategy;
        } catch (e) {
          console.error('Marketing strategy auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.marketing_strategy_fr) business.marketing_strategy = business.marketing_strategy_fr;

      // Same discipline for Content Calendar (Phase 7, Step 2).
      if (business.content_calendar && !business.content_calendar_fr) {
        try {
          const translatedCalendar = await translateStructuredContent(business.content_calendar, 'content calendar');
          await pool.query('UPDATE businesses SET content_calendar_fr = $1 WHERE id = $2', [JSON.stringify(translatedCalendar), business.id]);
          business.content_calendar_fr = translatedCalendar;
        } catch (e) {
          console.error('Content calendar auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.content_calendar_fr) business.content_calendar = business.content_calendar_fr;

      // Same discipline for Funding Readiness (Phase 8, Step 2) — score and
      // breakdown are deterministic and use stable keys (e.g.
      // "has_business_plan") for the frontend to look up and translate via
      // its own i18n system, not natural-language text. Stripped before
      // translation and reattached unchanged, so a translation pass can
      // never risk mangling a key the frontend depends on matching exactly.
      if (business.funding_readiness && !business.funding_readiness_fr) {
        try {
          const { score, breakdown, ...readinessForTranslation } = business.funding_readiness;
          const translatedReadiness = await translateStructuredContent(readinessForTranslation, 'funding readiness assessment');
          translatedReadiness.score = score;
          translatedReadiness.breakdown = breakdown;
          await pool.query('UPDATE businesses SET funding_readiness_fr = $1 WHERE id = $2', [JSON.stringify(translatedReadiness), business.id]);
          business.funding_readiness_fr = translatedReadiness;
        } catch (e) {
          console.error('Funding readiness auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.funding_readiness_fr) business.funding_readiness = business.funding_readiness_fr;

      // Same discipline for Pitch Deck (Phase 8, Step 3).
      if (business.pitch_deck && !business.pitch_deck_fr) {
        try {
          const translatedDeck = await translateStructuredContent(business.pitch_deck, 'investor pitch deck outline');
          await pool.query('UPDATE businesses SET pitch_deck_fr = $1 WHERE id = $2', [JSON.stringify(translatedDeck), business.id]);
          business.pitch_deck_fr = translatedDeck;
        } catch (e) {
          console.error('Pitch deck auto-translate failed (non-fatal, falling back to English):', e.message);
        }
      }
      if (business.pitch_deck_fr) business.pitch_deck = business.pitch_deck_fr;
    }

    res.json({ business: biz.rows[0], facts: facts.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load business' }); }
});

// ── Business Memory — let the user directly correct or add a fact ──────────
// Per Section 11 of the spec: distinguish user-provided facts from AI-derived
// ones. An edit here is tagged "user_provided" since the founder themself is
// now the source, not an AI inference or a website scrape.
app.put('/api/business/:id/facts/:factKey', authRequired, async (req, res) => {
  const { value } = req.body;
  if (!value || !value.trim()) return res.status(400).json({ error: 'Value is required' });

  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    await pool.query(
      `INSERT INTO business_facts (business_id, fact_key, fact_value, source_type, source_detail)
       VALUES ($1, $2, $3, 'user_provided', 'Manually edited by founder')`,
      [req.params.id, req.params.factKey, value.trim()]
    );
    await pool.query('UPDATE businesses SET updated_at = NOW() WHERE id = $1', [req.params.id]);

    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update fact' }); }
});

// ── Business Memory — see how a specific fact has changed over time ────────
app.get('/api/business/:id/facts/:factKey/history', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, account.id]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const history = await pool.query(
      `SELECT fact_value, source_type, source_detail, created_at FROM business_facts
       WHERE business_id = $1 AND fact_key = $2 ORDER BY created_at DESC`,
      [req.params.id, req.params.factKey]
    );
    res.json({ history: history.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load fact history' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/auth/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/boardroom', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boardroom.html')));
app.get('/team-invite', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team-invite.html')));
app.get('/consult', (req, res) => res.sendFile(path.join(__dirname, 'public', 'consult.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Arreyon Consult' }));

// ═══════════════════════════════════════════════════════════════════════════
// AUTONOMOUS MONITORING & ALERTS
// Runs as an in-process scheduler (no external cron service needed) — checks
// every hour whether it's been at least a day since the last full sweep, and
// if so, runs it. This is a pragmatic choice for a single-instance Node
// service: no new dependencies, survives normal operation, and the worst
// case on a restart is waiting up to another hour for the next check —
// acceptable for a daily digest, not something that needs second-precision.
// ═══════════════════════════════════════════════════════════════════════════

// Bilingual alert text, written directly rather than AI-translated — these
// are simple, predictable templates with just numbers/names interpolated,
// not free-form prose, so hand-writing both versions once costs nothing
// ongoing and avoids the exact "wasted API credit to re-say the same thing
// in a different language" problem the rest of this system was built to
// avoid. Matches the same pattern already used for EMAIL_TEMPLATES.
const ALERT_MESSAGES = {
  trafficDrop: {
    en: (pctDrop, latest, avg) => ({ title: 'Website traffic has dropped', message: `Sessions are down ${pctDrop}% compared to your recent average (${latest} vs ~${avg}).` }),
    fr: (pctDrop, latest, avg) => ({ title: 'Le trafic du site web a chuté', message: `Les sessions ont baissé de ${pctDrop}% par rapport à votre moyenne récente (${latest} contre ~${avg}).` })
  },
  conversionsDrop: {
    en: (pctDrop) => ({ title: 'Conversions have dropped', message: `Conversions are down ${pctDrop}% compared to your recent average.` }),
    fr: (pctDrop) => ({ title: 'Les conversions ont chuté', message: `Les conversions ont baissé de ${pctDrop}% par rapport à votre moyenne récente.` })
  },
  competitorChange: {
    en: (businessName, count, names) => ({
      title: `New competitor${count > 1 ? 's' : ''} spotted for ${businessName}`,
      message: `Your latest market research surfaced ${count > 1 ? 'competitors' : 'a competitor'} not seen in your previous research: ${names}.`
    }),
    fr: (businessName, count, names) => ({
      title: `Nouveau${count > 1 ? 'x' : ''} concurrent${count > 1 ? 's' : ''} repéré${count > 1 ? 's' : ''} pour ${businessName}`,
      message: `Votre dernière étude de marché a révélé ${count > 1 ? 'des concurrents' : 'un concurrent'} non observé${count > 1 ? 's' : ''} dans vos recherches précédentes : ${names}.`
    })
  },
  newTeamMember: {
    en: (email) => ({ title: 'New team member joined', message: `${email} accepted your invitation and is now active on your account.` }),
    fr: (email) => ({ title: 'Nouveau membre d\u2019équipe', message: `${email} a accepté votre invitation et est maintenant actif sur votre compte.` })
  },
  seatsFull: {
    en: (limit, plan) => ({ title: 'Team seats are full', message: `You're using all ${limit} seats on your ${plan} plan. Upgrade if you'd like to invite more people.` }),
    fr: (limit, plan) => ({ title: 'Sièges d\u2019équipe complets', message: `Vous utilisez les ${limit} sièges de votre forfait ${plan}. Passez à un forfait supérieur pour inviter plus de personnes.` })
  },
  taskAssigned: {
    en: (taskTitle, businessName, assignerName) => ({ title: 'A task was assigned to you', message: `${assignerName} assigned you a task on ${businessName}: "${taskTitle}"` }),
    fr: (taskTitle, businessName, assignerName) => ({ title: 'Une tâche vous a été assignée', message: `${assignerName} vous a assigné une tâche sur ${businessName} : « ${taskTitle} »` })
  },
  competitorThreatIdentified: {
    en: (competitorName, businessName, threat) => ({ title: `New threat identified: ${competitorName}`, message: `Your analysis of ${competitorName} for ${businessName} flagged: ${threat}` }),
    fr: (competitorName, businessName, threat) => ({ title: `Nouvelle menace identifiée : ${competitorName}`, message: `Votre analyse de ${competitorName} pour ${businessName} a signalé : ${threat}` })
  },
  marketDeclining: {
    en: (businessName, growthTrend) => ({ title: `Market trend concern for ${businessName}`, message: growthTrend }),
    fr: (businessName, growthTrend) => ({ title: `Préoccupation liée à la tendance du marché pour ${businessName}`, message: growthTrend })
  },
  leadFollowUpOverdue: {
    en: (leadName, businessName, daysOverdue) => ({ title: `Overdue follow-up: ${leadName}`, message: `Your follow-up with ${leadName} for ${businessName} was due ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} ago.` }),
    fr: (leadName, businessName, daysOverdue) => ({ title: `Suivi en retard : ${leadName}`, message: `Votre suivi avec ${leadName} pour ${businessName} était prévu il y a ${daysOverdue} jour${daysOverdue === 1 ? '' : 's'}.` })
  },
  contentCalendarGap: {
    en: (businessName) => ({ title: `No content scheduled for ${businessName}`, message: `Your content calendar for ${businessName} has run out — there's nothing scheduled going forward. Generate a new one to keep posting consistently.` }),
    fr: (businessName) => ({ title: `Aucun contenu planifié pour ${businessName}`, message: `Votre calendrier de contenu pour ${businessName} est épuisé — rien n'est prévu pour la suite. Générez-en un nouveau pour continuer à publier régulièrement.` })
  },
  staleMarketingStrategy: {
    en: (businessName, daysOld) => ({ title: `Marketing strategy may be stale for ${businessName}`, message: `Your marketing strategy for ${businessName} hasn't been refreshed in ${daysOld} days. Consider regenerating it to reflect anything that's changed.` }),
    fr: (businessName, daysOld) => ({ title: `La stratégie marketing pourrait être obsolète pour ${businessName}`, message: `Votre stratégie marketing pour ${businessName} n'a pas été actualisée depuis ${daysOld} jours. Envisagez de la régénérer pour refléter ce qui a changé.` })
  },
  growthBehindSchedule: {
    en: (metricName, businessName) => ({ title: `Behind on ${metricName} for ${businessName}`, message: `Your progress on ${metricName} for ${businessName} is meaningfully behind where your target date expects it to be. Worth reviewing your plan or adjusting the timeline.` }),
    fr: (metricName, businessName) => ({ title: `En retard sur ${metricName} pour ${businessName}`, message: `Votre progression sur ${metricName} pour ${businessName} est sensiblement en retard par rapport à ce que votre date cible prévoit. Cela vaut la peine de revoir votre plan ou d'ajuster l'échéance.` })
  },
  growthNoCheckin: {
    en: (metricName, businessName, daysSince) => ({ title: `No recent check-in on ${metricName}`, message: `You haven't updated your progress on ${metricName} for ${businessName} in ${daysSince} days. A quick check-in keeps your growth tracking meaningful.` }),
    fr: (metricName, businessName, daysSince) => ({ title: `Aucun suivi récent sur ${metricName}`, message: `Vous n'avez pas mis à jour votre progression sur ${metricName} pour ${businessName} depuis ${daysSince} jours. Un suivi rapide garde le suivi de croissance pertinent.` })
  },
  fundingMilestoneReached: {
    en: (businessName, band) => ({ title: `${businessName} just reached "${band}" funding readiness`, message: `Your funding readiness for ${businessName} has crossed into the "${band}" range. This could be a good time to move forward on investor materials or outreach.` }),
    fr: (businessName, band) => ({ title: `${businessName} a atteint le niveau de préparation "${band}"`, message: `La préparation au financement de ${businessName} a franchi le seuil "${band}". C'est peut-être le bon moment pour avancer sur les documents pour investisseurs ou la prospection.` })
  },
  growthAheadSchedule: {
    en: (metricName, businessName) => ({ title: `Ahead of schedule on ${metricName}`, message: `Your progress on ${metricName} for ${businessName} is meaningfully ahead of where your target date expects it to be. Worth considering a more ambitious target.` }),
    fr: (metricName, businessName) => ({ title: `En avance sur ${metricName}`, message: `Votre progression sur ${metricName} pour ${businessName} est sensiblement en avance par rapport à ce que votre date cible prévoit. Cela vaut la peine d'envisager un objectif plus ambitieux.` })
  },
  competitorOpportunityIdentified: {
    en: (competitorName, businessName, opportunity) => ({ title: `Opportunity vs. ${competitorName}`, message: `Your analysis of ${competitorName} for ${businessName} identified: ${opportunity}` }),
    fr: (competitorName, businessName, opportunity) => ({ title: `Opportunité face à ${competitorName}`, message: `Votre analyse de ${competitorName} pour ${businessName} a identifié : ${opportunity}` })
  },
  marketOpportunityIdentified: {
    en: (businessName, opportunity) => ({ title: `Market opportunity for ${businessName}`, message: opportunity }),
    fr: (businessName, opportunity) => ({ title: `Opportunité de marché pour ${businessName}`, message: opportunity })
  },
  subscriptionExpiringSoon: {
    en: (plan, daysLeft) => ({
      title: `Your ${plan === 'starter' ? 'free trial' : plan} plan expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      message: plan === 'starter'
        ? `Your 1-month free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Subscribe to a paid plan to keep full access — after it expires, features will be locked until you upgrade.`
        : `Your ${plan} subscription expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}. Renew to avoid losing access — after it expires, features will be locked until you renew.`
    }),
    fr: (plan, daysLeft) => ({
      title: `Votre ${plan === 'starter' ? 'essai gratuit' : 'forfait ' + plan} expire dans ${daysLeft} jour${daysLeft === 1 ? '' : 's'}`,
      message: plan === 'starter'
        ? `Votre essai gratuit d'un mois se termine dans ${daysLeft} jour${daysLeft === 1 ? '' : 's'}. Abonnez-vous à un forfait payant pour conserver un accès complet — une fois expiré, les fonctionnalités seront verrouillées jusqu'à votre mise à niveau.`
        : `Votre abonnement ${plan} expire dans ${daysLeft} jour${daysLeft === 1 ? '' : 's'}. Renouvelez pour éviter de perdre l'accès — une fois expiré, les fonctionnalités seront verrouillées jusqu'à votre renouvellement.`
    })
  }
};
function alertText(templateKey, language, ...args) {
  const lang = language === 'fr' ? 'fr' : 'en';
  return ALERT_MESSAGES[templateKey][lang](...args);
}

async function createAlert(ownerId, businessId, alertType, severity, title, message, details) {
  const inserted = await pool.query(
    `INSERT INTO monitoring_alerts (owner_id, business_id, alert_type, severity, title, message, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [ownerId, businessId, alertType, severity, title, message, JSON.stringify(details || {})]
  );
  return inserted.rows[0];
}

// ── 1. Business metrics changes — needs Google Analytics connected ─────────
async function checkMetricsChanges(ownerId, prefs, language) {
  if (prefs && prefs.metrics_alerts_enabled === false) return;

  const connResult = await pool.query('SELECT * FROM google_analytics_connections WHERE owner_id = $1', [ownerId]);
  if (!connResult.rows.length) return;
  const connection = connResult.rows[0];
  if (!connection.property_id) return;

  const snapshots = await pool.query(
    `SELECT * FROM analytics_snapshots WHERE connection_id = $1 ORDER BY snapshot_date DESC LIMIT 8`,
    [connection.id]
  );
  if (snapshots.rows.length < 3) return; // need a real baseline, not just one or two days

  const [latest, ...prior] = snapshots.rows;
  const priorAvgSessions = prior.reduce((sum, s) => sum + (s.sessions || 0), 0) / prior.length;
  const priorAvgConversions = prior.reduce((sum, s) => sum + (s.conversions || 0), 0) / prior.length;

  if (priorAvgSessions >= 5 && latest.sessions < priorAvgSessions * 0.6) {
    const pctDrop = Math.round((1 - latest.sessions / priorAvgSessions) * 100);
    const { title, message } = alertText('trafficDrop', language, pctDrop, latest.sessions, Math.round(priorAvgSessions));
    await createAlert(ownerId, connection.business_id, 'metrics_change', 'warning',
      title, message,
      { latestSessions: latest.sessions, priorAvgSessions: Math.round(priorAvgSessions), pctDrop }
    );
  }

  if (priorAvgConversions >= 1 && latest.conversions < priorAvgConversions * 0.5) {
    const pctDrop = Math.round((1 - latest.conversions / priorAvgConversions) * 100);
    const { title, message } = alertText('conversionsDrop', language, pctDrop);
    await createAlert(ownerId, connection.business_id, 'metrics_change', 'warning',
      title, message,
      { latestConversions: latest.conversions, priorAvgConversions: Math.round(priorAvgConversions), pctDrop }
    );
  }
}

// ── 2. Competitor changes — compares the two most recent Market Research ───
// sessions for each of the account's businesses, flagging newly-appeared
// competitor names. Deliberately compares just the NAME SET rather than
// trying to semantically diff AI-written descriptions, since that's a much
// more reliable signal than fuzzy text comparison.
async function checkCompetitorChanges(ownerId, prefs, language) {
  if (prefs && prefs.competitor_alerts_enabled === false) return;

  const businesses = await pool.query('SELECT id, name FROM businesses WHERE user_id = $1 AND is_active = true', [ownerId]);
  for (const business of businesses.rows) {
    const sessions = await pool.query(
      `SELECT structured_data, created_at FROM research_sessions
       WHERE business_id = $1 AND structured_data IS NOT NULL
       ORDER BY created_at DESC LIMIT 2`,
      [business.id]
    );
    if (sessions.rows.length < 2) continue; // need at least two research runs to compare

    const [latest, previous] = sessions.rows;
    const latestNames = new Set((latest.structured_data?.competitors || []).map(c => (c.name || '').toLowerCase().trim()).filter(Boolean));
    const previousNames = new Set((previous.structured_data?.competitors || []).map(c => (c.name || '').toLowerCase().trim()).filter(Boolean));

    const newCompetitors = [...latestNames].filter(n => !previousNames.has(n));
    if (newCompetitors.length > 0) {
      const displayNames = (latest.structured_data?.competitors || [])
        .filter(c => newCompetitors.includes((c.name || '').toLowerCase().trim()))
        .map(c => c.name);
      const { title, message } = alertText('competitorChange', language, business.name, displayNames.length, displayNames.join(', '));
      await createAlert(ownerId, business.id, 'competitor_change', 'info',
        title, message,
        { newCompetitors: displayNames, businessName: business.name }
      );
    }
  }
}

// ── 3. Team activity — new members joining, and seats running out ──────────
async function checkTeamActivity(ownerId, ownerPlan, prefs, language) {
  if (prefs && prefs.team_activity_alerts_enabled === false) return;

  // New team members who joined in roughly the last day (this check runs
  // about once a day, so a 25-hour window comfortably covers one run without
  // missing anyone right at the boundary).
  const recentJoins = await pool.query(
    `SELECT member_email, joined_at FROM team_members
     WHERE owner_id = $1 AND status = 'active' AND joined_at > NOW() - INTERVAL '25 hours'`,
    [ownerId]
  );
  for (const member of recentJoins.rows) {
    const { title, message } = alertText('newTeamMember', language, member.member_email);
    await createAlert(ownerId, null, 'team_activity', 'info',
      title, message,
      { memberEmail: member.member_email }
    );
  }

  // Seat limit reached — only worth surfacing once per day at most, so this
  // simply fires every day the account happens to be at capacity, same as
  // the other checks; not tracked separately to avoid duplicate suppression complexity.
  const limits = PLAN_LIMITS[ownerPlan] || PLAN_LIMITS.starter;
  const activeCount = await pool.query(`SELECT COUNT(*) FROM team_members WHERE owner_id = $1 AND status != 'removed'`, [ownerId]);
  const seatsUsed = parseInt(activeCount.rows[0].count, 10) + 1; // +1 for the owner's own seat
  if (seatsUsed >= limits.team) {
    const { title, message } = alertText('seatsFull', language, limits.team, ownerPlan);
    await createAlert(ownerId, null, 'team_activity', 'info',
      title, message,
      { seatsUsed, seatLimit: limits.team, plan: ownerPlan }
    );
  }
}

// ── 4. Overdue lead follow-ups (Phase 7, Step 3) ────────────────────────────
// Re-reminds every 3 days a lead stays overdue, rather than either alerting
// once and never again (easy to forget) or every single day (noisy) — the
// same middle ground already accepted elsewhere in this sweep for
// conditions that can persist across multiple runs.
// ── Subscription expiry warning ─────────────────────────────────────────────
// Fires once per billing cycle (plan_expiry_notified_at is reset to NULL on
// each renewal in the payment-approval endpoint), not repeatedly like the
// other checks — a subscription only needs one heads-up before it lapses,
// not a recurring nag. Applies to free-trial starters and paid plans alike,
// since both now carry a real expiry date.
async function checkSubscriptionExpiry(ownerId, prefs, language) {
  const result = await pool.query(
    `SELECT plan, plan_expires_at, first_name FROM users
     WHERE id = $1 AND plan != 'expired' AND plan_expires_at IS NOT NULL
       AND plan_expires_at > NOW() AND plan_expires_at < NOW() + INTERVAL '5 days'
       AND plan_expiry_notified_at IS NULL`,
    [ownerId]
  );
  if (!result.rows.length) return;

  const user = result.rows[0];
  const daysLeft = Math.max(1, Math.ceil((new Date(user.plan_expires_at) - Date.now()) / (1000 * 60 * 60 * 24)));
  const { title, message } = alertText('subscriptionExpiringSoon', language, user.plan, daysLeft);
  await createAlert(ownerId, null, 'subscription_expiring', 'warning', title, message, { plan: user.plan, daysLeft });
  await pool.query('UPDATE users SET plan_expiry_notified_at = NOW() WHERE id = $1', [ownerId]);
}

async function checkOverdueLeadFollowUps(ownerId, prefs, language) {
  if (prefs && prefs.lead_alerts_enabled === false) return;

  const overdue = await pool.query(
    `SELECT l.*, b.name AS business_name FROM leads l JOIN businesses b ON b.id = l.business_id
     WHERE b.user_id = $1 AND l.next_follow_up_date < CURRENT_DATE
       AND l.status NOT IN ('won', 'lost')
       AND (l.overdue_alert_sent_at IS NULL OR l.overdue_alert_sent_at < NOW() - INTERVAL '3 days')`,
    [ownerId]
  );

  for (const lead of overdue.rows) {
    const daysOverdue = Math.max(1, Math.round((Date.now() - new Date(lead.next_follow_up_date).getTime()) / (1000 * 60 * 60 * 24)));
    const { title, message } = alertText('leadFollowUpOverdue', language, lead.name, lead.business_name, daysOverdue);
    await createAlert(ownerId, lead.business_id, 'lead_followup_overdue', 'warning', title, message, { leadName: lead.name, businessName: lead.business_name, daysOverdue });
    await pool.query('UPDATE leads SET overdue_alert_sent_at = NOW() WHERE id = $1', [lead.id]);
  }
}

// ── Marketing alerts (Phase 9, Step 1) ──────────────────────────────────────
// Content calendar gap re-reminds every 14 days, stale strategy every 30 —
// both longer than the lead follow-up cadence, since neither is as
// time-critical as a specific missed commitment to a named person.
async function checkMarketingAlerts(ownerId, prefs, language) {
  if (prefs && prefs.marketing_alerts_enabled === false) return;

  const calendarGaps = await pool.query(
    `SELECT id, name FROM businesses
     WHERE user_id = $1 AND is_active = true
       AND content_calendar_end_date IS NOT NULL AND content_calendar_end_date < CURRENT_DATE
       AND (calendar_gap_alert_sent_at IS NULL OR calendar_gap_alert_sent_at < NOW() - INTERVAL '14 days')`,
    [ownerId]
  );
  for (const biz of calendarGaps.rows) {
    const { title, message } = alertText('contentCalendarGap', language, biz.name);
    await createAlert(ownerId, biz.id, 'content_calendar_gap', 'info', title, message, { businessName: biz.name });
    await pool.query('UPDATE businesses SET calendar_gap_alert_sent_at = NOW() WHERE id = $1', [biz.id]);
  }

  const staleStrategies = await pool.query(
    `SELECT id, name, marketing_strategy_generated_at FROM businesses
     WHERE user_id = $1 AND is_active = true
       AND marketing_strategy_generated_at IS NOT NULL AND marketing_strategy_generated_at < NOW() - INTERVAL '90 days'
       AND (stale_strategy_alert_sent_at IS NULL OR stale_strategy_alert_sent_at < NOW() - INTERVAL '30 days')`,
    [ownerId]
  );
  for (const biz of staleStrategies.rows) {
    const daysOld = Math.round((Date.now() - new Date(biz.marketing_strategy_generated_at).getTime()) / (1000 * 60 * 60 * 24));
    const { title, message } = alertText('staleMarketingStrategy', language, biz.name, daysOld);
    await createAlert(ownerId, biz.id, 'stale_marketing_strategy', 'info', title, message, { businessName: biz.name, daysOld });
    await pool.query('UPDATE businesses SET stale_strategy_alert_sent_at = NOW() WHERE id = $1', [biz.id]);
  }
}

// Direction-aware "behind schedule" check — works whether the goal is to
// increase a metric (revenue growth) or decrease one (cost reduction).
// Pulled out as its own function so its logic can be tested in isolation
// from the database query around it.
function isGrowthObjectiveBehindSchedule({ startingValue, currentValue, targetValue, targetDate, createdAt, now }) {
  if (!targetDate) return false;
  const totalSpan = new Date(targetDate) - new Date(createdAt);
  if (totalSpan <= 0) return false;
  const elapsedFraction = Math.min(Math.max((now - new Date(createdAt)) / totalSpan, 0), 1);
  const expectedValue = startingValue + elapsedFraction * (targetValue - startingValue);

  const isIncreasingGoal = targetValue >= startingValue;
  const totalRange = Math.abs(targetValue - startingValue) || 1;
  const gap = isIncreasingGoal ? (expectedValue - currentValue) : (currentValue - expectedValue);
  return (gap / totalRange) > 0.2;
}

// ── Growth alerts (Phase 9, Step 2) ─────────────────────────────────────────
// Behind-schedule re-reminds every 14 days, no-checkin every 14 days too —
// both tracked independently so one being recently alerted never suppresses
// the other for the same objective.
async function checkGrowthAlerts(ownerId, prefs, language) {
  if (prefs && prefs.growth_alerts_enabled === false) return;

  const objectives = await pool.query(
    `SELECT go.*, b.name AS business_name,
       (SELECT recorded_at FROM growth_progress_history WHERE objective_id = go.id ORDER BY recorded_at DESC LIMIT 1) AS last_checkin_at
     FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
     WHERE b.user_id = $1 AND go.status = 'active'`,
    [ownerId]
  );

  const now = new Date();
  for (const obj of objectives.rows) {
    const canAlertBehind = !obj.behind_schedule_alert_sent_at || (now - new Date(obj.behind_schedule_alert_sent_at)) > 14 * 24 * 60 * 60 * 1000;
    if (canAlertBehind && obj.target_date && isGrowthObjectiveBehindSchedule({
      startingValue: parseFloat(obj.starting_value), currentValue: parseFloat(obj.current_value),
      targetValue: parseFloat(obj.target_value), targetDate: obj.target_date, createdAt: obj.created_at, now
    })) {
      const { title, message } = alertText('growthBehindSchedule', language, obj.metric_name, obj.business_name);
      await createAlert(ownerId, obj.business_id, 'growth_behind_schedule', 'warning', title, message, { metricName: obj.metric_name, businessName: obj.business_name });
      await pool.query('UPDATE growth_objectives SET behind_schedule_alert_sent_at = NOW() WHERE id = $1', [obj.id]);
    }

    // "No check-in" measures from whichever is more recent: the last
    // recorded progress entry, or the objective's own creation — a
    // brand-new objective with zero check-ins yet shouldn't be flagged
    // stale the moment it's created.
    const sinceReference = obj.last_checkin_at || obj.created_at;
    const daysSinceCheckin = Math.round((now - new Date(sinceReference)) / (1000 * 60 * 60 * 24));
    const canAlertNoCheckin = !obj.no_checkin_alert_sent_at || (now - new Date(obj.no_checkin_alert_sent_at)) > 14 * 24 * 60 * 60 * 1000;
    if (canAlertNoCheckin && daysSinceCheckin >= 30) {
      const { title, message } = alertText('growthNoCheckin', language, obj.metric_name, obj.business_name, daysSinceCheckin);
      await createAlert(ownerId, obj.business_id, 'growth_no_checkin', 'info', title, message, { metricName: obj.metric_name, businessName: obj.business_name, daysSinceCheckin });
      await pool.query('UPDATE growth_objectives SET no_checkin_alert_sent_at = NOW() WHERE id = $1', [obj.id]);
    }
  }
}

// Inverse of isGrowthObjectiveBehindSchedule — genuinely ahead in whichever
// direction this goal actually moves (increasing or decreasing).
function isGrowthObjectiveAheadOfSchedule({ startingValue, currentValue, targetValue, targetDate, createdAt, now }) {
  if (!targetDate) return false;
  const totalSpan = new Date(targetDate) - new Date(createdAt);
  if (totalSpan <= 0) return false;
  const elapsedFraction = Math.min(Math.max((now - new Date(createdAt)) / totalSpan, 0), 1);
  const expectedValue = startingValue + elapsedFraction * (targetValue - startingValue);

  const isIncreasingGoal = targetValue >= startingValue;
  const totalRange = Math.abs(targetValue - startingValue) || 1;
  const gap = isIncreasingGoal ? (currentValue - expectedValue) : (expectedValue - currentValue);
  return (gap / totalRange) > 0.2;
}

// ── Opportunity Radar (Phase 9, Step 4) ─────────────────────────────────────
// Reuses the existing monitoring_alerts plumbing with a distinct 'opportunity'
// severity, rather than a parallel system, since read/unread tracking,
// digest emails, and preferences all genuinely apply here too. This periodic
// piece covers the one signal that isn't tied to a specific user action
// (funding milestones and competitor/market opportunities fire immediately
// when generated, covered elsewhere) — growth pace needs to be checked
// continuously against the plan's timeline.
async function checkOpportunityRadar(ownerId, prefs, language) {
  if (prefs && prefs.opportunity_radar_enabled === false) return;

  const objectives = await pool.query(
    `SELECT go.*, b.name AS business_name FROM growth_objectives go JOIN businesses b ON b.id = go.business_id
     WHERE b.user_id = $1 AND go.status = 'active' AND go.target_date IS NOT NULL`,
    [ownerId]
  );

  const now = new Date();
  for (const obj of objectives.rows) {
    const canAlert = !obj.ahead_schedule_alert_sent_at || (now - new Date(obj.ahead_schedule_alert_sent_at)) > 14 * 24 * 60 * 60 * 1000;
    if (canAlert && isGrowthObjectiveAheadOfSchedule({
      startingValue: parseFloat(obj.starting_value), currentValue: parseFloat(obj.current_value),
      targetValue: parseFloat(obj.target_value), targetDate: obj.target_date, createdAt: obj.created_at, now
    })) {
      const { title, message } = alertText('growthAheadSchedule', language, obj.metric_name, obj.business_name);
      await createAlert(ownerId, obj.business_id, 'growth_ahead_schedule', 'opportunity', title, message, { metricName: obj.metric_name, businessName: obj.business_name });
      await pool.query('UPDATE growth_objectives SET ahead_schedule_alert_sent_at = NOW() WHERE id = $1', [obj.id]);
    }
  }
}

// ── Orchestration — runs all 3 checks for every account owner, then sends ──
// one digest email per owner covering everything new since the last run.
// Each owner is processed independently: if one owner's data causes an
// unexpected error, that must not stop the sweep for everyone else.
async function runMonitoringSweep() {
  console.log('Monitoring sweep starting...');
  let ownersChecked = 0, alertsCreated = 0, emailsSent = 0;

  try {
    // Only real account owners — team members share the owner's data and
    // don't get their own independent sweep.
    const owners = await pool.query(`SELECT id, plan, preferred_language FROM users WHERE team_owner_id IS NULL`);

    for (const owner of owners.rows) {
      try {
        const prefResult = await pool.query('SELECT * FROM monitoring_preferences WHERE owner_id = $1', [owner.id]);
        const prefs = prefResult.rows[0] || null; // no row yet = all defaults (enabled)

        await checkMetricsChanges(owner.id, prefs, owner.preferred_language);
        await checkCompetitorChanges(owner.id, prefs, owner.preferred_language);
        await checkTeamActivity(owner.id, owner.plan, prefs, owner.preferred_language);
        await checkOverdueLeadFollowUps(owner.id, prefs, owner.preferred_language);
        await checkMarketingAlerts(owner.id, prefs, owner.preferred_language);
        await checkGrowthAlerts(owner.id, prefs, owner.preferred_language);
        await checkOpportunityRadar(owner.id, prefs, owner.preferred_language);
        await checkSubscriptionExpiry(owner.id, prefs, owner.preferred_language);
        ownersChecked++;

        // Digest email for anything created just now and not yet emailed
        const emailAlertsEnabled = !prefs || prefs.email_alerts_enabled !== false;
        if (emailAlertsEnabled) {
          const unsent = await pool.query(`SELECT * FROM monitoring_alerts WHERE owner_id = $1 AND email_sent = false ORDER BY created_at ASC`, [owner.id]);
          if (unsent.rows.length) {
            const userResult = await pool.query('SELECT email, first_name FROM users WHERE id = $1', [owner.id]);
            const user = userResult.rows[0];
            if (user) {
              const alertsHtml = unsent.rows.map(a =>
                `<div style="background:#f5f5f5;border-radius:8px;padding:12px 14px;margin-bottom:10px">
                  <strong>${a.title}</strong><p style="margin:4px 0 0;font-size:13px;color:#555">${a.message}</p>
                </div>`
              ).join('');
              const { subject, html } = buildEmail('monitoringDigest', owner.preferred_language, {
                alertCount: unsent.rows.length, alertsHtml, dashboardUrl: `${BASE_URL}/dashboard`
              });
              await sendEmail(user.email, subject, html);
              await pool.query(`UPDATE monitoring_alerts SET email_sent = true WHERE owner_id = $1 AND email_sent = false`, [owner.id]);
              emailsSent++;
              alertsCreated += unsent.rows.length;
            }
          }
        } else {
          // Email disabled, but still mark as "sent" so a later re-enable
          // doesn't suddenly flood them with a backlog of old alerts.
          await pool.query(`UPDATE monitoring_alerts SET email_sent = true WHERE owner_id = $1 AND email_sent = false`, [owner.id]);
        }
      } catch (ownerErr) {
        console.error(`Monitoring sweep failed for owner ${owner.id}:`, ownerErr.message);
      }
    }
  } catch (err) {
    console.error('Monitoring sweep top-level error:', err.message);
  }

  console.log(`Monitoring sweep complete. Owners checked: ${ownersChecked}, digest emails sent: ${emailsSent}.`);
}

// Checks every hour whether at least ~24 hours have passed since the last
// full sweep, and runs one if so. No new dependency (like node-cron) needed
// for this — the tradeoff is that a service restart resets the timer, so in
// the worst case the next check is delayed by up to an hour, which is fine
// for a daily digest.
let lastMonitoringSweepAt = null;
function startMonitoringScheduler() {
  setInterval(async () => {
    const hoursSinceLastRun = lastMonitoringSweepAt ? (Date.now() - lastMonitoringSweepAt) / (1000 * 60 * 60) : Infinity;
    if (hoursSinceLastRun >= 24) {
      lastMonitoringSweepAt = Date.now();
      await runMonitoringSweep();
    }
  }, 60 * 60 * 1000); // check every hour
}

// ── Alerts API — shared across the team, like other account data ──────────
app.get('/api/alerts', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(
      `SELECT a.*, b.name as business_name FROM monitoring_alerts a
       LEFT JOIN businesses b ON b.id = a.business_id
       WHERE a.owner_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
      [account.id]
    );
    res.json({ alerts: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load alerts' }); }
});

app.get('/api/alerts/unread-count', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(`SELECT COUNT(*) FROM monitoring_alerts WHERE owner_id = $1 AND is_read = false`, [account.id]);
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (e) { res.status(500).json({ error: 'Failed to load unread count' }); }
});

app.put('/api/alerts/:id/read', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query(`UPDATE monitoring_alerts SET is_read = true WHERE id = $1 AND owner_id = $2 RETURNING id`, [req.params.id, account.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update alert' }); }
});

app.put('/api/alerts/read-all', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    await pool.query(`UPDATE monitoring_alerts SET is_read = true WHERE owner_id = $1 AND is_read = false`, [account.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to update alerts' }); }
});

app.get('/api/alerts/preferences', authRequired, async (req, res) => {
  try {
    const account = await resolveAccount(req.userId);
    const result = await pool.query('SELECT * FROM monitoring_preferences WHERE owner_id = $1', [account.id]);
    // No row yet means every alert type is on by default — matches the
    // column defaults, so this is safe to hand back as-is.
    const prefs = result.rows[0] || { metrics_alerts_enabled: true, competitor_alerts_enabled: true, team_activity_alerts_enabled: true, email_alerts_enabled: true, lead_alerts_enabled: true, marketing_alerts_enabled: true, growth_alerts_enabled: true, opportunity_radar_enabled: true };
    res.json({ preferences: prefs });
  } catch (e) { res.status(500).json({ error: 'Failed to load preferences' }); }
});

app.put('/api/alerts/preferences', authRequired, async (req, res) => {
  const { metricsAlertsEnabled, competitorAlertsEnabled, teamActivityAlertsEnabled, emailAlertsEnabled, leadAlertsEnabled, marketingAlertsEnabled, growthAlertsEnabled, opportunityRadarEnabled } = req.body;
  try {
    const account = await resolveAccount(req.userId);
    if (account.id !== req.userId) return res.status(403).json({ error: 'Only the account owner can manage alert preferences' });
    await pool.query(
      `INSERT INTO monitoring_preferences (owner_id, metrics_alerts_enabled, competitor_alerts_enabled, team_activity_alerts_enabled, email_alerts_enabled, lead_alerts_enabled, marketing_alerts_enabled, growth_alerts_enabled, opportunity_radar_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (owner_id) DO UPDATE SET metrics_alerts_enabled = $2, competitor_alerts_enabled = $3, team_activity_alerts_enabled = $4, email_alerts_enabled = $5, lead_alerts_enabled = $6, marketing_alerts_enabled = $7, growth_alerts_enabled = $8, opportunity_radar_enabled = $9, updated_at = NOW()`,
      [account.id, metricsAlertsEnabled !== false, competitorAlertsEnabled !== false, teamActivityAlertsEnabled !== false, emailAlertsEnabled !== false, leadAlertsEnabled !== false, marketingAlertsEnabled !== false, growthAlertsEnabled !== false, opportunityRadarEnabled !== false]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed to save preferences' }); }
});


// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Arreyon Consult running on port ${PORT}`);
  startMonitoringScheduler();
});
