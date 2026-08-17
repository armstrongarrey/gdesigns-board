// ═══════════════════════════════════════════════════════════════════════════
// ARREYON CONSULT — SHARED i18n ENGINE
// One dictionary, included by every page that supports translation. Add new
// pages by including this file and tagging elements with data-i18n="key" —
// no page-specific logic needed.
//
// Usage:
//   <script src="/i18n.js"></script>
//   <span data-i18n="nav.pricing">Pricing</span>
//   <input data-i18n-placeholder="form.email_placeholder" placeholder="you@example.com">
//   In JS: t('nav.pricing') returns the translated string for programmatic use
//          (alerts, dynamically-built HTML, etc.)
// ═══════════════════════════════════════════════════════════════════════════

const I18N_DICT = {
  en: {
    // Nav
    "nav.how_it_works": "How It Works",
    "nav.the_board": "The Board",
    "nav.pricing": "Pricing",
    "nav.contact": "Contact",
    "nav.sign_in": "Sign In",
    "nav.start_free": "Start Free",
    "nav.dashboard": "Dashboard",

    // Hero (static chrome only — headline/sub are CMS-editable, not translated here)
    "hero.advisors_ready": "legendary advisors ready for your challenge",

    // Footer
    "footer.product": "Product",
    "footer.account": "Account",
    "footer.company": "Company",
    "footer.sign_up": "Sign Up",
    "footer.sign_in": "Sign In",
    "footer.dashboard": "Dashboard",
    "footer.boardroom": "Boardroom",
    "footer.public_consult": "Public Consult",
    "footer.contact_us": "Contact Us",
    "footer.rights": "All rights reserved.",

    // Consult page — Stage 1 form
    "consult.badge": "Board Available Now",
    "consult.title1": "Get Advice From",
    "consult.title2": "29 Legendary Minds",
    "consult.subtitle": "Have a real strategic conversation with our AI Board of Directors. Rockefeller, Ogilvy, Buffett, Porter and more will engage with your business — asking questions, challenging your thinking, and delivering a full report.",
    "consult.start_title": "Start Your Consultation",
    "consult.start_sub": "Fill in your details — then have a real conversation with the board before they generate your report.",
    "consult.your_name": "Your Name",
    "consult.phone_number": "Phone Number",
    "consult.email_address": "Email Address",
    "consult.business_type": "Business Type",
    "consult.industry": "Industry",
    "consult.select_industry": "Select industry...",
    "consult.growth_stage": "Growth Stage",
    "consult.select_stage": "Select stage...",
    "consult.location": "Location",
    "consult.main_challenge": "Main Challenge / Problem",
    "consult.main_challenge_placeholder": "What is the biggest challenge your business is facing right now?",
    "consult.goal": "Goal / What You Want to Achieve",
    "consult.goal_placeholder": "What outcome do you want from this consultation?",
    "consult.choose_directors": "Choose Your Board Members",
    "consult.optional": "(optional)",
    "consult.browse_directors": "Browse Directors",
    "consult.hide_list": "Hide List",
    "consult.picker_hint": "Not sure who to pick? Leave this blank and the Board Secretary will automatically choose the directors best suited to your challenge.",
    "consult.selected_of_6": "of 6 selected",
    "consult.begin_consultation": "Begin Consultation",
    "consult.privacy_note": "Your information is kept confidential and used only for this consultation.",

    // Consult page — buttons / misc
    "consult.upgrade_now": "Upgrade now",
    "consult.download_report": "Download Report",
    "consult.new_consultation": "New Consultation",
    "consult.copy": "Copy",

    // Language switcher itself
    "lang.switch": "Language",

    // Downloadable report text labels
    "report.title": "G-DESIGNS LTD — BOARD CONSULTATION REPORT",
    "report.client": "Client",
    "report.email": "Email",
    "report.phone": "Phone",
    "report.date": "Date",
    "report.business": "Business",
    "report.industry": "Industry",
    "report.challenge": "Challenge",
    "report.goal": "Goal",
    "report.members_consulted": "BOARD MEMBERS CONSULTED:",
    "report.member_insights": "BOARD MEMBER INSIGHTS:",
    "report.synthesised_recommendation": "SYNTHESISED RECOMMENDATION:",
    "report.powered_by": "Powered by G-DESIGNS LTD AI Board of Directors"
  },
  fr: {
    // Nav
    "nav.how_it_works": "Comment ça marche",
    "nav.the_board": "Le Conseil",
    "nav.pricing": "Tarifs",
    "nav.contact": "Contact",
    "nav.sign_in": "Connexion",
    "nav.start_free": "Essai gratuit",
    "nav.dashboard": "Tableau de bord",

    // Hero
    "hero.advisors_ready": "conseillers légendaires prêts à relever votre défi",

    // Footer
    "footer.product": "Produit",
    "footer.account": "Compte",
    "footer.company": "Entreprise",
    "footer.sign_up": "S'inscrire",
    "footer.sign_in": "Connexion",
    "footer.dashboard": "Tableau de bord",
    "footer.boardroom": "Salle du conseil",
    "footer.public_consult": "Consultation publique",
    "footer.contact_us": "Nous contacter",
    "footer.rights": "Tous droits réservés.",

    // Consult page — Stage 1 form
    "consult.badge": "Conseil disponible maintenant",
    "consult.title1": "Obtenez des conseils de",
    "consult.title2": "29 esprits légendaires",
    "consult.subtitle": "Ayez une véritable conversation stratégique avec notre Conseil d'Administration IA. Rockefeller, Ogilvy, Buffett, Porter et d'autres échangeront avec votre entreprise — en posant des questions, en remettant en question votre réflexion, et en vous livrant un rapport complet.",
    "consult.start_title": "Démarrez votre consultation",
    "consult.start_sub": "Renseignez vos informations — puis échangez réellement avec le conseil avant qu'il ne génère votre rapport.",
    "consult.your_name": "Votre nom",
    "consult.phone_number": "Numéro de téléphone",
    "consult.email_address": "Adresse e-mail",
    "consult.business_type": "Type d'entreprise",
    "consult.industry": "Secteur d'activité",
    "consult.select_industry": "Sélectionnez un secteur...",
    "consult.growth_stage": "Stade de croissance",
    "consult.select_stage": "Sélectionnez un stade...",
    "consult.location": "Localisation",
    "consult.main_challenge": "Principal défi / problème",
    "consult.main_challenge_placeholder": "Quel est le plus grand défi auquel votre entreprise fait face actuellement ?",
    "consult.goal": "Objectif / Ce que vous souhaitez atteindre",
    "consult.goal_placeholder": "Quel résultat attendez-vous de cette consultation ?",
    "consult.choose_directors": "Choisissez vos membres du conseil",
    "consult.optional": "(facultatif)",
    "consult.browse_directors": "Parcourir les directeurs",
    "consult.hide_list": "Masquer la liste",
    "consult.picker_hint": "Vous ne savez pas qui choisir ? Laissez ce champ vide et le Secrétaire du Conseil choisira automatiquement les directeurs les mieux adaptés à votre défi.",
    "consult.selected_of_6": "sur 6 sélectionnés",
    "consult.begin_consultation": "Commencer la consultation",
    "consult.privacy_note": "Vos informations restent confidentielles et ne sont utilisées que pour cette consultation.",

    // Consult page — buttons / misc
    "consult.upgrade_now": "Mettre à niveau",
    "consult.download_report": "Télécharger le rapport",
    "consult.new_consultation": "Nouvelle consultation",
    "consult.copy": "Copier",

    // Language switcher itself
    "lang.switch": "Langue",

    // Downloadable report text labels
    "report.title": "G-DESIGNS LTD — RAPPORT DE CONSULTATION DU CONSEIL",
    "report.client": "Client",
    "report.email": "E-mail",
    "report.phone": "Téléphone",
    "report.date": "Date",
    "report.business": "Entreprise",
    "report.industry": "Secteur d'activité",
    "report.challenge": "Défi",
    "report.goal": "Objectif",
    "report.members_consulted": "MEMBRES DU CONSEIL CONSULTÉS :",
    "report.member_insights": "AVIS DES MEMBRES DU CONSEIL :",
    "report.synthesised_recommendation": "RECOMMANDATION DE SYNTHÈSE :",
    "report.powered_by": "Propulsé par le Conseil d'Administration IA de G-DESIGNS LTD"
  }
};

// ── Core engine ──────────────────────────────────────────────────────────

function detectLanguage() {
  try {
    const saved = localStorage.getItem('arreyon_lang');
    if (saved === 'en' || saved === 'fr') return saved;
  } catch (e) {}
  // Auto-detect from browser on first visit only — never overrides an explicit choice
  const browserLang = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  return browserLang.startsWith('fr') ? 'fr' : 'en';
}

function t(key) {
  const lang = window.currentLang || detectLanguage();
  return (I18N_DICT[lang] && I18N_DICT[lang][key]) || (I18N_DICT.en[key]) || key;
}

function applyTranslations(lang) {
  window.currentLang = lang;
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const translated = t(key);
    if (translated) el.textContent = translated;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    const translated = t(key);
    if (translated) el.placeholder = translated;
  });

  // Update any language-switcher UI present on the page to reflect current state
  document.querySelectorAll('.lang-switch-btn').forEach(btn => {
    const btnLang = btn.getAttribute('data-lang-option');
    btn.classList.toggle('active', btnLang === lang);
  });

  // Let the page react to a language change (e.g., re-render dynamic content)
  document.dispatchEvent(new CustomEvent('arreyon:langchange', { detail: { lang } }));
}

function setLanguage(lang) {
  if (lang !== 'en' && lang !== 'fr') return;
  try { localStorage.setItem('arreyon_lang', lang); } catch (e) {}
  applyTranslations(lang);
}

// Apply immediately on script load (before other page scripts run) so there's
// no flash of English before translation kicks in on a French-preferred visit.
// A second pass runs on DOMContentLoaded in case elements weren't in the DOM yet.
document.addEventListener('DOMContentLoaded', () => applyTranslations(detectLanguage()));
