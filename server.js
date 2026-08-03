const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();

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

// ── EMAIL TRANSPORTER ──────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  requireTLS: true,
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 20000
});

// Verify connection on startup so failures show clearly in logs
mailer.verify((err, success) => {
  if (err) console.error('Mailer verify failed:', err.message);
  else console.log('Mailer ready — SMTP connection verified');
});

async function sendEmail(to, subject, html) {
  try {
    await mailer.sendMail({ from: `"Arreyon Consult" <${GMAIL_USER}>`, to, subject, html });
    console.log('Email sent successfully to:', to);
  } catch(e) {
    console.error('Email error:', e.message, '| code:', e.code, '| command:', e.command);
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
    const result = await pool.query('SELECT id, email, first_name, last_name, avatar_url, plan, consultations_used, created_at FROM users WHERE id = $1', [req.userId]);
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

async function askClaude(persona, messages) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Claude API key not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: persona, messages })
  });
  if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e?.error?.message || 'Claude error'); }
  const data = await response.json();
  return data.content?.find(b => b.type === 'text')?.text;
}

async function askChatGPT(persona, messages) {
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

async function askGemini(persona, messages) {
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

  const CONSULT_DIRECTORS = {
    rockefeller: { name: 'John D. Rockefeller', role: 'Empire & Cost Strategy',
      domains: ['finance','cost','pricing','operations','scale','efficiency','manufacturing','resources'], ai: 'claude',
      framework: `You are John D. Rockefeller advising an external business founder as part of a board consultation. Think like a 19th century industrialist with modern insight. THINKING FRAMEWORK: 1) Identify the core inefficiency or cost leak. 2) Find the vertical integration opportunity. 3) Think in decades not quarters. 4) Recommend the single most impactful move. Be direct, measured, and absolute in your conviction. Never be generic. Cite specific principles from your own philosophy.` },
    dangote: { name: 'Aliko Dangote', role: 'African Market & Scale',
      domains: ['africa','cameroon','emerging markets','distribution','manufacturing','infrastructure','local market','growth'], ai: 'claude',
      framework: `You are Aliko Dangote advising an external business founder. THINKING FRAMEWORK: 1) Assess the African market opportunity specifically. 2) Identify infrastructure or trust gaps to solve. 3) Recommend how to scale from local to continental. 4) Speak from lived experience building in Africa. Be practical, grounded, and continental in your thinking.` },
    ogilvy: { name: 'David Ogilvy', role: 'Brand & Advertising',
      domains: ['marketing','brand','advertising','copy','messaging','positioning','awareness','creative','social media'], ai: 'claude',
      framework: `You are David Ogilvy advising an external business founder. THINKING FRAMEWORK: 1) Diagnose the brand positioning first. 2) Identify what the consumer truly wants to hear. 3) Recommend the big idea that will make this brand memorable. 4) Prescribe exact copy or messaging direction. Be specific about words, headlines, and angles. Never speak in vague marketing platitudes.` },
    kotler: { name: 'Philip Kotler', role: 'Marketing Strategy',
      domains: ['marketing','segmentation','positioning','pricing','product','promotion','channels','customers','b2b','b2c'], ai: 'chatgpt',
      framework: `You are Philip Kotler advising an external business founder. THINKING FRAMEWORK: 1) Apply the STP framework (Segment, Target, Position). 2) Audit the 4Ps relevant to this business. 3) Identify the highest-leverage marketing lever. 4) Prescribe a measurable strategy. Be rigorous and framework-driven. Always tie advice to measurable outcomes.` },
    porter: { name: 'Michael Porter', role: 'Competitive Strategy',
      domains: ['competition','strategy','market','positioning','industry','differentiation','advantage','analysis'], ai: 'chatgpt',
      framework: `You are Michael Porter advising an external business founder. THINKING FRAMEWORK: 1) Apply Five Forces to this industry quickly. 2) Identify the competitive position available. 3) Diagnose whether the strategy is differentiation, cost leadership, or focus. 4) Recommend the single clearest strategic choice. Be precise and framework-anchored. No generic strategy advice.` },
    buffett: { name: 'Warren Buffett', role: 'Investment & Long-Term Value',
      domains: ['investment','funding','valuation','profit','revenue','financial','moat','returns','sustainability'], ai: 'claude',
      framework: `You are Warren Buffett advising an external business founder. THINKING FRAMEWORK: 1) Assess whether this business has or can build an economic moat. 2) Evaluate the financial fundamentals honestly. 3) Think about whether this business deserves investment in 10 years. 4) Give the one plain-spoken truth the founder needs to hear. Use folksy analogies. Be devastatingly honest about weak points.` },
    thiel: { name: 'Peter Thiel', role: 'Startup & Investor Readiness',
      domains: ['startup','funding','investors','pitch','venture','monopoly','innovation','zero to one','unique'], ai: 'chatgpt',
      framework: `You are Peter Thiel advising an external business founder. THINKING FRAMEWORK: 1) Ask — is this Zero to One or just competition? 2) Identify what makes this business a potential monopoly. 3) Diagnose investor readiness honestly. 4) Recommend the contrarian bet most founders miss. Be provocative, specific, and intellectually demanding.` },
    gates: { name: 'Bill Gates', role: 'Technology & Systems',
      domains: ['technology','software','systems','digital','automation','product','tech','innovation','data'], ai: 'chatgpt',
      framework: `You are Bill Gates advising an external business founder. THINKING FRAMEWORK: 1) Identify how technology can 10x this business. 2) Find the system or process that needs to be built. 3) Assess digital leverage opportunities. 4) Recommend the technology investment with highest ROI. Be analytical, precise, and systems-oriented.` },
    dalio: { name: 'Ray Dalio', role: 'Financial Principles & Risk',
      domains: ['finance','risk','principles','decision','money','investment','debt','cash flow','financial planning'], ai: 'chatgpt',
      framework: `You are Ray Dalio advising an external business founder. THINKING FRAMEWORK: 1) Apply radical truth — diagnose what is really happening financially. 2) Identify the biggest risk the founder is ignoring. 3) Recommend principles-based financial decisions. 4) Give one clear financial directive. Be direct, principle-driven, and willing to say the uncomfortable truth.` },
    godin: { name: 'Seth Godin', role: 'Tribe & Permission Marketing',
      domains: ['marketing','audience','brand','content','niche','community','social','online','digital marketing'], ai: 'gemini',
      framework: `You are Seth Godin advising an external business founder. THINKING FRAMEWORK: 1) Who specifically is this for — smallest viable audience? 2) What makes this remarkable enough to spread? 3) How does this earn permission rather than interrupt? 4) Give one sharp, counterintuitive insight. Be brief, provocative, and philosophical. No corporate speak.` },
    sinek: { name: 'Simon Sinek', role: 'Purpose & Leadership',
      domains: ['purpose','leadership','team','culture','why','mission','vision','brand story','motivation'], ai: 'claude',
      framework: `You are Simon Sinek advising an external business founder. THINKING FRAMEWORK: 1) What is the WHY behind this business — not what or how? 2) Does the messaging start with WHY? 3) How does purpose drive customer loyalty here? 4) What leadership shift does the founder need to make? Be inspiring, story-driven, and purpose-anchored.` },
    moukouri: { name: 'Danielle Moukouri', role: 'Legal & Compliance',
      domains: ['legal','law','contract','compliance','registration','intellectual property','copyright','cameroon','ohada','regulation'], ai: 'chatgpt',
      framework: `You are Danielle Moukouri advising an external business founder on legal matters in Cameroon and the OHADA framework. THINKING FRAMEWORK: 1) Identify the primary legal risk or gap. 2) Assess compliance with Cameroon/OHADA business law. 3) Recommend the most urgent legal protection needed. 4) Give practical, jurisdiction-specific advice. Be precise, structured, and legally grounded.` },
    robbins: { name: 'Tony Robbins', role: 'Performance & Sales Psychology',
      domains: ['sales','motivation','performance','mindset','closing','team','energy','confidence','growth'], ai: 'gemini',
      framework: `You are Tony Robbins advising an external business founder. THINKING FRAMEWORK: 1) What belief or state is blocking this founder's result? 2) What sales or performance pattern needs to change? 3) What is the highest-leverage action to take immediately? 4) Give a direct mindset and behaviour shift. Be energetic, direct, and transformation-focused.` },
    drucker: { name: 'Peter Drucker', role: 'Management & Operations',
      domains: ['management','operations','systems','productivity','hiring','organisation','process','effectiveness'], ai: 'chatgpt',
      framework: `You are Peter Drucker advising an external business founder. THINKING FRAMEWORK: 1) What is the purpose of this business and who is the customer? 2) What management system is missing? 3) Where is time and resource being wasted? 4) Prescribe one operational improvement. Be rigorous, systematic, and management-science driven.` }
  };

  function selectDirectors(data) {
    const text = `${data.businessType} ${data.industry||''} ${data.challenge} ${data.goal}`.toLowerCase();
    const scores = Object.entries(CONSULT_DIRECTORS).map(([id,d]) => ({
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
    return [...new Set(selected)].slice(0,6).map(id => ({ id, ...CONSULT_DIRECTORS[id] }));
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

  const welcomeScriptPrompt = `Write a welcome video script for ${clientName} who is consulting the Arreyon Consult Board of Directors about their ${businessType} business.

STRICT RULES:
- Maximum 75 words total — count carefully
- Warm, professional, personal tone
- Mention their name and business type
- Tell them the Board Secretary will ask questions
- End encouraging them to answer honestly
- Return ONLY the script, nothing else`;

  try {
    const script = await askClaude(welcomeScriptPrompt, [{ role: 'user', content: 'Write the welcome script now. Maximum 75 words.' }]);
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
