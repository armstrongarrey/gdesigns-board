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
  source_type VARCHAR(20) NOT NULL, -- 'user_provided' | 'observed' | 'inferred' | 'research'
  source_detail TEXT,
  confidence VARCHAR(10), -- 'high' | 'medium' | 'low', only for inferred/research facts
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
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
1 team member', 'textarea'),
('pricing', 'pro_features', '10 consultations per month
All 29 directors
Report download (PDF)
Full consultation history
3 team members
Priority email support
Board Secretary deep-dive', 'textarea'),
('pricing', 'business_features', 'Unlimited consultations
All 29 directors
PDF + Word download
Video report (HeyGen)
6 team members
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

-- ── DEFAULT ADMIN USER ──────────────────────────────────────────────────────
-- Password will be set via the server on first run
