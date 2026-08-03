-- ── ARREYON CONSULT DATABASE SCHEMA ──────────────────────────────────────

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  google_id VARCHAR(255) UNIQUE,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(50),
  country VARCHAR(100),
  avatar_url TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  verification_token VARCHAR(255),
  verification_expires TIMESTAMPTZ,
  reset_token VARCHAR(255),
  reset_expires TIMESTAMPTZ,
  plan VARCHAR(50) DEFAULT 'starter',
  role VARCHAR(20) DEFAULT 'user',
  consultations_used INTEGER DEFAULT 0,
  consultations_reset_date TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Admin users table
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Plans/Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(50) NOT NULL,
  billing_cycle VARCHAR(20) DEFAULT 'monthly',
  status VARCHAR(50) DEFAULT 'active',
  amount_usd DECIMAL(10,2),
  amount_cfa INTEGER,
  payment_method VARCHAR(100),
  payment_reference VARCHAR(255),
  coupon_code VARCHAR(50),
  discount_percent INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plan VARCHAR(50) NOT NULL,
  billing_cycle VARCHAR(20) DEFAULT 'monthly',
  amount_usd DECIMAL(10,2),
  amount_cfa INTEGER,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_method VARCHAR(100),
  payment_reference VARCHAR(255),
  payer_name VARCHAR(255),
  payer_email VARCHAR(255),
  payer_phone VARCHAR(50),
  payer_country VARCHAR(100),
  coupon_code VARCHAR(50),
  discount_percent INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  proof_url TEXT,
  admin_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ
);

-- Consultations table
CREATE TABLE IF NOT EXISTS consultations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255),
  business_type VARCHAR(255),
  industry VARCHAR(255),
  status VARCHAR(50) DEFAULT 'active',
  directors_used JSONB,
  report_text TEXT,
  synthesis TEXT,
  video_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Messages table (consultation conversation history)
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id UUID REFERENCES consultations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  director_id VARCHAR(100),
  ai_model VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Coupon codes table
CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  description VARCHAR(255),
  discount_percent INTEGER NOT NULL,
  applies_to VARCHAR(50) DEFAULT 'all',
  max_uses INTEGER,
  used_count INTEGER DEFAULT 0,
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Announcements table
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'info',
  show_as_banner BOOLEAN DEFAULT TRUE,
  show_as_popup BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CMS Content table (all editable landing page content)
CREATE TABLE IF NOT EXISTS cms_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section VARCHAR(100) NOT NULL,
  key VARCHAR(100) NOT NULL,
  value TEXT NOT NULL,
  type VARCHAR(50) DEFAULT 'text',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(section, key)
);

-- Team members table (for Business plan)
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  member_email VARCHAR(255) NOT NULL,
  member_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'invited',
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ
);

-- Sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── DEFAULT CMS CONTENT ────────────────────────────────────────────────────
INSERT INTO cms_content (section, key, value, type) VALUES
-- Hero section
('hero', 'headline', 'Your AI Consultant and Board of Directors. Available 24/7.', 'text'),
('hero', 'subheadline', 'Arreyon Consult convenes 29 legendary business minds around your challenge. Get boardroom-grade strategy, analysis, and a report you can act on.', 'text'),
('hero', 'cta_primary', 'Start Free', 'text'),
('hero', 'cta_secondary', 'See How It Works', 'text'),
('hero', 'social_proof', 'Trusted by founders across Africa and beyond', 'text'),

-- About section
('about', 'headline', 'Twenty-nine legendary minds. One strategic verdict.', 'text'),
('about', 'description', 'Arreyon Consult assembles the greatest business minds in history — from Rockefeller to Buffett to Ogilvy — and briefs them on your specific business. Each advisor brings a unique discipline. Together, they deliver a synthesis you can act on immediately.', 'text'),

-- How it works
('how_it_works', 'headline', 'Three steps to boardroom-grade advice', 'text'),
('how_it_works', 'step1_title', 'Brief your board', 'text'),
('how_it_works', 'step1_desc', 'Fill in your business details. Our Board Secretary asks targeted questions to understand your situation deeply.', 'text'),
('how_it_works', 'step2_title', 'The board convenes', 'text'),
('how_it_works', 'step2_desc', 'Arreyon automatically selects the most relevant directors and each one delivers their unique strategic perspective.', 'text'),
('how_it_works', 'step3_title', 'Get your verdict', 'text'),
('how_it_works', 'step3_desc', 'Receive a structured report with executive summary, board insights, risk analysis, and a 90-day action plan.', 'text'),

-- Pricing
('pricing', 'headline', 'Simple, transparent pricing', 'text'),
('pricing', 'subheadline', 'Start free. Upgrade when you need more.', 'text'),
('pricing', 'starter_name', 'Starter', 'text'),
('pricing', 'starter_price_usd', '0', 'text'),
('pricing', 'starter_price_cfa', '0', 'text'),
('pricing', 'starter_description', 'For founders exploring AI-powered strategic advice', 'text'),
('pricing', 'pro_name', 'Arreyon Pro', 'text'),
('pricing', 'pro_price_usd', '35', 'text'),
('pricing', 'pro_price_usd_annual', '28', 'text'),
('pricing', 'pro_price_cfa', '20125', 'text'),
('pricing', 'pro_price_cfa_annual', '16100', 'text'),
('pricing', 'pro_description', 'For serious founders who need regular strategic guidance', 'text'),
('pricing', 'business_name', 'Arreyon Business', 'text'),
('pricing', 'business_price_usd', '150', 'text'),
('pricing', 'business_price_usd_annual', '120', 'text'),
('pricing', 'business_price_cfa', '86250', 'text'),
('pricing', 'business_price_cfa_annual', '69000', 'text'),
('pricing', 'business_description', 'For teams and growing organisations that need unlimited access', 'text'),

-- CTA section
('cta', 'headline', 'Bring your hardest decision to the board', 'text'),
('cta', 'subheadline', 'Your first consultation is free. No credit card required.', 'text'),
('cta', 'button', 'Convene Your Board', 'text'),

-- Footer
('footer', 'tagline', 'Learn. Create. Innovate.', 'text'),
('footer', 'copyright', '2026 Arreyon Consult by G-DESIGNS LTD. All rights reserved.', 'text')

ON CONFLICT (section, key) DO NOTHING;

-- ── DEFAULT ADMIN USER ──────────────────────────────────────────────────────
-- Password will be set via the server on first run
