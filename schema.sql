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
  preferred_language VARCHAR(5) DEFAULT 'en',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) DEFAULT 'en';

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
  value_fr TEXT,
  type VARCHAR(50) DEFAULT 'text',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(section, key)
);
ALTER TABLE cms_content ADD COLUMN IF NOT EXISTS value_fr TEXT;

-- Team members table (for Business plan)
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  member_email VARCHAR(255) NOT NULL,
  member_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(50) DEFAULT 'invited', -- 'invited' | 'active' | 'removed'
  invite_token VARCHAR(255) UNIQUE,
  invite_token_expires_at TIMESTAMPTZ,
  permissions JSONB DEFAULT '{"boardroom":true,"analyzer":true,"entrepreneur":true,"financial":true,"scenario":true,"history":true}',
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ
);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS invite_token VARCHAR(255) UNIQUE;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS invite_token_expires_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{"boardroom":true,"analyzer":true,"entrepreneur":true,"financial":true,"scenario":true,"history":true}';
CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(owner_id);
CREATE INDEX IF NOT EXISTS idx_team_members_token ON team_members(invite_token);

-- users.team_owner_id: when set, this user is a team member operating under
-- that owner's account — their plan limits, consultation usage, and director
-- access all resolve to the OWNER's record, not their own. NULL means this
-- user is a normal account (or a team owner themselves).
ALTER TABLE users ADD COLUMN IF NOT EXISTS team_owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_users_team_owner ON users(team_owner_id);

-- Sessions table
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(500) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- BUSINESS INTELLIGENCE LAYER — Increment 1
-- ═══════════════════════════════════════════════════════════════════════════

-- AI usage log — every AI call, for cost visibility and future rate limiting
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID,
  feature VARCHAR(100) NOT NULL,
  provider VARCHAR(50) NOT NULL,
  model VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  status VARCHAR(20) DEFAULT 'success',
  error_message TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- Business profiles — persistent memory, one per business, scoped to owning user
CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255),
  website VARCHAR(500),
  industry VARCHAR(255),
  country VARCHAR(100),
  region VARCHAR(100),
  city VARCHAR(100),
  currency VARCHAR(10),
  business_model VARCHAR(100),
  stage VARCHAR(50),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_businesses_user ON businesses(user_id);

-- Business facts — every known fact tagged by source, so fact/inference/assumption never blur
CREATE TABLE IF NOT EXISTS business_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  fact_key VARCHAR(100) NOT NULL,
  fact_value TEXT,
  fact_value_fr TEXT,
  source_type VARCHAR(20) NOT NULL, -- 'user_provided' | 'observed' | 'inferred' | 'research'
  source_detail TEXT,
  confidence VARCHAR(10), -- 'high' | 'medium' | 'low', only for inferred/research facts
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE business_facts ADD COLUMN IF NOT EXISTS fact_value_fr TEXT;
CREATE INDEX IF NOT EXISTS idx_business_facts_business ON business_facts(business_id);

-- Research sessions — one row per research query run against a business
CREATE TABLE IF NOT EXISTS research_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  provider VARCHAR(50) DEFAULT 'tavily',
  status VARCHAR(20) DEFAULT 'completed',
  summary TEXT,
  scope VARCHAR(20) DEFAULT 'both',
  structured_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Safe additive migration for deployments where this table already existed pre-upgrade
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'both';
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS structured_data JSONB;
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS verification_data JSONB;
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS structured_data_fr JSONB;
ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS verification_data_fr JSONB;

-- Entrepreneur Mode — Increment 5. Separate from businesses/business_facts since
-- this is for people who don't have a business yet (no site to analyze, no
-- existing profile to build on).
CREATE TABLE IF NOT EXISTS entrepreneur_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  mode VARCHAR(30) NOT NULL, -- 'opportunity_finder' | 'idea_validation'
  input_data JSONB NOT NULL,
  structured_output JSONB,
  research_backed BOOLEAN DEFAULT FALSE,
  discussion_messages JSONB DEFAULT '[]',
  business_plan JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS discussion_messages JSONB DEFAULT '[]';
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS business_plan JSONB;
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS structured_output_fr JSONB;
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS business_plan_fr JSONB;
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS discussion_messages_fr JSONB;
CREATE INDEX IF NOT EXISTS idx_entrepreneur_sessions_user ON entrepreneur_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_research_sessions_business ON research_sessions(business_id);

-- Research sources — every source retrieved for a research session, for citation
CREATE TABLE IF NOT EXISTS research_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  research_session_id UUID REFERENCES research_sessions(id) ON DELETE CASCADE,
  title VARCHAR(500),
  url TEXT NOT NULL,
  snippet TEXT,
  published_date VARCHAR(50),
  retrieved_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_sources_session ON research_sources(research_session_id);

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

-- Contact section
('contact', 'headline', 'Get in touch', 'text'),
('contact', 'subheadline', 'We are here to help. Reach out through any of the channels below.', 'text'),
('contact', 'phone', '+237 675 781 517', 'text'),
('contact', 'email_primary', 'info@gdesignsme.com', 'text'),
('contact', 'email_secondary', 'gdesignsme@gmail.com', 'text'),
('contact', 'location', 'Buea, Cameroon & Dubai, UAE', 'text'),

-- Testimonials
('testimonials', 'headline', 'Real advice. Real results.', 'text'),
('testimonials', 'testimonial1_text', 'I asked Rockefeller and Buffett about my pricing strategy. The report they generated was more actionable than advice I paid a consultant $500 for.', 'text'),
('testimonials', 'testimonial1_name', 'Kwame Nkrumah-Asante', 'text'),
('testimonials', 'testimonial1_role', 'Founder, TechStart Ghana', 'text'),
('testimonials', 'testimonial2_text', 'The Board Secretary asked better questions than most investors I have pitched to. By the time I saw the report, I already knew what to do.', 'text'),
('testimonials', 'testimonial2_name', 'Amina Ibrahim', 'text'),
('testimonials', 'testimonial2_role', 'CEO, Lagos Fashion Co.', 'text'),
('testimonials', 'testimonial3_text', 'Having Dangote and Porter analyse my Cameroon market entry strategy at 11pm, for free, is something I still cannot believe is real.', 'text'),
('testimonials', 'testimonial3_name', 'Bernard Etame', 'text'),
('testimonials', 'testimonial3_role', 'Founder, DigiCam Solutions', 'text'),

-- FAQ
('faq', 'headline', 'Frequently asked questions', 'text'),
('faq', 'q1_question', 'How is Arreyon Consult different from ChatGPT?', 'text'),
('faq', 'q1_answer', 'Arreyon Consult is purpose-built for strategic business advice. Instead of a single AI, you get 29 specialised directors who debate your challenge and deliver a synthesised verdict.', 'text'),
('faq', 'q2_question', 'Can I use it from Africa?', 'text'),
('faq', 'q2_answer', 'Yes. Arreyon Consult was built with African founders in mind. Payment via MTN MoMo is supported. Several directors are specifically tuned for African market dynamics.', 'text'),
('faq', 'q3_question', 'How does payment work?', 'text'),
('faq', 'q3_answer', 'We accept MTN MoMo (Cameroon) and international bank transfer via WhatsApp. Our team manually verifies and activates your plan within 24 hours.', 'text'),
('faq', 'q4_question', 'Is my consultation data private?', 'text'),
('faq', 'q4_answer', 'Yes. Your consultations are private to your account. We do not share your business information with third parties or use it to train AI models.', 'text'),
('faq', 'q5_question', 'What happens when I hit my consultation limit?', 'text'),
('faq', 'q5_answer', 'Your limit resets at the start of each calendar month. You can upgrade your plan at any time for more consultations immediately.', 'text'),

-- Stats bar
('stats', 'stat1_number', '29', 'text'),
('stats', 'stat1_label', 'Legendary Advisors', 'text'),
('stats', 'stat2_number', '24/7', 'text'),
('stats', 'stat2_label', 'Always Available', 'text'),
('stats', 'stat3_number', '<60s', 'text'),
('stats', 'stat3_label', 'Average Response Time', 'text'),
('stats', 'stat4_number', '3 AI', 'text'),
('stats', 'stat4_label', 'Models Combined', 'text'),

-- Features section
('features', 'headline', 'A full AI business intelligence platform', 'text'),
('features', 'feature1_title', 'Website Business Analyzer', 'text'),
('features', 'feature1_desc', 'Paste your website and Arreyon reads it automatically — extracting your positioning, offers, and gaps, clearly labeled as observed fact or AI inference.', 'text'),
('features', 'feature2_title', 'Real Market & Competitor Research', 'text'),
('features', 'feature2_desc', 'Live web research finds your local and international competitors, with every claim cited to a real source — not invented statistics.', 'text'),
('features', 'feature3_title', 'Verification Pass', 'text'),
('features', 'feature3_desc', 'Every recommendation is stress-tested against the evidence before you see it — the board argues against itself first, so you don''t have to.', 'text'),
('features', 'feature4_title', 'Chairman''s Board Verdict', 'text'),
('features', 'feature4_desc', 'After talking with multiple directors, get one final synthesized decision — disagreements named openly, not smoothed over.', 'text'),
('features', 'feature5_title', 'Entrepreneur Mode', 'text'),
('features', 'feature5_desc', 'No business yet? Get opportunities matched to your skills and capital, or a straight VALIDATE / MODIFY / RECONSIDER verdict on your idea.', 'text'),
('features', 'feature6_title', 'Full Business Plan & Downloads', 'text'),
('features', 'feature6_desc', 'Business model, marketing plan, and a 90-day execution plan — generated and downloadable as PDF, Word, or HTML.', 'text'),

-- Pricing feature bullet lists (one per line, shown exactly as written)
('pricing', 'starter_features', '3 consultations per month
5 starter directors
Board Secretary Q&A
Basic board report
3 core financial calculators
Website Analyzer (1 scan/month)
Entrepreneur Mode & Scenario Comparison
1 team member', 'textarea'),
('pricing', 'pro_features', '10 consultations per month
All 29 directors
Report download (PDF)
Full consultation history
Full financial calculator suite (10 tools)
Market Research & Website Analyzer (5-10/month)
Research-backed Entrepreneur Mode
2 team members
Priority email support
Board Secretary deep-dive', 'textarea'),
('pricing', 'business_features', 'Unlimited consultations
All 29 directors
PDF + Word download
Video report (HeyGen)
Full financial calculator suite (10 tools)
Unlimited Market Research & Website Analyzer
Research-backed Entrepreneur Mode
5 team members
Custom AI director personas
Priority WhatsApp support
Full consultation history', 'textarea'),

-- Footer
('footer', 'tagline', 'Learn. Create. Innovate.', 'text'),
('footer', 'copyright', '2026 Arreyon Consult by G-DESIGNS LTD. All rights reserved.', 'text')

ON CONFLICT (section, key) DO NOTHING;

-- One-time refresh: the "features" section originally described the platform
-- before the Business Intelligence upgrade (Website Analyzer, Research,
-- Verification, Entrepreneur Mode, etc). This updates only rows still holding
-- that old default text — any admin customization already in place is left
-- untouched, since the WHERE clause only matches the exact old value.
UPDATE cms_content SET value = 'A full AI business intelligence platform' WHERE section='features' AND key='headline' AND value='Everything you need for strategic clarity';
UPDATE cms_content SET value = 'Website Business Analyzer' WHERE section='features' AND key='feature1_title' AND value='Auto Director Matching';
UPDATE cms_content SET value = 'Paste your website and Arreyon reads it automatically — extracting your positioning, offers, and gaps, clearly labeled as observed fact or AI inference.' WHERE section='features' AND key='feature1_desc' AND value='Describe your challenge and get matched instantly with the most relevant director — or browse and pick manually.';
UPDATE cms_content SET value = 'Real Market & Competitor Research' WHERE section='features' AND key='feature2_title' AND value='Live Board Conversation';
UPDATE cms_content SET value = 'Live web research finds your local and international competitors, with every claim cited to a real source — not invented statistics.' WHERE section='features' AND key='feature2_desc' AND value='Real back-and-forth dialogue with each director. They ask follow-up questions and adapt to your specific answers.';
UPDATE cms_content SET value = 'Verification Pass' WHERE section='features' AND key='feature3_title' AND value='Structured Report';
UPDATE cms_content SET value = 'Every recommendation is stress-tested against the evidence before you see it — the board argues against itself first, so you don''t have to.' WHERE section='features' AND key='feature3_desc' AND value='Executive summary, board insights, risk analysis, and a 90-day action plan — all in one downloadable report.';
UPDATE cms_content SET value = 'Chairman''s Board Verdict' WHERE section='features' AND key='feature4_title' AND value='Video Presentation';
UPDATE cms_content SET value = 'After talking with multiple directors, get one final synthesized decision — disagreements named openly, not smoothed over.' WHERE section='features' AND key='feature4_desc' AND value='Get a personalised video presentation of your board key recommendations — optimised for your device.';
UPDATE cms_content SET value = 'Entrepreneur Mode' WHERE section='features' AND key='feature5_title' AND value='Consultation History';
UPDATE cms_content SET value = 'No business yet? Get opportunities matched to your skills and capital, or a straight VALIDATE / MODIFY / RECONSIDER verdict on your idea.' WHERE section='features' AND key='feature5_desc' AND value='Full replay of every consultation — conversation, report, and video — stored securely in your dashboard.';
UPDATE cms_content SET value = 'Full Business Plan & Downloads' WHERE section='features' AND key='feature6_title' AND value='Three AI Models';
UPDATE cms_content SET value = 'Business model, marketing plan, and a 90-day execution plan — generated and downloadable as PDF, Word, or HTML.' WHERE section='features' AND key='feature6_desc' AND value='Claude, ChatGPT, and Gemini — each director is matched with the AI that best fits their thinking style.';

-- Pricing feature lists: reflect the new Financial Tools tiering and corrected
-- team seat counts (Pro is 2 total seats including the owner, Business is 5).
-- Only overwrites if the value still matches the original seed text below —
-- if you've since edited these in the CMS editor, this will NOT clobber that.
UPDATE cms_content SET value = '3 consultations per month
5 starter directors
Board Secretary Q&A
Basic board report
3 core financial calculators
Website Analyzer (1 scan/month)
Entrepreneur Mode & Scenario Comparison
1 team member', value_fr = NULL WHERE section='pricing' AND key='starter_features' AND value='3 consultations per month
5 starter directors
Board Secretary Q&A
Basic board report
3 core financial calculators
1 team member';

UPDATE cms_content SET value = '10 consultations per month
All 29 directors
Report download (PDF)
Full consultation history
Full financial calculator suite (10 tools)
Market Research & Website Analyzer (5-10/month)
Research-backed Entrepreneur Mode
2 team members
Priority email support
Board Secretary deep-dive', value_fr = NULL WHERE section='pricing' AND key='pro_features' AND value='10 consultations per month
All 29 directors
Report download (PDF)
Full consultation history
Full financial calculator suite (10 tools)
2 team members
Priority email support
Board Secretary deep-dive';

UPDATE cms_content SET value = 'Unlimited consultations
All 29 directors
PDF + Word download
Video report (HeyGen)
Full financial calculator suite (10 tools)
Unlimited Market Research & Website Analyzer
Research-backed Entrepreneur Mode
5 team members
Custom AI director personas
Priority WhatsApp support
Full consultation history', value_fr = NULL WHERE section='pricing' AND key='business_features' AND value='Unlimited consultations
All 29 directors
PDF + Word download
Video report (HeyGen)
Full financial calculator suite (10 tools)
5 team members
Custom AI director personas
Priority WhatsApp support
Full consultation history';

-- ═══════════════════════════════════════════════════════════════════════════
-- GOOGLE ANALYTICS INTEGRATION
-- One connection per account (team-shared, like businesses/research) — the
-- account owner connects it, the whole team can see the data. Tokens are
-- refreshed automatically; the property_id is which GA4 property to pull from.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS google_analytics_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  ga_account_name VARCHAR(255),
  property_id VARCHAR(50),
  property_name VARCHAR(255),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ga_connections_owner ON google_analytics_connections(owner_id);

-- Recent metric snapshots — used both to display trend charts and as the
-- baseline the monitoring system compares against to detect meaningful
-- changes (traffic/conversion drops, etc.)
CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES google_analytics_connections(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  sessions INTEGER,
  users INTEGER,
  conversions INTEGER,
  conversion_rate NUMERIC(6,3),
  bounce_rate NUMERIC(6,3),
  avg_session_duration_sec INTEGER,
  top_source VARCHAR(255),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_analytics_snapshots_connection ON analytics_snapshots(connection_id, snapshot_date DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- AUTONOMOUS MONITORING & ALERTS
-- A background job periodically checks each account's business metrics
-- (from Analytics), competitor landscape (from the latest Market Research),
-- and team activity, and creates an alert row when something crosses a
-- meaningful threshold. Alerts are also emailed once, then marked as sent.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS monitoring_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  alert_type VARCHAR(50) NOT NULL, -- 'metrics_change' | 'competitor_change' | 'team_activity'
  severity VARCHAR(20) DEFAULT 'info', -- 'info' | 'warning' | 'critical'
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  details JSONB,
  is_read BOOLEAN DEFAULT FALSE,
  email_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_monitoring_alerts_owner ON monitoring_alerts(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitoring_alerts_unread ON monitoring_alerts(owner_id, is_read) WHERE is_read = FALSE;

-- Per-account alert preferences — lets owners turn off a category they don't
-- want emailed about, without losing the in-app alert entirely.
CREATE TABLE IF NOT EXISTS monitoring_preferences (
  owner_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  metrics_alerts_enabled BOOLEAN DEFAULT TRUE,
  competitor_alerts_enabled BOOLEAN DEFAULT TRUE,
  team_activity_alerts_enabled BOOLEAN DEFAULT TRUE,
  email_alerts_enabled BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 1 — BUSINESS WORKSPACE FOUNDATION (Step 1)
-- Extending the existing `businesses` table rather than creating a parallel
-- concept, per the Database Architecture audit's canonical-concept guidance.
-- These are additive, nullable/defaulted columns — no existing query against
-- `businesses` is affected by their presence. Nothing reads or writes them
-- yet; that begins in Step 2 onward.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS goals JSONB DEFAULT '[]';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS challenges JSONB DEFAULT '[]';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS opportunities JSONB DEFAULT '[]';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS strategy_summary TEXT;

-- Step 2: optional link from an Entrepreneur Mode session to a persistent
-- business — nullable, so every existing session (which predates this
-- column) is entirely unaffected. Unlike research_sessions (which has always
-- linked to a business), entrepreneur_sessions previously existed as
-- orphaned sessions with no such connection.
ALTER TABLE entrepreneur_sessions ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entrepreneur_sessions_business ON entrepreneur_sessions(business_id) WHERE business_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 2 — INTELLIGENCE UPGRADE (Step 2)
-- Stores the AI-generated qualitative analysis (SWOT, priority problems,
-- critical bottleneck, and AI-inferred scores) separately from
-- businesses.goals/challenges/opportunities — those are generic fields any
-- future source (user input, a different feature) might populate; this is
-- specifically the output of one AI analysis pass, with its own timestamp so
-- the UI can show "as of" and future logic can decide whether to regenerate.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS intelligence_snapshot JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS intelligence_snapshot_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS intelligence_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 3 — GROWTH CENTER (Step 1)
-- A dedicated table, not another JSONB field on businesses — an objective has
-- its own lifecycle (active/achieved/abandoned) and needs real numeric
-- tracking (starting/current/target), unlike the simpler free-form
-- goals/challenges fields added in Phase 1. starting_value is captured once,
-- at creation, and never changes — it's the fixed baseline the progress
-- percentage is measured against, regardless of which direction the goal
-- moves (growth targets and reduction targets, e.g. "cut costs", use the
-- exact same math correctly).
-- current_value is user-reported, not automatically tracked — there's no
-- connected revenue/accounting source of truth, so asking the founder to
-- periodically update it themselves is the honest choice here, consistent
-- with never fabricating progress the platform doesn't actually know.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS growth_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  metric_name VARCHAR(255) NOT NULL,
  unit VARCHAR(20),
  starting_value NUMERIC(14,2) NOT NULL,
  current_value NUMERIC(14,2) NOT NULL,
  target_value NUMERIC(14,2) NOT NULL,
  target_date DATE,
  status VARCHAR(20) DEFAULT 'active', -- active | achieved | abandoned
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_growth_objectives_business ON growth_objectives(business_id, status);

-- Phase 3, Step 2 — the AI-generated priorities and 30/60/90 plan for this
-- specific objective. Same bilingual cache discipline as intelligence_snapshot.
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS strategic_plan JSONB;
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS strategic_plan_fr JSONB;
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS strategic_plan_generated_at TIMESTAMPTZ;

-- The user-chosen timeframe the current strategic_plan was built for — lets
-- the plan structure itself flex (monthly-ish checkpoints across however
-- long the founder actually wants to plan for) instead of a fixed 30/60/90
-- day structure regardless of how far out the goal really is.
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS plan_start_date DATE;
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS plan_end_date DATE;

-- Every progress check-in, kept as its own row — growth_objectives.current_value
-- only ever holds the LATEST figure, overwritten on each update, so a "progress
-- over time" chart needs its own history rather than trying to reconstruct it
-- from a column that doesn't retain the past.
CREATE TABLE IF NOT EXISTS growth_progress_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID REFERENCES growth_objectives(id) ON DELETE CASCADE,
  value NUMERIC(14,2) NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_growth_progress_history_objective ON growth_progress_history(objective_id, recorded_at);

-- Smaller checkpoints along the way to the bigger goal. target_value is
-- optional — some milestones are numeric ("reach 250K"), others are events
-- with no number ("launch the new product"), tracked by manually checking
-- them off. achieved_at doubles as both the achievement flag and its
-- timestamp, rather than a separate boolean.
CREATE TABLE IF NOT EXISTS growth_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  objective_id UUID REFERENCES growth_objectives(id) ON DELETE CASCADE,
  label VARCHAR(255) NOT NULL,
  target_value NUMERIC(14,2),
  target_date DATE,
  achieved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_growth_milestones_objective ON growth_milestones(objective_id, created_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 4 — ACTION CENTER (Step 1)
-- source/source_detail track provenance (a manually-typed task vs. one
-- created from a Business Intelligence priority problem or a Growth Center
-- plan action) — not required for the task to function, but useful context
-- if a user later wonders "where did this come from."
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS action_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  priority VARCHAR(20) DEFAULT 'medium', -- high | medium | low
  status VARCHAR(20) DEFAULT 'not_started', -- not_started | in_progress | done
  due_date DATE,
  category VARCHAR(50),
  source VARCHAR(50) DEFAULT 'manual', -- manual | business_intelligence | growth_center
  source_detail TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_action_tasks_business ON action_tasks(business_id, status);

-- Same "translate once, cache, never regenerate" discipline as everywhere
-- else — task titles coming from AI suggestions (Business Intelligence,
-- Growth Center) carry whatever language they were generated in, with no
-- bilingual support at all until now.
ALTER TABLE action_tasks ADD COLUMN IF NOT EXISTS title_fr TEXT;
ALTER TABLE action_tasks ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES users(id) ON DELETE SET NULL;

-- Longer free-text detail beyond the title — mainly so the person a task is
-- assigned to actually knows what to do, not just a short label. Same
-- translate-once-and-cache pattern already used for title_fr.
ALTER TABLE action_tasks ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE action_tasks ADD COLUMN IF NOT EXISTS description_fr TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 5 — MARKET + COMPETITOR INTELLIGENCE (Step 1: Named Competitor Tracking)
-- Distinct from the AI-inferred competitors already surfaced during a
-- general business analysis — these are specific competitors the user names
-- themselves and tracks over time, each with an optional AI-generated
-- positioning comparison against their own business.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tracked_competitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  website VARCHAR(500),
  notes TEXT,
  positioning_analysis JSONB,
  positioning_analysis_fr JSONB,
  last_analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tracked_competitors_business ON tracked_competitors(business_id);

-- Step 2: Market Context — broader industry-level intelligence (market size,
-- growth trend, seasonality) as opposed to Step 1's specific named
-- competitors. One snapshot per business, same translate-once-and-cache
-- pattern as intelligence_snapshot.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS market_context JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS market_context_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS market_context_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 7 — MARKETING & SALES (Step 1: Standalone Marketing Strategy)
-- Same marketing_plan shape already produced inside a full Business Plan
-- generation, but as its own regenerable feature tied directly to a
-- business — no need to run the full business-plan flow just to get
-- marketing help. Same translate-once-and-cache pattern as everywhere else.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_strategy JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_strategy_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS marketing_strategy_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 7 — MARKETING & SALES (Step 2: Content Calendar / Campaign Planner)
-- One regenerable calendar per business, same pattern as Market Context —
-- a content calendar is inherently tied to a specific timeframe the user
-- picks each time (like Growth Center's plan), not something needing its
-- own historical table for a first version.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_calendar JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_calendar_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_calendar_generated_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_calendar_start_date DATE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS content_calendar_end_date DATE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 7 — MARKETING & SALES (Step 3: Simple Lead Tracking)
-- Deliberately NOT a CRM, per the brief's explicit instruction — just enough
-- to track a prospective client and get reminded to follow up. A lead's
-- next_follow_up_date drives a real Action Center task (linked via
-- action_tasks.lead_id, kept in sync rather than duplicated on every edit)
-- and an overdue reminder through the existing Alerts sweep.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  contact_info VARCHAR(255),
  phone VARCHAR(50),
  status VARCHAR(20) DEFAULT 'new', -- new | contacted | qualified | won | lost
  next_follow_up_date DATE,
  notes TEXT,
  overdue_alert_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id, status);

ALTER TABLE action_tasks ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id) ON DELETE SET NULL;
ALTER TABLE monitoring_preferences ADD COLUMN IF NOT EXISTS lead_alerts_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 8 — BUSINESS PLAN + FUNDING (Step 2: Funding Readiness Score)
-- The score itself and its breakdown are deterministic, computed from
-- objective signals already tracked elsewhere (has a plan, has verified
-- financials, tracks growth, etc.) — never an AI-invented number. Only the
-- qualitative strengths/gaps/next-steps are AI-generated, grounded in the
-- computed breakdown. Same translate-once-and-cache pattern as everywhere else.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS funding_readiness JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS funding_readiness_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS funding_readiness_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 8 — BUSINESS PLAN + FUNDING (Step 3: Investor Materials)
-- A structured, slide-by-slide pitch deck outline — not an actual .pptx
-- file, since no presentation-generation library exists in this project and
-- adding one is a bigger dependency decision than reusing docx, which is
-- already proven here. Downloadable as an editable Word document instead.
-- Its financial slide references whatever verified numbers already exist
-- (from the business plan or funding readiness) rather than duplicating
-- the projection calculators that already exist in Financial Tools.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pitch_deck JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pitch_deck_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS pitch_deck_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 8 — BUSINESS PLAN + FUNDING (Step 4: Share)
-- One share token per business. When set, an unauthenticated visitor with
-- the link can view a read-only combined view of the business's plan,
-- funding readiness, and pitch deck outline — the natural "investor
-- package" a founder would want to send as a single link. Revoking sharing
-- clears the token, immediately invalidating any link already sent out.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS share_created_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_businesses_share_token ON businesses(share_token) WHERE share_token IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 9 — REPORTS + ALERTS + OPPORTUNITY RADAR (Step 1: Marketing Alerts)
-- Tracks when each marketing-related alert was last sent per business, so
-- a stale condition re-reminds periodically rather than firing daily or
-- only once and being forgotten — same reasoning as the lead follow-up
-- alert's cadence in Phase 7.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS calendar_gap_alert_sent_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS stale_strategy_alert_sent_at TIMESTAMPTZ;
ALTER TABLE monitoring_preferences ADD COLUMN IF NOT EXISTS marketing_alerts_enabled BOOLEAN DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 9 — REPORTS + ALERTS + OPPORTUNITY RADAR (Step 2: Growth Alerts)
-- Same per-condition cadence tracking as Marketing Alerts — behind_schedule
-- and no-checkin are independent conditions, tracked separately so one
-- being recently alerted doesn't suppress the other.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS behind_schedule_alert_sent_at TIMESTAMPTZ;
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS no_checkin_alert_sent_at TIMESTAMPTZ;
ALTER TABLE monitoring_preferences ADD COLUMN IF NOT EXISTS growth_alerts_enabled BOOLEAN DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 9 — REPORTS + ALERTS + OPPORTUNITY RADAR (Step 4: Opportunity Radar)
-- Reuses the existing monitoring_alerts table and createAlert() plumbing —
-- severity has no database constraint, so a new 'opportunity' value needs
-- no migration — rather than building a parallel storage/display system for
-- what is, mechanically, still just an alert with a different tone.
-- funding_readiness_band tracks the LAST SURFACED band so only a genuine
-- crossing into a stronger band re-alerts, not merely staying there.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS funding_readiness_last_band VARCHAR(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS market_opportunity_radar_sent_at TIMESTAMPTZ;
ALTER TABLE growth_objectives ADD COLUMN IF NOT EXISTS ahead_schedule_alert_sent_at TIMESTAMPTZ;
ALTER TABLE tracked_competitors ADD COLUMN IF NOT EXISTS opportunity_radar_sent_at TIMESTAMPTZ;
ALTER TABLE monitoring_preferences ADD COLUMN IF NOT EXISTS opportunity_radar_enabled BOOLEAN DEFAULT TRUE;

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 10 — INTEGRATIONS (Step 1: Google Search Console)
-- One connection per account, owned and managed by the account owner only,
-- shared by the whole team — same model as google_analytics_connections,
-- deliberately not a per-team-member connection. Requires the Search
-- Console API enabled on the same Google Cloud project already used for
-- Analytics, and a new authorized redirect URI added there — a one-time
-- setup step in Google Cloud Console this server cannot do on its own.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS google_search_console_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  site_url VARCHAR(500),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gsc_connections_owner ON google_search_console_connections(owner_id);

-- Same reasoning as analytics_snapshots — daily figures kept for trend
-- display and as the baseline the monitoring system compares against.
CREATE TABLE IF NOT EXISTS search_console_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES google_search_console_connections(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  clicks INTEGER,
  impressions INTEGER,
  ctr NUMERIC(6,3),
  avg_position NUMERIC(6,2),
  top_query VARCHAR(500),
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_search_console_snapshots_connection ON search_console_snapshots(connection_id, snapshot_date DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 10 — INTEGRATIONS (Step 2: HubSpot CRM)
-- One connection per account, owned and managed by the account owner only,
-- same model as the Google integrations. A separate OAuth client from the
-- Google ones — HubSpot's own client ID/secret, obtained via HubSpot's
-- CLI-based app creation (their web-form app creation was discontinued),
-- but the runtime OAuth flow itself is the standard authorization-code
-- flow this server already implements the same way for Google.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS hubspot_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  hub_id VARCHAR(50),
  hub_domain VARCHAR(255),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_hubspot_connections_owner ON hubspot_connections(owner_id);

-- Same reasoning as the Google snapshot tables — daily figures kept for
-- trend display and as a baseline the monitoring system could compare
-- against later.
CREATE TABLE IF NOT EXISTS hubspot_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES hubspot_connections(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  contacts_count INTEGER,
  deals_count INTEGER,
  open_deals_value NUMERIC(14,2),
  deals_won_count INTEGER,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_hubspot_snapshots_connection ON hubspot_snapshots(connection_id, snapshot_date DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 10 — INTEGRATIONS (Step 3: Zoho Books)
-- One connection per account, owned and managed by the account owner only,
-- same model as the other integrations. Zoho hosts accounts across separate
-- regional data centers, so accounts_server (for token refresh) and
-- api_domain (for data calls) are stored per-connection rather than
-- hardcoded, since a wrong region here produces silent authentication
-- failures rather than an obvious error. Also requires an organization
-- selection step, like Google Analytics' property step, since one Zoho
-- login can have multiple separate organizations/businesses under it.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS zoho_books_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  accounts_server VARCHAR(255) NOT NULL,
  api_domain VARCHAR(255) NOT NULL,
  organization_id VARCHAR(50),
  organization_name VARCHAR(255),
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_zoho_books_connections_owner ON zoho_books_connections(owner_id);

-- Same reasoning as the other integrations' snapshot tables — daily figures
-- kept for trend display and as a baseline the monitoring system could
-- compare against later.
CREATE TABLE IF NOT EXISTS zoho_books_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES zoho_books_connections(id) ON DELETE CASCADE,
  snapshot_date DATE NOT NULL,
  total_receivables NUMERIC(14,2),
  total_payables NUMERIC(14,2),
  open_invoices_count INTEGER,
  overdue_invoices_count INTEGER,
  raw_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_zoho_books_snapshots_connection ON zoho_books_snapshots(connection_id, snapshot_date DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- DASH-04 — Boardroom Insight synthesis on Dashboard
-- Chairman Synthesis (/api/board/synthesize) was previously generated and
-- returned live with nothing saved — there was nothing to surface on the
-- Dashboard because no record of it existed. This persists each one so the
-- most recent can be shown. Boardroom sessions aren't linked to a specific
-- tracked business (confirmed — the synthesize endpoint receives no
-- business_id), so this is scoped to the account (owner_id) only, matching
-- how the Home dashboard itself is account-level rather than business-specific.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS chairman_syntheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  core_problem TEXT,
  chairman_verdict TEXT,
  confidence VARCHAR(10),
  director_count INTEGER,
  full_synthesis JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chairman_syntheses_owner ON chairman_syntheses(owner_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- BUSINESS X-RAY (Phase 2 completion — consolidates BI-01, BI-04, BX-01, BX-02)
-- Rather than 4 separate, overlapping numeric-score features, this single
-- feature covers all of them: 8 axis scores (AI-assessed) plus one overall
-- health score computed deterministically as their average, not asked of
-- the AI separately — this guarantees the overall number always agrees
-- with the axes it's supposedly summarizing, rather than risking a
-- confusing mismatch between two independently-generated numbers.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_xray JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_xray_fr JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_xray_generated_at TIMESTAMPTZ;

-- ═══════════════════════════════════════════════════════════════════════════
-- SUBSCRIPTION LIFECYCLE — start/end dates, expiry notifications, and a
-- 1-month free trial for starter accounts. Stored directly on users
-- (rather than only in the existing subscriptions table, which is written
-- once at payment approval but never read back anywhere) so the most
-- common check — "has this plan expired?" — needs no join.
--
-- 'expired' is a new, explicit plan value, distinct from 'starter'. A
-- lapsed free trial or a lapsed paid subscription both land here rather
-- than silently reverting to starter — an honest locked state that
-- prompts the user to subscribe, rather than quietly downgrading them to
-- limited free access as if that were the normal outcome.
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expiry_notified_at TIMESTAMPTZ;

-- Backfill for accounts that existed before this feature: a fresh 1-month
-- grace period starting now, not retroactively computed from their
-- original signup date — the latter would instantly lock out long-time
-- free users the moment this ships, which is a real, avoidable disruption
-- rather than a deliberate policy choice.
UPDATE users SET plan_started_at = NOW(), plan_expires_at = NOW() + INTERVAL '1 month'
WHERE plan = 'starter' AND plan_expires_at IS NULL;

-- ── DEFAULT ADMIN USER ──────────────────────────────────────────────────────
-- Password will be set via the server on first run

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 8 / INCREMENT 1 — Website Intelligence & Control: connection + read-only
--
-- Scoped to business_id (not account-wide like the Google/HubSpot/Zoho
-- connections), since a website belongs to a specific Business Workspace,
-- not the Arreyon account as a whole. Deliberately no UNIQUE(business_id)
-- constraint — the spec asks for the data model to support multiple
-- websites per business in the future, and adding that later would need
-- a migration to drop a constraint that never should have existed; this
-- increment's own code only ever creates one connection at a time, but
-- the schema itself doesn't foreclose more.
--
-- wp_app_password_encrypted is genuinely encrypted at rest (AES-256-GCM,
-- see encryptSecret()/decryptSecret() in server.js), not just relying on
-- database access control — unlike the OAuth tokens for other
-- integrations, a WordPress Application Password is a long-lived, static
-- credential with no rotation from Arreyon's side, closer to a raw API
-- key than a short-lived, provider-revocable OAuth token, so it warrants
-- that extra layer.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS website_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider VARCHAR(50) DEFAULT 'wordpress',
  site_url TEXT NOT NULL,
  site_name VARCHAR(255),
  wp_version VARCHAR(20),
  wp_username VARCHAR(255) NOT NULL,
  wp_app_password_encrypted TEXT NOT NULL,
  connection_status VARCHAR(20) DEFAULT 'pending', -- 'connected' | 'needs_attention' | 'auth_expired' | 'disconnected' | 'error'
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  -- Permission tier and automation switch — not enforced until Increment 2/3
  -- (permissions + execution), but included now so the connection UI can
  -- collect the choice from the start rather than needing a later
  -- migration to add it once execution features exist.
  permission_level VARCHAR(20) DEFAULT 'read_only', -- 'read_only' | 'draft' | 'approval_required' | 'managed'
  automation_mode VARCHAR(20) DEFAULT 'manual', -- 'manual' | 'automatic' — low-risk actions only; destructive actions always require approval regardless of this switch
  -- Real, deliberate, separate switch from automation_mode above — this
  -- one specifically governs the full content-creation agent (writing
  -- and publishing new blog posts), a genuinely different, higher-stakes
  -- capability than the low-risk metadata auto-execution automation_mode
  -- already covers. Off by default; a person must explicitly turn this
  -- on for a specific, trusted site.
  content_automation_enabled BOOLEAN DEFAULT FALSE,
  -- 'draft' (default, safer): a new post is always created as a real
  -- WordPress draft, still requiring a human to actually publish it.
  -- 'publish': a new post goes live immediately once generated, with no
  -- further human review — a real, explicit, separate choice from
  -- content_automation_enabled itself, not implied by it.
  content_automation_publish_mode VARCHAR(20) DEFAULT 'draft',
  -- 'daily' (default) | 'weekly' | 'monthly' — how often the automatic
  -- content cycle runs for this specific connection, when enabled.
  content_automation_frequency VARCHAR(20) DEFAULT 'daily',
  content_automation_last_run_at TIMESTAMPTZ,
  -- 'push' (default): Arreyon calls the site's REST API directly,
  -- real-time. 'poll': the site's own plugin calls Arreyon instead and
  -- executes changes locally via native WordPress functions — the
  -- fallback for sites where an inbound request from Arreyon is
  -- blocked before it ever reaches WordPress (e.g. Cloudflare Bot
  -- Fight Mode on the free tier, which cannot be bypassed by any rule
  -- at all), since a site's own outbound request to Arreyon is never
  -- subject to that same protection.
  connection_mode VARCHAR(20) DEFAULT 'push',
  -- SHA-256, not bcrypt — deliberately deterministic. Unlike a
  -- user's chosen password, this is a full 32-byte random value, so a
  -- fast, deterministic hash is secure at this entropy level while
  -- also enabling a real, indexed WHERE lookup by hash. bcrypt's
  -- salted, non-deterministic output can only ever be verified
  -- against one already-known record — it can't be looked up this
  -- way at all, which would mean comparing every poll-mode
  -- connection's hash against every incoming poll request.
  polling_token_hash TEXT,
  -- Real, deliberate cache for a poll-mode connection's own reported
  -- page/post content (title, meta description, word count, etc.) —
  -- a poll-mode site's own plugin gathers this locally and reports it
  -- back, since a direct read from Arreyon is blocked the same way a
  -- direct write is (the reason the connection is in poll mode at
  -- all). pending_content_request_at marks that a fresh report has
  -- been asked for and is awaiting the site's next scheduled check-in.
  pending_content_request_at TIMESTAMPTZ,
  cached_wp_content JSONB,
  cached_wp_content_at TIMESTAMPTZ,
  website_intelligence JSONB,
  website_intelligence_fr JSONB,
  website_intelligence_generated_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_connections_business ON website_connections(business_id);

-- A genuine audit trail — nothing equivalent existed anywhere in the
-- platform to reuse ("history" elsewhere means past AI consultation
-- sessions, not an action-level log with actor/detail). Logs read-only
-- events from this increment onward (connected, intelligence generated),
-- not just future write actions, so the log has real content from day
-- one rather than sitting empty until execution features ship.
CREATE TABLE IF NOT EXISTS website_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  actor_type VARCHAR(20) NOT NULL, -- 'user' | 'ai_agent' | 'system'
  actor_id UUID, -- the user's id when actor_type = 'user'; NULL otherwise
  action_type VARCHAR(50) NOT NULL,
  description TEXT NOT NULL,
  details JSONB,
  -- Real, deliberate feature tag (e.g. 'seo_proposals', 'taxonomy',
  -- 'broken_links', 'featured_images', 'intelligence', 'connection',
  -- 'general') — lets the activity log be viewed and cleared per real
  -- feature rather than as one single, undifferentiated list.
  feature VARCHAR(50) NOT NULL DEFAULT 'general',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_audit_log_connection ON website_audit_log(website_connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_audit_log_feature ON website_audit_log(website_connection_id, feature);

-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE 8 / INCREMENT 2 — Website Action Engine (spec Section 21): the
-- generic proposal/approval record every future agent action flows
-- through. Deliberately does NOT store a snapshot of permission_level —
-- the spec is explicit that "the execution layer must independently
-- enforce permissions... never trust an AI agent simply because it
-- requested an action," so Increment 3's execution step re-checks
-- website_connections.permission_level LIVE at execution time, not
-- whatever it happened to be when the proposal was created.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS website_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  ai_agent VARCHAR(50) NOT NULL, -- 'seo_agent' for now; 'webmaster_agent' | 'content_agent' in later increments
  action_type VARCHAR(50) NOT NULL, -- 'update_meta_title' | 'update_meta_description' (more types added as agents grow)
  target_type VARCHAR(20) NOT NULL, -- 'page' | 'post'
  target_wp_id INTEGER NOT NULL, -- the WordPress post/page ID
  target_url TEXT,
  target_title TEXT, -- for display without re-fetching WordPress just to label the row
  previous_state JSONB, -- the real, measured current value(s) this proposes to change
  proposed_change JSONB NOT NULL, -- the AI's suggested new value(s)
  reasoning TEXT, -- why the AI suggests this, shown to the user before they approve
  edited_change JSONB, -- set if the user edited the proposal before approving (spec section 9/12: preview, approve, reject, EDIT)
  approval_status VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  -- Populated by Increment 3, which adds real WordPress write capability.
  -- Left here now so the schema doesn't need another migration once
  -- execution ships, and so the frontend can render an honest "not yet
  -- executed" state rather than one built without a real column for it.
  execution_status VARCHAR(20) DEFAULT 'not_executed', -- 'not_executed' | 'executing' | 'queued_for_poll' | 'executed' | 'execution_failed' — 'queued_for_poll' is poll-mode connections only: approved and waiting for the site's own plugin to pick it up and execute it locally on its next check-in
  verification_status VARCHAR(20), -- 'verified' | 'verification_failed' | 'manually_confirmed' — 'verified' is an automated re-check catching up; 'manually_confirmed' is the user's own word after checking their live site themselves, kept as a distinct, honest value rather than blurred into 'verified'
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_actions_connection ON website_actions(website_connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_website_actions_pending ON website_actions(website_connection_id, approval_status) WHERE approval_status = 'pending';

-- Real, deliberate local record of every post the SEO Agent has actually
-- created on WordPress — distinct from website_actions (which tracks
-- proposed CHANGES to something that already exists) since a generated
-- blog post is a genuinely new, already-created real thing from the
-- moment it's made, not a pending proposal. Lets a generated post be
-- seen, edited, and published from within Arreyon itself, not only by
-- visiting the connected site directly.
CREATE TABLE IF NOT EXISTS website_generated_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  wp_post_id INTEGER NOT NULL,
  topic TEXT,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  body_html TEXT NOT NULL,
  meta_title TEXT,
  meta_description TEXT,
  focus_keyword TEXT,
  category TEXT,
  tags JSONB,
  featured_image_generated BOOLEAN DEFAULT FALSE,
  -- Real, mirrored status — kept in sync with the real, live WordPress
  -- post's own real status on every real read/edit/publish here, never
  -- treated as more authoritative than what WordPress itself reports.
  status VARCHAR(20) DEFAULT 'draft', -- 'draft' | 'publish'
  wp_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_generated_posts_connection ON website_generated_posts(website_connection_id, created_at DESC);

-- Real, deliberate single record per audit cycle — ties together
-- Website Intelligence, SEO proposals, taxonomy proposals, duplicate-title
-- proposals, and broken-link detection into one real, timestamped report,
-- rather than the person having to piece it together from separate
-- feature-by-feature results. The individual real actions this run
-- generates still land in website_actions and website_audit_log as
-- always — this table is the aggregate summary of one real run, not a
-- replacement for either.
CREATE TABLE IF NOT EXISTS website_audit_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  triggered_by VARCHAR(20) NOT NULL, -- 'manual' | 'automatic'
  status VARCHAR(20) DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  issues_found_count INTEGER DEFAULT 0,
  auto_fixed_count INTEGER DEFAULT 0,
  pending_approval_count INTEGER DEFAULT 0,
  findings_summary JSONB, -- structured breakdown by category, for the report view
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_website_audit_runs_connection ON website_audit_runs(website_connection_id, started_at DESC);

-- Real, deliberate AI-visibility tracking — each row is one real query
-- actually sent to a real, search-grounded AI model (Perplexity's
-- sonar), with its real answer and real citations checked for whether
-- this specific business was actually mentioned or cited. This is the
-- feedback loop the rest of the SEO/AEO/GEO work never had: writing
-- content optimized for AI citation is one thing, actually checking
-- whether it worked is another, and this is that check.
CREATE TABLE IF NOT EXISTS website_ai_visibility_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  mentioned_by_name BOOLEAN DEFAULT FALSE,
  cited_by_domain BOOLEAN DEFAULT FALSE,
  answer_excerpt TEXT, -- the real, actual answer text returned, for a person to read in context
  citations JSONB, -- the real list of URLs Perplexity actually cited for this query
  checked_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_ai_visibility_connection ON website_ai_visibility_checks(website_connection_id, checked_at DESC);

-- Real, deliberate real keyword-level ranking data, pulled directly from
-- Google's own Search Console API (never scraped, never estimated) —
-- one row per real, actual search query Google itself reports this real
-- site already appearing for, with its real position/clicks/impressions
-- on the real snapshot date. Historical rows are kept (not overwritten)
-- so a real trend can be shown over time.
CREATE TABLE IF NOT EXISTS website_keyword_rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr NUMERIC(6,3),
  avg_position NUMERIC(6,2),
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(website_connection_id, query, snapshot_date)
);
CREATE INDEX IF NOT EXISTS idx_website_keyword_rankings_connection ON website_keyword_rankings(website_connection_id, snapshot_date DESC);

-- Real, deliberate technical SEO snapshots — real Lighthouse lab data from
-- Google's own PageSpeed Insights API (always present) plus real Chrome
-- user field data when the site has enough real traffic for Google to
-- report it (most small-business sites won't), and a real robots.txt
-- check. Scoped to business_id, not a specific CMS connection, since
-- this applies equally to WordPress or Shopify.
CREATE TABLE IF NOT EXISTS website_technical_seo_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  performance_score INTEGER,
  seo_score INTEGER,
  accessibility_score INTEGER,
  lcp_ms INTEGER, -- lab data, always present
  cls_score NUMERIC(6,3), -- lab data, always present
  tbt_ms INTEGER, -- lab data proxy for INP, always present
  field_data_available BOOLEAN DEFAULT FALSE,
  field_lcp_category VARCHAR(20),
  field_cls_category VARCHAR(20),
  field_inp_category VARCHAR(20),
  robots_txt_exists BOOLEAN DEFAULT FALSE,
  robots_txt_blocks_everything BOOLEAN DEFAULT FALSE,
  robots_txt_references_sitemap BOOLEAN DEFAULT FALSE,
  top_issues JSONB,
  checked_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_technical_seo_business ON website_technical_seo_checks(business_id, checked_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- SHOPIFY INTEGRATION — stage 1 (connect, read, create content with real SEO
-- fields). Deliberately scoped to this foundation first, the same real
-- incremental path the WordPress integration itself took, rather than
-- attempting the full audit/proposal/automation richness WordPress has in
-- one pass. One connection per real business, the same real shape as
-- website_connections, since a Shopify store is the same real conceptual
-- unit as a WordPress site.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS shopify_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
  shop_domain VARCHAR(255) NOT NULL, -- e.g. 'mystore.myshopify.com'
  access_token_encrypted TEXT NOT NULL,
  scope VARCHAR(500),
  blog_id BIGINT, -- the shop's default blog, resolved once at connect time
  connection_status VARCHAR(20) DEFAULT 'connected', -- 'connected' | 'disconnected' | 'auth_expired'
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  website_intelligence JSONB,
  website_intelligence_fr JSONB,
  website_intelligence_generated_at TIMESTAMPTZ,
  content_automation_enabled BOOLEAN DEFAULT FALSE,
  content_automation_publish_mode VARCHAR(20) DEFAULT 'draft', -- 'draft' (safer, default) | 'publish'
  content_automation_frequency VARCHAR(20) DEFAULT 'daily', -- 'daily' | 'weekly' | 'monthly'
  content_automation_last_run_at TIMESTAMPTZ,
  -- Real, deliberate visible outcome of the real, last automatic attempt
  -- — without this, a real failure (an expired token, a Shopify API
  -- error, anything) updates last_run_at and then goes completely
  -- invisible, indistinguishable from a real, successful run with
  -- nothing new to say. This is what makes that distinction visible.
  content_automation_last_run_status VARCHAR(20), -- 'success' | 'failed'
  content_automation_last_run_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_shopify_connections_business ON shopify_connections(business_id);
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS website_intelligence JSONB;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS website_intelligence_fr JSONB;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS website_intelligence_generated_at TIMESTAMPTZ;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_publish_mode VARCHAR(20) DEFAULT 'draft';
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_frequency VARCHAR(20) DEFAULT 'daily';
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_last_run_status VARCHAR(20);
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_last_run_error TEXT;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS content_automation_last_run_at TIMESTAMPTZ;

-- Real, deliberate local record, the same real reason website_generated_posts
-- exists — so a real generated article is visible, editable, and trackable
-- from within Arreyon, not only by visiting Shopify's own admin directly.
CREATE TABLE IF NOT EXISTS shopify_generated_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_connection_id UUID REFERENCES shopify_connections(id) ON DELETE CASCADE,
  shopify_article_id BIGINT NOT NULL,
  topic TEXT,
  title TEXT NOT NULL,
  handle TEXT NOT NULL, -- Shopify's real equivalent of a WordPress slug
  body_html TEXT NOT NULL,
  meta_title TEXT,
  meta_description TEXT,
  tags TEXT,
  status VARCHAR(20) DEFAULT 'draft', -- 'draft' | 'published' — mirrors Shopify's own real article.published state
  article_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopify_generated_posts_connection ON shopify_generated_posts(shopify_connection_id, created_at DESC);

-- Real, deliberate parallel to website_actions, never a forced reuse of it —
-- Shopify's own real IDs, own real resource types (article | page, no
-- WordPress-style category/tag taxonomy actions, since Shopify has no real
-- equivalent), and a deliberately leaner approval flow: propose, approve,
-- execute, reject. No re-verification or manual-confirm states yet — a
-- disclosed, honest scope boundary for this first real version.
CREATE TABLE IF NOT EXISTS shopify_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_connection_id UUID REFERENCES shopify_connections(id) ON DELETE CASCADE,
  action_type VARCHAR(50) NOT NULL, -- 'update_meta_title' | 'update_meta_description' | 'remove_broken_link'
  target_type VARCHAR(20) NOT NULL, -- 'article' | 'page'
  target_shopify_id BIGINT NOT NULL,
  target_url TEXT,
  target_title TEXT,
  previous_state JSONB,
  proposed_change JSONB NOT NULL,
  reasoning TEXT,
  approval_status VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  execution_status VARCHAR(20) DEFAULT 'not_executed', -- 'not_executed' | 'executed' | 'execution_failed'
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopify_actions_connection ON shopify_actions(shopify_connection_id, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTENT CALENDAR — planning several specific future posts on specific
-- real dates, genuinely separate from the automatic daily/weekly cycle
-- (which picks its own topic each time it runs). A real topic here is
-- optional: left blank, the real daily sweep below picks one the same
-- way the automatic cycle already does. Scoped to business_id, not a
-- specific CMS connection, since one real calendar covers whichever
-- platform each entry is actually for.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_calendar_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL, -- 'wordpress' | 'shopify'
  scheduled_date DATE NOT NULL,
  scheduled_time TIME NOT NULL DEFAULT '09:00:00', -- the real, specific time this real entry is due, not just a date
  automation_rule_id UUID, -- NULL for a manually-added entry; set when a real recurring rule generated this real entry, so editing or cancelling that rule can find and remove only its own real, still-pending future entries
  topic TEXT, -- NULL means "pick a topic automatically on the day", same as the automatic cycle already does
  publish_mode VARCHAR(20) DEFAULT 'draft', -- 'draft' | 'publish' — this real entry's own real action, independent of any other entry's
  status VARCHAR(20) DEFAULT 'scheduled', -- 'scheduled' | 'processing' (claimed by a sweep; processed_at is the claim time, and a claim older than 30 min is treated as a crashed sweep and retried) | 'generated' | 'failed' | 'cancelled' | 'missed' (due while the platform was in Manual mode: not written, kept until the person dismisses it)
  generated_title TEXT,
  generated_url TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_content_calendar_business ON content_calendar_entries(business_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_content_calendar_due ON content_calendar_entries(status, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_content_calendar_rule ON content_calendar_entries(automation_rule_id);
ALTER TABLE content_calendar_entries ADD COLUMN IF NOT EXISTS scheduled_time TIME NOT NULL DEFAULT '09:00:00';
ALTER TABLE content_calendar_entries ADD COLUMN IF NOT EXISTS automation_rule_id UUID;

-- Real, deliberate recurring rule, genuinely separate from a single
-- manually-added entry — a real rule exists to GENERATE real calendar
-- entries ahead of time (below), rather than being checked itself at
-- run time. The calendar is the one real, single source of truth for
-- what's actually going to happen; a rule is just what produced some of
-- those real rows.
-- Real, deliberate second real design here — the original per-slot-time
-- model (content_automation_rule_slots below) was replaced by two real,
-- directly-set controls instead: how many real posts per real period,
-- and how many real hours apart. The old table is left in place, unused,
-- rather than dropped, since nothing real depends on removing it.
CREATE TABLE IF NOT EXISTS content_automation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL, -- 'wordpress' | 'shopify'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  frequency_period VARCHAR(20) DEFAULT 'daily', -- 'daily' | 'weekly' | 'monthly' — how often one real batch of posts fires
  posts_per_period INTEGER DEFAULT 1, -- how many real posts in each real batch
  hours_between_posts INTEGER DEFAULT 3, -- real spacing between posts within one real batch
  start_time TIME DEFAULT '09:00:00', -- the real time of day the FIRST post of each real batch goes out; later posts in that batch are offset from this by hours_between_posts
  publish_mode VARCHAR(20) DEFAULT 'draft', -- 'draft' | 'publish' — one real action for every real post this rule creates
  enabled BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_automation_rules_business ON content_automation_rules(business_id);
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS frequency_period VARCHAR(20) DEFAULT 'daily';
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS posts_per_period INTEGER DEFAULT 1;
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS hours_between_posts INTEGER DEFAULT 3;
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS start_time TIME DEFAULT '09:00:00';
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS publish_mode VARCHAR(20) DEFAULT 'draft';

-- Real, deliberate legacy table — superseded by the direct controls
-- above, kept only so nothing breaks for any real row that might
-- already reference it; no longer written to by new rules.
CREATE TABLE IF NOT EXISTS content_automation_rule_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES content_automation_rules(id) ON DELETE CASCADE,
  time_of_day TIME NOT NULL,
  publish_mode VARCHAR(20) DEFAULT 'draft' -- 'draft' | 'publish'
);
CREATE INDEX IF NOT EXISTS idx_content_automation_rule_slots_rule ON content_automation_rule_slots(rule_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- BACKLINK OPPORTUNITIES — real, external, legitimately earnable links:
-- real directories, real guest-post-friendly blogs, and real existing brand
-- mentions that don't yet link back. Arreyon finds where a real link could
-- honestly be earned; it never creates the link itself or exchanges links
-- between clients here — that is the separate, explicitly opt-in reciprocal
-- system. Scoped to the business directly, not a specific CMS connection,
-- since a backlink points at the business's own site regardless of which
-- platform (WordPress, Shopify, or none yet) it runs on.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS backlink_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  opportunity_type VARCHAR(20) NOT NULL, -- 'directory' | 'guest_post' | 'unlinked_mention'
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  contact_email TEXT, -- a real email found on the real page itself, when one genuinely exists — never guessed or invented
  status VARCHAR(20) DEFAULT 'new', -- 'new' | 'contacted' | 'acquired' | 'dismissed'
  found_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id, url)
);
CREATE INDEX IF NOT EXISTS idx_backlink_opportunities_business ON backlink_opportunities(business_id, found_at DESC);
ALTER TABLE backlink_opportunities ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- RECIPROCAL LINK NETWORK — the explicitly opt-in system, genuinely
-- separate from the external-opportunity finder above. A real link from
-- one real client's content to another real client's site only ever
-- happens when BOTH real businesses have explicitly opted in — never one-
-- sided, never silent, never automatic for a business that hasn't agreed.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reciprocal_network_opt_ins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE UNIQUE,
  opted_in BOOLEAN DEFAULT FALSE,
  opted_in_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Real, deliberate record of every real link actually placed — the audit
-- trail that lets a business see exactly who has ever linked to them and
-- who they have ever linked to, and what lets the matching logic enforce
-- a real cap rather than linking the same two real businesses repeatedly.
CREATE TABLE IF NOT EXISTS reciprocal_links_placed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  to_business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  from_post_title TEXT,
  from_post_url TEXT,
  to_url TEXT NOT NULL,
  relevance_reason TEXT, -- the real, specific reason the AI judged this pairing genuinely relevant, kept for a real person to review, not just trusted blindly
  placed_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reciprocal_links_from ON reciprocal_links_placed(from_business_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_reciprocal_links_to ON reciprocal_links_placed(to_business_id, placed_at DESC);

-- Real, deliberate reporting path — the one thing a business could do
-- before now was wait for you to notice a bad match yourself; this lets
-- the business on either side of a real placement flag it directly,
-- closing the real gap the admin oversight panel alone couldn't close.
CREATE TABLE IF NOT EXISTS reciprocal_link_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id UUID REFERENCES reciprocal_links_placed(id) ON DELETE CASCADE,
  reported_by_business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  reason TEXT,
  status VARCHAR(20) DEFAULT 'open', -- 'open' | 'resolved'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reciprocal_link_reports_placement ON reciprocal_link_reports(placement_id);
CREATE INDEX IF NOT EXISTS idx_reciprocal_link_reports_status ON reciprocal_link_reports(status, created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- Arreyon Connect plugin — connection-code handshake (Option 2). WordPress
-- initiates here (the reverse of the existing paste-a-credential flow):
-- Arreyon generates a short-lived code and shows it; the plugin, once the
-- person enters that code in their WordPress admin, generates its own
-- Application Password internally and sends it back to Arreyon along with
-- the code. Codes expire and are single-use so a leaked or guessed code
-- can't be replayed indefinitely.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS website_connection_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  code VARCHAR(30) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_website_connection_codes_business ON website_connection_codes(business_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- AUTOMATIC MODE + AGENT ACTIVITY FEED
-- ═══════════════════════════════════════════════════════════════════════════

-- One timestamped record per thing the AI agent did on its own, across
-- both platforms: content it generated (draft or published), audits, fixes,
-- technical checks, sitemap actions — and failures, so "nothing happened"
-- is always distinguishable from "it ran and failed". Deliberately stores
-- structured detail rather than finished English sentences, so the page
-- can render each entry in the viewer's own language.
CREATE TABLE IF NOT EXISTS website_agent_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL, -- 'wordpress' | 'shopify'
  task_type VARCHAR(40) NOT NULL, -- 'content_generated' | 'content_failed' | 'intelligence_refreshed' | 'audit_completed' | 'technical_check' | 'sitemap_submitted' | 'sitemap_missing'
  outcome VARCHAR(20) NOT NULL DEFAULT 'success', -- 'success' | 'failed' | 'attention' (completed, but found something the owner should look at)
  triggered_by VARCHAR(20) NOT NULL DEFAULT 'automatic',
  detail JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_activity_business ON website_agent_activity(business_id, platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON website_agent_activity(created_at);

-- A scheduled time means the owner's local clock time, not UTC. Stored
-- as an IANA zone name so the sweep can compare against the real instant
-- (including daylight saving) rather than treating "09:00" as 09:00 UTC.
ALTER TABLE content_automation_rules ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';
ALTER TABLE content_calendar_entries ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT 'UTC';

-- Automatic mode's maintenance cycle: how often it runs, and when it last
-- did (the timestamp is also the claim that stops two sweeps running the
-- same cycle at once). WordPress already had automation_mode.
ALTER TABLE website_connections ADD COLUMN IF NOT EXISTS agent_cycle_frequency VARCHAR(20) DEFAULT 'daily'; -- 'daily' | 'weekly'
ALTER TABLE website_connections ADD COLUMN IF NOT EXISTS agent_last_cycle_at TIMESTAMPTZ;
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS automation_mode VARCHAR(20) DEFAULT 'manual'; -- 'manual' | 'automatic'
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS agent_cycle_frequency VARCHAR(20) DEFAULT 'daily';
ALTER TABLE shopify_connections ADD COLUMN IF NOT EXISTS agent_last_cycle_at TIMESTAMPTZ;
-- Distinguishes a fix the agent applied on its own from one a person approved.
ALTER TABLE shopify_actions ADD COLUMN IF NOT EXISTS auto_applied BOOLEAN DEFAULT FALSE;

-- Each platform's technical-check history is its own. It used to be saved per business only, so a business with both a
-- WordPress and a Shopify site saw one combined history in both views, each site's scores mixed into the other's.
-- Rows from before this column existed are attributed to WordPress (the website tool predates Shopify), except for a
-- business that has only a Shopify store. Rows written by an older server during a deploy overlap are picked up the
-- same way on the next start. Nothing is ever deleted.
ALTER TABLE website_technical_seo_checks ADD COLUMN IF NOT EXISTS platform VARCHAR(20); -- 'wordpress' | 'shopify'
ALTER TABLE website_technical_seo_checks ADD COLUMN IF NOT EXISTS mobile_friendly JSONB; -- { overall: good | needs_work | poor | unknown, checks: [{ id, status, detail }] }; NULL for checks made before this existed
UPDATE website_technical_seo_checks c SET platform = CASE
  WHEN EXISTS (SELECT 1 FROM shopify_connections s WHERE s.business_id = c.business_id)
   AND NOT EXISTS (SELECT 1 FROM website_connections w WHERE w.business_id = c.business_id) THEN 'shopify'
  ELSE 'wordpress' END
WHERE platform IS NULL;
CREATE INDEX IF NOT EXISTS idx_technical_checks_platform ON website_technical_seo_checks (business_id, platform, checked_at DESC);

-- Competitor analysis (WordPress): what was measured on your site and on each competitor's public site, and what the
-- AI concluded from those measurements only. Tied to the WordPress connection, like the other WordPress tables.
CREATE TABLE IF NOT EXISTS website_competitor_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  website_connection_id UUID REFERENCES website_connections(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  triggered_by VARCHAR(20) DEFAULT 'manual',
  own JSONB,
  competitors JSONB,
  insights JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_competitor_analyses_conn ON website_competitor_analyses (website_connection_id, created_at DESC);

-- Competitor analysis (Shopify): the same record as the WordPress one, tied to the Shopify connection. The two platforms never share rows.
CREATE TABLE IF NOT EXISTS shopify_competitor_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_connection_id UUID REFERENCES shopify_connections(id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL DEFAULT 'running', -- 'running' | 'completed' | 'failed'
  triggered_by VARCHAR(20) DEFAULT 'manual',
  own JSONB,
  competitors JSONB,
  insights JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shopify_competitor_analyses_conn ON shopify_competitor_analyses (shopify_connection_id, created_at DESC);

-- AI Visibility (Shopify): the same record as the WordPress one, tied to the Shopify connection. The two platforms never share rows.
CREATE TABLE IF NOT EXISTS shopify_ai_visibility_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_connection_id UUID REFERENCES shopify_connections(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  mentioned_by_name BOOLEAN DEFAULT FALSE,
  cited_by_domain BOOLEAN DEFAULT FALSE,
  answer_excerpt TEXT, -- the real answer text returned, for a person to read in context
  citations JSONB, -- the real list of URLs the AI assistant actually cited for this query
  checked_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shopify_ai_visibility_conn ON shopify_ai_visibility_checks (shopify_connection_id, checked_at DESC);

-- Keyword Rankings (Shopify): the same daily snapshot as the WordPress one, tied to the Shopify connection. The two platforms never share rows.
CREATE TABLE IF NOT EXISTS shopify_keyword_rankings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_connection_id UUID REFERENCES shopify_connections(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  clicks INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  ctr NUMERIC(6,3),
  avg_position NUMERIC(6,2),
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopify_connection_id, query, snapshot_date)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PLANS v2 — a 7-day Free plan, paid Starter / Pro / Business, and the
-- website-only Auto SEO/AEO/GEO plan.
--
-- IMPORTANT: this file runs on every server start. Anything that changes
-- existing data is guarded by schema_migrations so it happens exactly once;
-- without that, a restart would turn every paid Starter customer back into a
-- free user (the old free plan used to be called 'starter').
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS schema_migrations (
  key VARCHAR(120) PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- The plan an account was on before it expired — lets the lockout say
-- "renew your Pro plan" (paid) instead of "upgrade" (free trial).
ALTER TABLE users ADD COLUMN IF NOT EXISTS previous_plan VARCHAR(50);
ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'free';

-- One time only: the old free plan was named 'starter'. 'starter' now means the
-- paid $35 plan, so every existing free account is renamed 'free'. Paid Pro and
-- Business accounts, and their dates, are untouched.
UPDATE users SET plan = 'free'
 WHERE plan = 'starter'
   AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE key = 'plans_v2_rename_starter_to_free');
INSERT INTO schema_migrations (key) VALUES ('plans_v2_rename_starter_to_free') ON CONFLICT (key) DO NOTHING;

-- Accounts that already expired: remember the paid plan they last had (if any).
UPDATE users u SET previous_plan = (
    SELECT p.plan FROM payments p WHERE p.user_id = u.id AND p.status = 'approved'
    ORDER BY p.approved_at DESC NULLS LAST LIMIT 1)
 WHERE u.plan = 'expired' AND u.previous_plan IS NULL;

-- Editable from the admin panel (Plans & Pricing).
CREATE TABLE IF NOT EXISTS app_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO app_settings (key, value) VALUES ('fcfa_rate', '575'), ('annual_discount_percent', '15')
  ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS plan_pricing (
  plan_key VARCHAR(50) PRIMARY KEY,
  usd_monthly NUMERIC(10,2) NOT NULL,
  cfa_monthly INTEGER,                 -- NULL = follow the FCFA rate
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO plan_pricing (plan_key, usd_monthly, cfa_monthly) VALUES
  ('starter', 35, NULL), ('pro', 120, NULL), ('business', 300, NULL), ('auto_seo', 100, NULL)
  ON CONFLICT (plan_key) DO NOTHING;

-- Every blog post the website tool writes (manual, calendar, automatic), for
-- the plan's post allowance. A log, not a count of existing posts, so deleting
-- a draft never gives the allowance back.
CREATE TABLE IF NOT EXISTS website_post_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID,
  platform VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_website_post_usage_account ON website_post_usage(account_id, created_at DESC);

-- CMS-PLANS-V2 (generated; safe to re-run: new rows use ON CONFLICT DO NOTHING, old text is changed only if still the original)
INSERT INTO cms_content (section, key, value, value_fr, type) VALUES
  ('pricing', 'plan_free_name', $c$Arreyon Free$c$, $c$Arreyon Gratuit$c$, 'text'),
  ('pricing', 'plan_free_description', $c$Try Arreyon free for 7 days — no credit card$c$, $c$Essayez Arreyon gratuitement pendant 7 jours — sans carte bancaire$c$, 'text'),
  ('pricing', 'plan_free_features', $c$3 consultations during your 7-day trial
5 starter directors
Board Secretary Q&A
Basic board report
3 core financial calculators
Website Analyzer (1 scan)
Entrepreneur Mode & Scenario Comparison
1 team member
Website tool: connect 1 website + 2 blog posts$c$, $c$3 consultations pendant votre essai de 7 jours
5 directeurs de départ
Questions-réponses avec la Secrétaire du conseil
Rapport de conseil de base
3 calculateurs financiers essentiels
Analyseur de site web (1 analyse)
Mode Entrepreneur et comparaison de scénarios
1 membre d'équipe
Outil site web : connectez 1 site + 2 articles de blog$c$, 'textarea'),
  ('pricing', 'plan_free_cta', $c$Start 7-Day Free Trial$c$, $c$Commencer l'essai gratuit de 7 jours$c$, 'text'),
  ('pricing', 'plan_starter_name', $c$Arreyon Starter$c$, $c$Arreyon Starter$c$, 'text'),
  ('pricing', 'plan_starter_description', $c$For founders who want AI business advice and an AI website agent$c$, $c$Pour les fondateurs qui veulent des conseils d'affaires par IA et un agent IA pour leur site web$c$, 'text'),
  ('pricing', 'plan_starter_features', $c$3 consultations per month
5 starter directors
Board Secretary Q&A
Basic board report
3 core financial calculators
Website Analyzer (1 scan/month)
Entrepreneur Mode & Scenario Comparison
1 team member
Website tool: 1 website, AI Agent & Content Calendar, 5 blog posts/month$c$, $c$3 consultations par mois
5 directeurs de départ
Questions-réponses avec la Secrétaire du conseil
Rapport de conseil de base
3 calculateurs financiers essentiels
Analyseur de site web (1 analyse/mois)
Mode Entrepreneur et comparaison de scénarios
1 membre d'équipe
Outil site web : 1 site, Agent IA et Calendrier de contenu, 5 articles/mois$c$, 'textarea'),
  ('pricing', 'plan_starter_cta', $c$Get Arreyon Starter$c$, $c$Choisir Arreyon Starter$c$, 'text'),
  ('pricing', 'plan_pro_name', $c$Arreyon Pro$c$, $c$Arreyon Pro$c$, 'text'),
  ('pricing', 'plan_pro_description', $c$For serious founders who need regular guidance and a full SEO toolkit$c$, $c$Pour les fondateurs sérieux qui ont besoin d'un accompagnement régulier et d'une boîte à outils SEO complète$c$, 'text'),
  ('pricing', 'plan_pro_features', $c$10 consultations per month
All 29 directors
Report download (PDF)
Full consultation history
Full financial calculator suite (10 tools)
Market Research & Website Analyzer (5-10/month)
Research-backed Entrepreneur Mode
2 team members
Priority email support
Board Secretary deep-dive
Website tool: 2 websites, 10 blog posts/month, site audit, competitor analysis, technical SEO$c$, $c$10 consultations par mois
Les 29 directeurs
Téléchargement du rapport (PDF)
Historique complet des consultations
Suite complète de calculateurs financiers (10 outils)
Étude de marché et analyseur de site web (5-10/mois)
Mode Entrepreneur appuyé sur la recherche
2 membres d'équipe
Support prioritaire par e-mail
Analyse approfondie de la Secrétaire du conseil
Outil site web : 2 sites, 10 articles/mois, audit du site, analyse de la concurrence, SEO technique$c$, 'textarea'),
  ('pricing', 'plan_pro_cta', $c$Get Arreyon Pro$c$, $c$Choisir Arreyon Pro$c$, 'text'),
  ('pricing', 'plan_business_name', $c$Arreyon Business$c$, $c$Arreyon Business$c$, 'text'),
  ('pricing', 'plan_business_description', $c$For teams that need unlimited access and the complete website toolkit$c$, $c$Pour les équipes qui ont besoin d'un accès illimité et de la boîte à outils web complète$c$, 'text'),
  ('pricing', 'plan_business_features', $c$Unlimited consultations
All 29 directors
PDF + Word download
Video report (HeyGen)
Full financial calculator suite (10 tools)
Unlimited Market Research & Website Analyzer
Research-backed Entrepreneur Mode
5 team members
Custom AI director personas
Priority WhatsApp support
Full consultation history
Website tool: 3 websites, 25 blog posts/month, keyword rankings, sitemap, schema markup, AI visibility, media library, SEO fixes$c$, $c$Consultations illimitées
Les 29 directeurs
Téléchargement PDF + Word
Rapport vidéo (HeyGen)
Suite complète de calculateurs financiers (10 outils)
Étude de marché et analyseur de site web illimités
Mode Entrepreneur appuyé sur la recherche
5 membres d'équipe
Personas de directeurs IA personnalisés
Support prioritaire par WhatsApp
Historique complet des consultations
Outil site web : 3 sites, 25 articles/mois, classement des mots-clés, plan du site, balisage schema, visibilité IA, médiathèque, corrections SEO$c$, 'textarea'),
  ('pricing', 'plan_business_cta', $c$Get Arreyon Business$c$, $c$Choisir Arreyon Business$c$, 'text'),
  ('pricing', 'plan_auto_seo_name', $c$Arreyon Auto SEO/AEO/GEO$c$, $c$Arreyon Auto SEO/AEO/GEO$c$, 'text'),
  ('pricing', 'plan_auto_seo_description', $c$For website owners who only want automatic SEO, AEO and GEO — none of the other Arreyon Consult features$c$, $c$Pour les propriétaires de sites qui ne veulent que le SEO, l'AEO et le GEO automatiques — sans les autres fonctionnalités d'Arreyon Consult$c$, 'text'),
  ('pricing', 'plan_auto_seo_features', $c$1 website (WordPress or Shopify)
20 blog posts per month
AI Agent that works automatically + Content Calendar
Site audit, competitor analysis, technical SEO
Keyword rankings, sitemap, schema markup
AI visibility (AEO/GEO)
Website alerts (coming soon)
Website tool only — the other Arreyon Consult features are not included$c$, $c$1 site web (WordPress ou Shopify)
20 articles de blog par mois
Agent IA qui travaille automatiquement + Calendrier de contenu
Audit du site, analyse de la concurrence, SEO technique
Classement des mots-clés, plan du site, balisage schema
Visibilité IA (AEO/GEO)
Alertes du site web (bientôt disponibles)
Outil site web uniquement — les autres fonctionnalités d'Arreyon Consult ne sont pas incluses$c$, 'textarea'),
  ('pricing', 'plan_auto_seo_cta', $c$Get Auto SEO$c$, $c$Choisir Auto SEO$c$, 'text'),
  ('website_tool', 'headline', $c$Grow your website on autopilot$c$, $c$Développez votre site web en pilotage automatique$c$, 'text'),
  ('website_tool', 'subheadline', $c$Connect your WordPress or Shopify site and let your AI agent audit it, improve its SEO, write blog posts and track your rankings — with your approval, or fully automatic.$c$, $c$Connectez votre site WordPress ou Shopify et laissez votre agent IA l'auditer, améliorer son SEO, rédiger des articles et suivre votre classement — avec votre accord, ou en mode entièrement automatique.$c$, 'textarea'),
  ('website_tool', 'feature1_title', $c$Connect in minutes$c$, $c$Connectez-vous en quelques minutes$c$, 'text'),
  ('website_tool', 'feature1_desc', $c$Link your WordPress or Shopify site securely. Your credentials are encrypted, and you decide what the agent is allowed to change.$c$, $c$Reliez votre site WordPress ou Shopify en toute sécurité. Vos identifiants sont chiffrés et vous décidez de ce que l'agent peut modifier.$c$, 'textarea'),
  ('website_tool', 'feature2_title', $c$An AI agent that works for you$c$, $c$Un agent IA qui travaille pour vous$c$, 'text'),
  ('website_tool', 'feature2_desc', $c$Have it ask for your approval first, or let it run automatically. Every action is logged, so you always know what changed.$c$, $c$Demandez-lui votre accord avant d'agir, ou laissez-le tourner automatiquement. Chaque action est enregistrée : vous savez toujours ce qui a changé.$c$, 'textarea'),
  ('website_tool', 'feature3_title', $c$Blog posts & content calendar$c$, $c$Articles de blog et calendrier de contenu$c$, 'text'),
  ('website_tool', 'feature3_desc', $c$Generate SEO-optimised blog posts, schedule them in a content calendar, or let automation publish them on your rules.$c$, $c$Générez des articles de blog optimisés pour le SEO, planifiez-les dans un calendrier de contenu, ou laissez l'automatisation les publier selon vos règles.$c$, 'textarea'),
  ('website_tool', 'feature4_title', $c$Audit & SEO fixes$c$, $c$Audit et corrections SEO$c$, 'text'),
  ('website_tool', 'feature4_desc', $c$Spot weak titles and descriptions, broken links and technical issues, then review and approve the fixes.$c$, $c$Repérez les titres et descriptions faibles, les liens cassés et les problèmes techniques, puis examinez et approuvez les corrections.$c$, 'textarea'),
  ('website_tool', 'feature5_title', $c$Rankings, competitors & AI visibility$c$, $c$Classement, concurrents et visibilité IA$c$, 'text'),
  ('website_tool', 'feature5_desc', $c$Track keyword rankings, compare yourself with competitors, and see how visible your site is to AI assistants (AEO/GEO).$c$, $c$Suivez votre classement par mots-clés, comparez-vous à vos concurrents et voyez la visibilité de votre site auprès des assistants IA (AEO/GEO).$c$, 'textarea'),
  ('website_tool', 'feature6_title', $c$Schema, sitemap & media$c$, $c$Schema, plan du site et médias$c$, 'text'),
  ('website_tool', 'feature6_desc', $c$Add structured data, submit your sitemap to Google and keep your media library organised.$c$, $c$Ajoutez des données structurées, soumettez votre plan du site à Google et gardez votre médiathèque organisée.$c$, 'textarea'),
  ('website_tool', 'coming_label', $c$Coming soon$c$, $c$Bientôt disponible$c$, 'text'),
  ('website_tool', 'coming_items', $c$Website alerts
Page content editing
Thin-content expansion
Deeper crawl checks (noindex, canonicals, redirects)
XML sitemap generation$c$, $c$Alertes du site web
Modification du contenu des pages
Enrichissement des contenus trop courts
Contrôles d'exploration approfondis (noindex, canoniques, redirections)
Génération du plan du site XML$c$, 'textarea')
ON CONFLICT (section, key) DO NOTHING;

UPDATE cms_content SET value = $c$Start with a 7-day free trial. Upgrade when you need more.$c$, value_fr = $c$Commencez par un essai gratuit de 7 jours. Passez au niveau supérieur quand vous en avez besoin.$c$, updated_at = NOW()
 WHERE section = 'pricing' AND key = 'subheadline' AND value = $c$Start free. Upgrade when you need more.$c$;
UPDATE cms_content SET value = $c$Start your 7-day free trial. No credit card required.$c$, value_fr = $c$Commencez votre essai gratuit de 7 jours. Aucune carte bancaire requise.$c$, updated_at = NOW()
 WHERE section = 'cta' AND key = 'subheadline' AND value = $c$Your first consultation is free. No credit card required.$c$;
UPDATE cms_content SET value = $c$During your 7-day free trial you have 3 consultations. On paid plans your limit resets every month. You can upgrade your plan at any time for more consultations immediately.$c$, value_fr = $c$Pendant votre essai gratuit de 7 jours, vous disposez de 3 consultations. Avec un forfait payant, votre limite se réinitialise chaque mois. Vous pouvez passer à un forfait supérieur à tout moment pour obtenir immédiatement plus de consultations.$c$, updated_at = NOW()
 WHERE section = 'faq' AND key = 'q5_answer' AND value = $c$Your limit resets at the start of each calendar month. You can upgrade your plan at any time for more consultations immediately.$c$;

-- Sign-in sessions that can be cancelled: raising this number ends every login the account has made (password reset, "sign out of all devices").
-- Logins made before this existed carry no number and count as 0, so nobody is signed out when it is first added.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Admin two-factor sign-in: an authenticator app code after the password, plus one-time recovery codes.
-- The secret is encrypted (same key as the website credentials); recovery codes are stored only as hashes.
-- totp_last_step makes every code usable once. totp_enabled stays false until the first code from the app has been checked.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS recovery_code_hashes JSONB NOT NULL DEFAULT '[]'::jsonb;


-- Broken-link confirmation: a link is only removed automatically once it was still broken on a check made at least 20 hours after it was first seen broken.
CREATE TABLE IF NOT EXISTS broken_link_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL,
  url TEXT NOT NULL,
  first_broken_at TIMESTAMPTZ DEFAULT NOW(),
  last_broken_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (business_id, platform, url)
);


-- Broken links, safer automatic fixes. Why a link was flagged (a vanished website is confirmed more slowly than a missing page), and a copy of a page's content from
-- just before a fix, so the fix can be undone (kept 30 days; only used if the page has not been edited since).
ALTER TABLE broken_link_observations ADD COLUMN IF NOT EXISTS reason VARCHAR(30);
CREATE TABLE IF NOT EXISTS website_action_backups (
  action_id UUID PRIMARY KEY REFERENCES website_actions(id) ON DELETE CASCADE,
  content_before TEXT NOT NULL,
  content_after_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- Shopify link fixes: a copy of the page's content from just before a fix, so it can be undone (kept 30 days; same rules as WordPress).
CREATE TABLE IF NOT EXISTS shopify_action_backups (
  action_id UUID PRIMARY KEY REFERENCES shopify_actions(id) ON DELETE CASCADE,
  content_before TEXT NOT NULL,
  content_after_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);


-- Competitor discovery: businesses a web search suggested, until the person confirms (they become tracked competitors) or dismisses them (never suggested again).
CREATE TABLE IF NOT EXISTS competitor_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name VARCHAR(150) NOT NULL,
  website VARCHAR(300) NOT NULL,
  domain VARCHAR(255) NOT NULL,
  reason TEXT,
  scope VARCHAR(20),
  grounded BOOLEAN DEFAULT FALSE,
  source_urls JSONB DEFAULT '[]',
  page_title TEXT,
  status VARCHAR(20) DEFAULT 'suggested',
  tracked_competitor_id UUID,
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  UNIQUE (business_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_competitor_suggestions_business ON competitor_suggestions (business_id, status);
-- Each search costs money, so every run is recorded: it limits how often a business can search, and shows when the last one was.
CREATE TABLE IF NOT EXISTS competitor_discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  outcome VARCHAR(20) NOT NULL DEFAULT 'running',
  found INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_competitor_discovery_runs_business ON competitor_discovery_runs (business_id, created_at DESC);


-- Featured images for existing pages and posts. A preview is the picture made BEFORE the person approves it, kept so approving uses exactly that picture (no second charge);
-- it is removed once the plan is decided, and after 30 days. Every billed generation is logged: it limits previews per day, and is what plan limits will count.
CREATE TABLE IF NOT EXISTS featured_image_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform VARCHAR(20) NOT NULL,
  action_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  png BYTEA NOT NULL,
  regenerations INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (platform, action_id)
);
CREATE TABLE IF NOT EXISTS featured_image_generations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  platform VARCHAR(20) NOT NULL,
  kind VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_featured_image_generations_business ON featured_image_generations (business_id, created_at DESC);
