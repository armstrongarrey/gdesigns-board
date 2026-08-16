const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
const GMAIL_USER = 'gdesignsme@gmail.com';
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'info@gdesignsme.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';
const BASE_URL = process.env.BASE_URL || 'https://consult.gdesignsme.com';

const PLAN_LIMITS = {
  starter:  { consultations: 3,  directors: 5,   download: false, video: false, history: false, team: 1 },
  pro:      { consultations: 10, directors: 29,  download: true,  video: false, history: true,  team: 3 },
  business: { consultations: -1, directors: 29,  download: true,  video: true,  history: true,  team: 6 }
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

// ── GOOGLE OAUTH ───────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: `${BASE_URL}/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails[0].value;
    const firstName = profile.name.givenName;
    const lastName = profile.name.familyName;
    const googleId = profile.id;
    const avatar = profile.photos[0]?.value;

    let result = await pool.query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);
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
  const { firstName, lastName, email, password, phone, country } = req.body;
  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: 'All required fields must be filled' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) return res.status(400).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const token = uuidv4();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, phone, country,
       verification_token, verification_expires, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'starter') RETURNING *`,
      [email, hash, firstName, lastName, phone, country, token, expires]
    );
    const user = result.rows[0];

    const verifyUrl = `${BASE_URL}/auth/verify?token=${token}`;
    await sendEmail(email, 'Verify your Arreyon Consult account', `
      <div style="font-family:sans-serif;max-width:500px;margin:0 auto">
        <h2>Welcome to Arreyon Consult, ${firstName}!</h2>
        <p>Please verify your email address to activate your account.</p>
        <a href="${verifyUrl}" style="display:inline-block;background:#6C3Bff;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
        <p style="color:#666;font-size:12px;margin-top:20px">This link expires in 24 hours. If you did not create this account, ignore this email.</p>
        <hr>
        <p style="color:#999;font-size:11px">Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com</p>
      </div>
    `);

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
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
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
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || user.email_verified) return res.json({ success: true });

    const token = uuidv4();
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await pool.query('UPDATE users SET verification_token = $1, verification_expires = $2 WHERE id = $3',
      [token, expires, user.id]);

    const verifyUrl = `${BASE_URL}/auth/verify?token=${token}`;
    await sendEmail(email, 'Verify your Arreyon Consult account',
      `<p>Click <a href="${verifyUrl}">here</a> to verify your email. Link expires in 24 hours.</p>`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed to resend' }); }
});

// Forgot password
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) return res.json({ success: true }); // Don't reveal if email exists

    const token = uuidv4();
    const expires = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query('UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3',
      [token, expires, user.id]);

    const resetUrl = `${BASE_URL}/auth/reset-password?token=${token}`;
    await sendEmail(email, 'Reset your Arreyon Consult password',
      `<p>Click <a href="${resetUrl}">here</a> to reset your password. Link expires in 1 hour.</p>`);
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
  res.clearCookie('arreyon_token');
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
    const result = await pool.query('SELECT id, email, first_name, last_name, phone, avatar_url, plan, consultations_used, created_at FROM users WHERE id = $1', [req.userId]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
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
  res.clearCookie('arreyon_admin_token');
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// CMS ROUTES (Admin only)
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/cms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_content ORDER BY section, key');
    const content = {};
    result.rows.forEach(row => {
      if (!content[row.section]) content[row.section] = {};
      content[row.section][row.key] = row.value;
    });
    res.json({ content });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

app.put('/api/cms', adminRequired, async (req, res) => {
  const { section, key, value } = req.body;
  try {
    await pool.query(
      `INSERT INTO cms_content (section, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (section, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [section, key, value]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
});

// Bulk CMS update
app.put('/api/cms/bulk', adminRequired, async (req, res) => {
  const { updates } = req.body; // [{section, key, value}]
  try {
    for (const { section, key, value } of updates) {
      await pool.query(
        `INSERT INTO cms_content (section, key, value) VALUES ($1, $2, $3)
         ON CONFLICT (section, key) DO UPDATE SET value = $3, updated_at = NOW()`,
        [section, key, value]
      );
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
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
      `UPDATE users SET plan = $1, updated_at = NOW() WHERE id = $2`, [p.plan, p.user_id]
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
      await sendEmail(user.rows[0].email, 'Your Arreyon Consult plan is now active!',
        `<p>Hi ${user.rows[0].first_name},</p>
         <p>Your <strong>${p.plan}</strong> plan has been activated. Welcome to the board.</p>
         <p><a href="${BASE_URL}/dashboard">Go to your dashboard</a></p>`
      );
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

app.put('/api/admin/users/:id/plan', adminRequired, async (req, res) => {
  const { plan } = req.body;
  try {
    await pool.query('UPDATE users SET plan = $1 WHERE id = $2', [plan, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Failed' }); }
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

app.get('/api/user/consultations', authRequired, async (req, res) => {
  try {
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
    if (!PLAN_LIMITS[plan]?.history) {
      return res.json({ consultations: [], upgradeRequired: true });
    }
    const result = await pool.query(
      'SELECT * FROM consultations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.userId]
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
  const { challenge, directors } = req.body; // directors: [{id,name,role}]
  if (!challenge || !directors || !directors.length) {
    return res.status(400).json({ error: 'Missing challenge or director list' });
  }

  const matchPrompt = `A founder described this challenge: "${challenge}"

Here is the list of available board directors, each with their specialty:
${directors.map(d => `- ${d.id}: ${d.name} — ${d.role}`).join('\n')}

Pick the ONE director whose specialty best matches this challenge. Return ONLY the director's id (the short lowercase code before the colon), nothing else — no explanation, no punctuation.`;

  try {
    const result = await askClaude(matchPrompt, [{ role: 'user', content: 'Which director id matches best?' }]);
    const matchedId = result.trim().toLowerCase().replace(/[^a-z]/g, '');
    const valid = directors.find(d => d.id === matchedId);
    res.json({ directorId: valid ? matchedId : directors[0].id });
  } catch (err) {
    console.error('Match error:', err.message);
    res.json({ directorId: directors[0].id }); // graceful fallback
  }
});

app.post('/api/board/chat', authRequired, async (req, res) => {
  const { persona, messages, ai, directorId, consultationId } = req.body;

  try {
    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    const u = user.rows[0];
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

    // Call the appropriate AI
    let reply;
    const selectedAI = ai || 'claude';

    if (selectedAI === 'chatgpt') {
      reply = await askChatGPT(persona, messages);
    } else if (selectedAI === 'gemini') {
      reply = await askGemini(persona, messages);
    } else {
      reply = await askClaude(persona, messages);
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
  const { conversations } = req.body; // [{ directorName, directorRole, messages: [{from,text}] }]

  if (!conversations || !Array.isArray(conversations) || !conversations.length) {
    return res.status(400).json({ error: 'No conversations to synthesize. Chat with at least one director first.' });
  }

  try {
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
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

    const raw = await askClaude(prompt, [{ role: 'user', content: 'Produce the Chairman synthesis now, as JSON only.' }], { feature: 'chairman_synthesis', userId: req.userId }, 2000);
    let synthesis;

    try {

      synthesis = extractJSON(raw);

    } catch (e) {

      console.error('Chairman synthesis JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));

      throw new Error('Could not produce the board verdict — please try again');

    }

    res.json({ success: true, synthesis });
  } catch (err) {
    console.error('Chairman synthesis error:', err.message);
    res.status(500).json({ error: err.message || 'Synthesis failed. Please try again.' });
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
  if (input.skills) parts.push(`Skills: ${input.skills}`);
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
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
    const researchBacked = plan === 'pro' || plan === 'business';

    const input = req.body || {};
    if (!input.country && !input.skills && !input.interests) {
      return res.status(400).json({ error: 'Please provide at least your location, skills, or interests to find relevant opportunities.' });
    }

    const context = formatEntrepreneurContext(input);
    let sourcesText = '', sources = [];

    if (researchBacked) {
      const queries = [];
      const locationPart = input.country ? `in ${input.city ? input.city + ', ' : ''}${input.country}` : '';
      if (input.interests) queries.push(`small business opportunities ${input.interests} ${locationPart} 2026`.trim());
      if (input.skills) queries.push(`how to start a business with ${input.skills} skills ${locationPart}`.trim());
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

    const raw = await askClaude(prompt, [{ role: 'user', content: 'Find the opportunities now, as JSON only.' }], { feature: 'entrepreneur_mode', userId: req.userId }, 2800);
    let structured;
    try {
      structured = extractJSON(raw);
    } catch (e) {
      console.error('Opportunity finder JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate opportunities — please try again');
    }

    const session = await pool.query(
      `INSERT INTO entrepreneur_sessions (user_id, mode, input_data, structured_output, research_backed) VALUES ($1, 'opportunity_finder', $2, $3, $4) RETURNING id, created_at`,
      [req.userId, JSON.stringify(input), JSON.stringify(structured), researchBacked]
    );

    res.json({ success: true, sessionId: session.rows[0].id, structured, sources, researchBacked });
  } catch (err) {
    console.error('Opportunity finder error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to find opportunities. Please try again.' });
  }
});

// ── B) Idea Validation ──────────────────────────────────────────────────────
app.post('/api/entrepreneur/validate-idea', authRequired, async (req, res) => {
  try {
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
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

    const raw = await askClaude(prompt, [{ role: 'user', content: 'Validate the idea now, as JSON only.' }], { feature: 'entrepreneur_mode', userId: req.userId }, 2800);
    let structured;
    try {
      structured = extractJSON(raw);
    } catch (e) {
      console.error('Idea validation JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not validate the idea — please try again');
    }

    const session = await pool.query(
      `INSERT INTO entrepreneur_sessions (user_id, mode, input_data, structured_output, research_backed) VALUES ($1, 'idea_validation', $2, $3, $4) RETURNING id, created_at`,
      [req.userId, JSON.stringify(input), JSON.stringify(structured), researchBacked]
    );

    res.json({ success: true, sessionId: session.rows[0].id, structured, sources, researchBacked });
  } catch (err) {
    console.error('Idea validation error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to validate idea. Please try again.' });
  }
});

// ── Entrepreneur Mode history ───────────────────────────────────────────────
app.get('/api/entrepreneur/sessions', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, mode, input_data, structured_output, research_backed, discussion_messages, business_plan, created_at FROM entrepreneur_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.userId]
    );
    res.json({ sessions: result.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load sessions' }); }
});

// ── Discuss the results — follow-up chat grounded in that specific session ──
app.post('/api/entrepreneur/:sessionId/discuss', authRequired, async (req, res) => {
  const { message } = req.body;
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

Stay grounded in what was actually generated above — don't contradict it without good reason, but do engage honestly if they raise a fair challenge. Keep responses focused and conversational, 2-4 sentences unless genuinely more detail is needed. Do not restate the entire original report.`;

    const chatMessages = [
      ...priorMessages.map(m => ({ role: m.from === 'you' ? 'user' : 'assistant', content: m.text })),
      { role: 'user', content: message }
    ];

    const reply = await askClaude(persona, chatMessages, { feature: 'entrepreneur_mode', userId: req.userId }, 800);

    const updatedMessages = [...priorMessages, { from: 'you', text: message }, { from: 'them', text: reply }];
    await pool.query('UPDATE entrepreneur_sessions SET discussion_messages = $1 WHERE id = $2', [JSON.stringify(updatedMessages), req.params.sessionId]);

    res.json({ reply, discussionMessages: updatedMessages });
  } catch (err) {
    console.error('Entrepreneur discuss error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to respond. Please try again.' });
  }
});

// ── Generate a full business plan from a validated idea or chosen opportunity ──
app.post('/api/entrepreneur/:sessionId/business-plan', authRequired, async (req, res) => {
  const { chosenOpportunityName } = req.body; // required if session.mode === 'opportunity_finder'

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

    const prompt = `You are a business planning consultant at Arreyon Consult. Build a complete, practical business plan for this founder.

BUSINESS: ${businessDescription}

FOUNDER'S CIRCUMSTANCES:
${context || 'Limited context available.'}

${isOpp ? `PRIOR OPPORTUNITY ANALYSIS:\n${JSON.stringify((session.structured_output.opportunities || []).find(o => o.name === chosenOpportunityName))}` : `PRIOR IDEA VALIDATION:\n${JSON.stringify(session.structured_output)}`}

YOUR TASK:
Produce a complete, realistic business plan grounded in the founder's actual stated capital and time — not a generic template. Be specific with numbers where the founder's capital/time context allows it. Marketing must be a genuinely separate, detailed section — not a single throwaway line.

CRITICAL LENGTH RULE: Every field below must be ONE sentence, maximum 25 words. Do not write paragraph-length financial justifications or multi-clause reasoning chains — state the number or conclusion plainly. If you need to show your reasoning, that reasoning must fit within the same 25-word limit as the answer itself, not as an additional explanation appended after it.

Return ONLY valid JSON, no markdown, in exactly this structure:
{
  "business_model": {
    "value_proposition": "the core value delivered, one sentence",
    "customer_segments": "who specifically this serves",
    "revenue_streams": ["stream 1", "stream 2"],
    "cost_structure": ["major cost 1", "major cost 2"],
    "key_resources": ["what's needed to operate"],
    "key_activities": ["what must be done regularly"],
    "key_partners": ["who to partner with, if relevant"],
    "channels": ["how customers are reached"]
  },
  "strategy": {
    "positioning": "how this should be positioned in the market",
    "competitive_advantage": "the specific edge this has or must build",
    "differentiation": "what makes this different from alternatives"
  },
  "marketing_plan": {
    "target_audience": "the specific customer profile marketing should focus on",
    "key_messaging": "the core message/hook that should appear in all marketing",
    "marketing_channels": ["specific channel 1 (e.g. WhatsApp groups, Instagram)", "specific channel 2"],
    "content_strategy": "what kind of content to post and how often, concretely",
    "promotional_tactics": ["specific tactic 1 (e.g. referral discount, launch offer)", "specific tactic 2"],
    "customer_acquisition_funnel": "the step-by-step path from stranger to paying customer, specific to this business",
    "marketing_budget_estimate": "realistic monthly marketing spend given their stated capital"
  },
  "execution_plan": {
    "phase_30_days": ["specific task 1", "specific task 2", "specific task 3"],
    "phase_60_days": ["specific task 1", "specific task 2"],
    "phase_90_days": ["specific task 1", "specific task 2"]
  },
  "financial_snapshot": {
    "estimated_startup_cost": "a single figure or narrow range, max 25 words, no reasoning chain",
    "monthly_operating_cost": "a single figure or narrow range, max 25 words, no reasoning chain",
    "breakeven_estimate": "a single timeframe, max 25 words, no reasoning chain",
    "key_assumption": "the single biggest assumption, stated plainly in max 25 words"
  }
}`;

    const raw = await askClaude(prompt, [{ role: 'user', content: 'Build the business plan now, as JSON only. Keep every field to one short sentence as instructed.' }], { feature: 'entrepreneur_mode', userId: req.userId }, 6500);
    let plan;
    try {
      plan = extractJSON(raw);
    } catch (e) {
      console.error('Business plan JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
      throw new Error('Could not generate the business plan — please try again');
    }

    await pool.query('UPDATE entrepreneur_sessions SET business_plan = $1 WHERE id = $2', [JSON.stringify(plan), req.params.sessionId]);

    res.json({ success: true, businessPlan: plan });
  } catch (err) {
    console.error('Business plan error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to generate business plan. Please try again.' });
  }
});

// Save consultation
app.post('/api/board/save', authRequired, async (req, res) => {
  const { title, businessType, industry, directorsUsed, reportText, synthesis, videoUrl, messages } = req.body;
  try {
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';

    const consult = await pool.query(
      `INSERT INTO consultations (user_id, title, business_type, industry, directors_used, report_text, synthesis, video_url, status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', NOW()) RETURNING *`,
      [req.userId, title, businessType, industry, JSON.stringify(directorsUsed), reportText, synthesis, videoUrl]
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
    await pool.query('UPDATE users SET consultations_used = consultations_used + 1 WHERE id = $1', [req.userId]);

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

async function _askClaudeRaw(persona, messages, maxTokens = 1024) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Claude API key not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system: persona, messages })
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
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

// ── Public AI functions — same signatures as before, now with usage logging ──
async function askClaude(persona, messages, context = {}, maxTokens = 1024) {
  const start = Date.now();
  try {
    const result = await _askClaudeRaw(persona, messages, maxTokens);
    logAIUsage({ provider: 'claude', model: 'claude-haiku-4-5-20251001', status: 'success', durationMs: Date.now() - start, ...context });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'claude', model: 'claude-haiku-4-5-20251001', status: 'error', errorMessage: e.message, durationMs: Date.now() - start, ...context });
    throw e;
  }
}

async function askChatGPT(persona, messages) {
  const start = Date.now();
  try {
    const result = await _askChatGPTRaw(persona, messages);
    logAIUsage({ provider: 'chatgpt', model: 'gpt-4o-mini', status: 'success', durationMs: Date.now() - start });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'chatgpt', model: 'gpt-4o-mini', status: 'error', errorMessage: e.message, durationMs: Date.now() - start });
    throw e;
  }
}

async function askGemini(persona, messages) {
  const start = Date.now();
  try {
    const result = await _askGeminiRaw(persona, messages);
    logAIUsage({ provider: 'gemini', model: 'gemini-1.5-flash-latest', status: 'success', durationMs: Date.now() - start });
    return result;
  } catch (e) {
    logAIUsage({ provider: 'gemini', model: 'gemini-1.5-flash-latest', status: 'error', errorMessage: e.message, durationMs: Date.now() - start });
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSULT BOARD ROUTES (from existing platform)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/consult/qualify', async (req, res) => {
  const { businessData, conversationHistory = [] } = req.body;
  if (!businessData) return res.status(400).json({ error: 'Missing business data' });

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
RULES: ONE question only. Under 60 words total. Warm and conversational. Return plain text only.`;

  try {
    const q = await askClaude(qualifyPrompt, [{ role: 'user', content: lastUserMsg || 'Continue.' }]);
    res.json({ ready: false, question: q.trim().replace(/^["']|["']$/g, '') });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/consult/run', async (req, res) => {
  const { businessData, clientInfo, conversationHistory = [] } = req.body;
  if (!businessData || !clientInfo) return res.status(400).json({ error: 'Missing business data or client info' });

  const DIRECTORS = {
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

  const directors = selectDirectors(businessData);
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

Format your response as plain text paragraphs. No headers. No bullet points.`;

      let insight;
      try {
        if (director.ai === 'chatgpt') insight = await askChatGPT(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        else if (director.ai === 'gemini') insight = await askGemini(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
        else insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]);
      } catch (dirErr) {
        try { insight = await askClaude(directorPrompt, [{ role: 'user', content: `As ${director.name}, what is your specific advice for this business?` }]); }
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

Keep each section concise and actionable. Total: 400-500 words.`;

    const synthesis = await askClaude(synthesisPrompt, [{ role: 'user', content: 'Synthesise the board consultation.' }]);

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
    const script = await askClaude(welcomeScriptPrompt, [{ role: 'user', content: 'Write the welcome script now. Maximum 22 words — hard limit, must be under 10 seconds spoken.' }]);
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
    const script = await askClaude(scriptPrompt, [{ role: 'user', content: 'Generate the video script now.' }]);
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
  const { persona, messages, ai } = req.body;
  if (!persona || !messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing persona or messages' });
  }
  try {
    let reply;
    const model = ai || 'claude';
    if (model === 'chatgpt') reply = await askChatGPT(persona, messages);
    else if (model === 'gemini') reply = await askGemini(persona, messages);
    else reply = await askClaude(persona, messages);
    res.json({ reply, ai: model });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Internal board auto-match (no auth — /board is password-gated at UI level) ──
app.post('/api/board-match', async (req, res) => {
  const { challenge, directors } = req.body;
  if (!challenge || !directors || !directors.length) {
    return res.status(400).json({ error: 'Missing challenge or director list' });
  }
  const matchPrompt = `A founder described this challenge: "${challenge}"

Here is the list of available board directors, each with their specialty:
${directors.map(d => `- ${d.id}: ${d.name} — ${d.role}`).join('\n')}

Pick the ONE director whose specialty best matches this challenge. Return ONLY the director's id, nothing else.`;
  try {
    const result = await askClaude(matchPrompt, [{ role: 'user', content: 'Which director id matches best?' }]);
    const matchedId = result.trim().toLowerCase().replace(/[^a-z]/g, '');
    const valid = directors.find(d => d.id === matchedId);
    res.json({ directorId: valid ? matchedId : directors[0].id });
  } catch (err) {
    console.error('Board match error:', err.message);
    res.json({ directorId: directors[0].id });
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

// ── Provider-agnostic entry point — swap the implementation here, nowhere else ──
async function researchSearch(query, options) {
  return tavilySearch(query, options);
}

// ── Run market/competitor research for a business, save sources, synthesize ──
async function runBusinessResearch(business, userId, scope = 'both', knownFacts = {}) {
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
      const results = await researchSearch(q, { maxResults: 4 });
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
    : `The client asked for NATIONAL research only. Only include competitors based in or primarily operating within ${country || 'the local market'} ("scope": "local"). Exclude international/global-only players even if they appear in search results.`;

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
${sourcesText.slice(0, 8000)}

YOUR TASK:
Produce a complete report based ONLY on the search results above and the known facts about ${bizName}: (1) full detailed market and competitor analysis, (2) a competitive gap comparison, (3) a summary and audit of research reliability, (4) recommendations broken into clear, structured sections — not one paragraph.

CRITICAL RULES:
- Every competitor and claim must be traceable to one of the numbered sources above — cite using the source number in "source_ref"
- ${scopeInstruction}
- If the search results don't clearly answer something, say so explicitly rather than guessing — do not invent competitor names, statistics, or facts not present above
- For "competitive_gaps": compare what competitors are shown doing/offering against what we know ${bizName} offers. Only list a gap if a specific competitor's description clearly shows something ${bizName}'s known facts do NOT mention. Do not guess at gaps with no evidence.
- Each recommendation must have a short title, a specific solution/strategy (1-2 sentences), and 2-4 concrete action steps — no vague advice
- The audit section must honestly assess coverage gaps, not just praise the findings

Return ONLY valid JSON, no markdown formatting, in exactly this structure:
{
  "market_context": "2-3 sentences on the overall market situation",
  "full_analysis": "A detailed 4-6 sentence analysis covering market dynamics, competitive intensity, and positioning implications for ${bizName} specifically",
  "local_coverage_note": "Only include this key if results were thin overall — explain what was actually found instead",
  "competitors": [
    {"name": "...", "description": "what they offer, one sentence", "differentiator": "their apparent edge or weakness", "scope": "local", "source_ref": "1"}
  ],
  "competitive_gaps": [
    {"gap": "specific thing competitors offer that ${bizName} does not appear to", "competitor_names": ["Name1","Name2"], "source_ref": "1"}
  ],
  "opportunity_gap": "The clearest gap or underserved angle this business could exploit",
  "audit_summary": "2-3 sentences honestly assessing how complete and reliable this research is",
  "audit_coverage": [
    {"area": "e.g. Local competitor pricing", "status": "covered|partial|not covered", "note": "brief explanation"}
  ],
  "strategic_recommendations": [
    {
      "title": "short 3-6 word recommendation title",
      "problem_addressed": "the specific gap or finding this responds to, one sentence",
      "solution": "the recommended solution or strategy, 1-2 sentences",
      "action_steps": ["concrete step 1", "concrete step 2", "concrete step 3"],
      "priority": "high|medium|low"
    }
  ]
}

List up to 8 competitors total${includeInternational ? ', aiming for a mix of local and international where results support it' : ' (national only)'}. Up to 4 competitive_gaps (omit the key entirely if none can be evidenced). Up to 4 strategic_recommendations, ranked by priority. Up to 4 audit_coverage rows. Omit "local_coverage_note" entirely if results were adequate.`;

  const raw = await askClaude(synthesisPrompt, [{ role: 'user', content: 'Produce the complete structured report now, as JSON only.' }], { feature: 'research_engine', userId }, 3500);
  let structured;
  try {
    structured = extractJSON(raw);
  } catch (e) {
    console.error('Research JSON parse failed. Length:', e.message, '| Response length:', raw.length, '| Last 300 chars:', raw.slice(-300));
    throw new Error('Could not parse market research — please try again');
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
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
    const limit = RESEARCH_LIMITS[plan] ?? 0;

    if (limit === 0) {
      return res.status(403).json({ error: 'Market research is available on Arreyon Pro and above.', upgradeRequired: true });
    }
    if (limit !== -1) {
      const usedThisMonth = await pool.query(
        `SELECT COUNT(*) FROM research_sessions WHERE user_id = $1
         AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
        [req.userId]
      );
      const used = parseInt(usedThisMonth.rows[0].count, 10);
      if (used >= limit) {
        return res.status(403).json({ error: `You've used your ${limit} research reports this month. Upgrade for more.`, upgradeRequired: true });
      }
    }

    const biz = await pool.query('SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
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
    const { summary, structured, sources, queries } = await runBusinessResearch(biz.rows[0], req.userId, requestedScope, knownFacts);

    const session = await pool.query(
      `INSERT INTO research_sessions (business_id, user_id, query, summary, scope, structured_data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.params.id, req.userId, queries.join(' | '), summary, requestedScope, JSON.stringify(structured)]
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
        verification = await runVerificationPass(structured, sources, req.userId);
        await pool.query('UPDATE research_sessions SET verification_data = $1 WHERE id = $2', [JSON.stringify(verification), sessionId]);
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
  try {
    const biz = await pool.query('SELECT id FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    const sessions = await pool.query(
      'SELECT * FROM research_sessions WHERE business_id = $1 ORDER BY created_at DESC', [req.params.id]
    );
    const sessionsWithSources = [];
    for (const session of sessions.rows) {
      const sources = await pool.query('SELECT * FROM research_sources WHERE research_session_id = $1', [session.id]);
      sessionsWithSources.push({ ...session, sources: sources.rows });
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

async function runVerificationPass(structured, sources, userId) {
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

  const raw = await askClaude(prompt, [{ role: 'user', content: 'Perform the verification pass now, as JSON only.' }], { feature: 'verification_engine', userId }, 2500);
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

    const verification = await runVerificationPass(sessionRow.structured_data, sourcesResult.rows, req.userId);

    await pool.query('UPDATE research_sessions SET verification_data = $1 WHERE id = $2', [JSON.stringify(verification), req.params.sessionId]);

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
        headers: { 'User-Agent': 'ArreyonConsultBot/1.0 (+https://consult.gdesignsme.com)' }
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
async function structureBusinessFacts(pages, submittedUrl, userId) {
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

  const fullPrompt = prompt + promptTail;
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
  const { url, description, businessName } = req.body;
  const hasUrl = url && url.trim();
  const hasDescription = description && description.trim().length >= 20;

  if (!hasUrl && !hasDescription) {
    return res.status(400).json({ error: 'Please provide a website URL, or describe your business in at least a few sentences.' });
  }

  try {
    const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.userId]);
    const plan = user.rows[0]?.plan || 'starter';
    const limit = ANALYZER_LIMITS[plan] ?? 1;

    if (limit !== -1) {
      const usedThisMonth = await pool.query(
        `SELECT COUNT(*) FROM ai_usage WHERE user_id = $1 AND feature = 'website_analyzer'
         AND date_trunc('month', created_at) = date_trunc('month', NOW())`,
        [req.userId]
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

    if (hasUrl) {
      normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = 'https://' + normalizedUrl;
      pages = await analyzeWebsite(normalizedUrl);
      sourceLabel = normalizedUrl;
    } else {
      // No website — treat the user's own description as the sole "page" to extract facts from
      pages = [{ url: 'User-provided description (no website)', title: businessName || '', description: '', bodyText: description.trim() }];
      sourceLabel = 'business description (no website)';
    }

    const facts = await structureBusinessFacts(pages, sourceLabel, req.userId);

    // Parse the AI-extracted location fact into city/country the research engine can use
    let parsedCity = null, parsedCountry = null;
    if (facts.location?.value) {
      const parts = facts.location.value.split(',').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) { parsedCity = parts[0]; parsedCountry = parts[parts.length - 1]; }
      else if (parts.length === 1) { parsedCountry = parts[0]; }
    }
    const parsedIndustry = facts.industry?.value || null;

    let businessId;
    if (normalizedUrl) {
      // URL path: reuse an existing business profile for this user + URL if one exists
      const existing = await pool.query(
        'SELECT id FROM businesses WHERE user_id = $1 AND website = $2 AND is_active = true LIMIT 1',
        [req.userId, normalizedUrl]
      );
      if (existing.rows.length) {
        businessId = existing.rows[0].id;
        await pool.query(
          `UPDATE businesses SET updated_at = NOW(),
           industry = COALESCE($2, industry), city = COALESCE($3, city), country = COALESCE($4, country)
           WHERE id = $1`,
          [businessId, parsedIndustry, parsedCity, parsedCountry]
        );
      } else {
        const inserted = await pool.query(
          `INSERT INTO businesses (user_id, name, website, industry, city, country) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.userId, businessName || facts.business_name?.value || normalizedUrl, normalizedUrl, parsedIndustry, parsedCity, parsedCountry]
        );
        businessId = inserted.rows[0].id;
      }
    } else {
      // Description-only path: no natural unique key, always create a fresh profile
      const inserted = await pool.query(
        `INSERT INTO businesses (user_id, name, website, industry, city, country) VALUES ($1, $2, NULL, $3, $4, $5) RETURNING id`,
        [req.userId, businessName || facts.business_name?.value || 'My Business', parsedIndustry, parsedCity, parsedCountry]
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
      facts
    });
  } catch (err) {
    console.error('Website analysis error:', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ── List user's analyzed businesses ─────────────────────────────────────────
app.get('/api/business', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, website, industry, created_at, updated_at FROM businesses WHERE user_id = $1 AND is_active = true ORDER BY updated_at DESC',
      [req.userId]
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
function buildReportHTML({ business, facts, structured: s, sources, scope }) {
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
<h2>Sources</h2>${sourcesHtml || '<p>No sources recorded.</p>'}
` : `<p style="margin-top:30px;color:#888"><em>Market research was not run for this business. Only the website analysis profile is included above.</em></p>`}
<div class="footer">Arreyon Consult by G-DESIGNS LTD · consult.gdesignsme.com · This report was AI-generated and should be independently verified before major business decisions.</div>
</body></html>`;
}

// ── PDF report (pdfkit — pure JS, no native/chromium dependency) ───────────
async function buildReportPDF({ business, facts, structured: s, sources, scope }) {
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
async function buildReportDOCX({ business, facts, structured: s, sources, scope }) {
  const bizName = business.name || business.website || 'Business Report';
  const purple = '6C3Bff';
  const children = [];

  children.push(new Paragraph({ text: bizName, heading: HeadingLevel.TITLE }));
  children.push(new Paragraph({
    children: [new TextRun({ text: `Business Intelligence Report · Generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} · Arreyon Consult by G-DESIGNS LTD`, italics: true, size: 18, color: '777777' })]
  }));
  children.push(new Paragraph({ text: '' }));

  function heading(text) { children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 })); }
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

  try {
    const biz = await pool.query('SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });
    const business = biz.rows[0];

    const factsResult = await pool.query(
      `SELECT DISTINCT ON (fact_key) fact_key, fact_value, source_type FROM business_facts
       WHERE business_id = $1 ORDER BY fact_key, created_at DESC`,
      [req.params.id]
    );
    const facts = {};
    factsResult.rows.forEach(r => { facts[r.fact_key] = { value: r.fact_value, source_type: r.source_type }; });

    const sessionResult = await pool.query(
      'SELECT * FROM research_sessions WHERE business_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.params.id]
    );
    let structured = null, sources = [], scope = 'both';
    if (sessionResult.rows.length) {
      const session = sessionResult.rows[0];
      structured = session.structured_data || null;
      scope = session.scope || 'both';
      const sourcesResult = await pool.query('SELECT * FROM research_sources WHERE research_session_id = $1', [session.id]);
      sources = sourcesResult.rows;
    }

    const reportData = { business, facts, structured, sources, scope };
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

  try {
    const result = await pool.query('SELECT * FROM entrepreneur_sessions WHERE id = $1 AND user_id = $2', [req.params.sessionId, req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = result.rows[0];
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
  try {
    const biz = await pool.query(
      'SELECT * FROM businesses WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]
    );
    if (!biz.rows.length) return res.status(404).json({ error: 'Business not found' });

    // Latest fact per key — DISTINCT ON gives current state; full history stays in the table
    const facts = await pool.query(
      `SELECT DISTINCT ON (fact_key) fact_key, fact_value, source_type, source_detail, created_at
       FROM business_facts WHERE business_id = $1
       ORDER BY fact_key, created_at DESC`,
      [req.params.id]
    );
    res.json({ business: biz.rows[0], facts: facts.rows });
  } catch (e) { res.status(500).json({ error: 'Failed to load business' }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAGE ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/auth/reset-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/boardroom', (req, res) => res.sendFile(path.join(__dirname, 'public', 'boardroom.html')));
app.get('/consult', (req, res) => res.sendFile(path.join(__dirname, 'public', 'consult.html')));
app.get('/board', (req, res) => res.sendFile(path.join(__dirname, 'public', 'board.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Arreyon Consult' }));

// ── START ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`Arreyon Consult running on port ${PORT}`);
});
