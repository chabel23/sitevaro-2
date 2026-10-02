'use strict';

/**
 * ============================================================================
 *  SITEVARO — backend in UN UNICO FILE
 * ============================================================================
 *  Tutto il backend è contenuto in questo file: database SQLite, catalogo
 *  dei template, seed automatico, rendering dei siti, provisioning dopo il
 *  pagamento Stripe, autenticazione JWT e pannello admin.
 *
 *  Nessuna cartella src/: per l'upload su GitHub bastano 3 file:
 *    - server.js    (questo file)
 *    - package.json
 *    - render.yaml
 *
 *  Avvio:  node server.js        (oppure npm start)
 *  Porta:  variabile PORT (su Render la imposta il servizio), altrimenti 3000
 *
 *  Comportamento identico alla versione multi-file in ~/workspace/sitevaro-backend.
 * ============================================================================
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

/* ==========================================================================
 * 1. DATABASE (equivalente di src/db.js)
 *    SQLite in ./data/sitevaro.db — su Render il disco persistente è montato
 *    in ./data. Si può cambiare percorso con la variabile DB_PATH.
 * ========================================================================== */

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'sitevaro.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS utenti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template (
  id TEXT PRIMARY KEY,
  categoria TEXT NOT NULL,
  nome TEXT NOT NULL,
  layout TEXT NOT NULL,
  palette TEXT NOT NULL,
  font TEXT NOT NULL,
  riservato INTEGER NOT NULL DEFAULT 0,
  reserved_by INTEGER REFERENCES utenti(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_template_categoria ON template(categoria);
CREATE INDEX IF NOT EXISTS idx_template_riservato ON template(riservato);

CREATE TABLE IF NOT EXISTS siti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  utente_id INTEGER NOT NULL REFERENCES utenti(id),
  template_id TEXT NOT NULL REFERENCES template(id),
  stripe_subscription_id TEXT,
  stato TEXT NOT NULL DEFAULT 'attivo',
  contenuti_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_siti_slug ON siti(slug);
CREATE INDEX IF NOT EXISTS idx_siti_utente ON siti(utente_id);

CREATE TABLE IF NOT EXISTS abbonamenti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL REFERENCES utenti(id),
  stripe_subscription_id TEXT UNIQUE,
  price_id TEXT,
  stato TEXT NOT NULL DEFAULT 'attivo',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_abb_utente ON abbonamenti(utente_id);
`);

/* ==========================================================================
 * 2. CATALOGO (equivalente di src/lib/catalog.js)
 *    Catalogo parametrico dei template Sitevaro.
 *    10 layout base × 15 palette/variazioni = 150 template unici per categoria.
 * ========================================================================== */

const CATEGORIE = ['ristorante', 'attivita-locale', 'freelance-portfolio', 'e-commerce'];

const NOMI_CATEGORIE = {
  'ristorante': 'Ristorante',
  'attivita-locale': 'Attività locale',
  'freelance-portfolio': 'Freelance / Portfolio',
  'e-commerce': 'E-commerce',
};

// 10 layout base per categoria (nomi descrittivi, stabili)
const LAYOUTS = {
  'ristorante': [
    'hero-centrato', 'hero-fullscreen', 'hero-split', 'menu-in-evidenza',
    'griglia-piatti', 'lista-menu-elegante', 'storia-e-foto', 'prenota-subito',
    'serata-eventi', 'minimal-monocromatico',
  ],
  'attivita-locale': [
    'hero-centrato', 'hero-mappa', 'servizi-griglia', 'servizi-lista',
    'recensioni-evidenza', 'orari-e-contatti', 'galleria-lavori', 'prenota-online',
    'chi-siamo-storia', 'minimal-monocromatico',
  ],
  'freelance-portfolio': [
    'hero-personale', 'portfolio-griglia', 'portfolio-masonry', 'cv-timeline',
    'servizi-e-prezzi', 'testimonianze', 'blog-evidenza', 'contatto-diretto',
    'fullscreen-creativo', 'minimal-monocromatico',
  ],
  'e-commerce': [
    'vetrina-hero', 'griglia-prodotti', 'prodotto-in-evidenza', 'categorie-shop',
    'offerte-lampo', 'lookbook', 'recensioni-prodotti', 'checkout-semplice',
    'fullscreen-promo', 'minimal-monocromatico',
  ],
};

// 15 palette/variazioni visive (colori + stile dettagli)
const PALETTES = [
  { nome: 'Terracotta', primaria: '#C05621', secondaria: '#2D3748', sfondo: '#FFF7ED', testo: '#2D3748', accento: '#ED8936', pulsanti: 'arrotondati' },
  { nome: 'Oceano', primaria: '#2B6CB0', secondaria: '#1A365D', sfondo: '#EBF8FF', testo: '#1A202C', accento: '#63B3ED', pulsanti: 'arrotondati' },
  { nome: 'Foresta', primaria: '#276749', secondaria: '#1C4532', sfondo: '#F0FFF4', testo: '#1A202C', accento: '#68D391', pulsanti: 'squadrati' },
  { nome: 'Notte', primaria: '#E2E8F0', secondaria: '#1A202C', sfondo: '#1A202C', testo: '#F7FAFC', accento: '#9F7AEA', pulsanti: 'pill' },
  { nome: 'Sole', primaria: '#D69E2E', secondaria: '#744210', sfondo: '#FFFFF0', testo: '#2D3748', accento: '#F6E05E', pulsanti: 'arrotondati' },
  { nome: 'Rosa Cipria', primaria: '#D53F8C', secondaria: '#702459', sfondo: '#FFF5F7', testo: '#2D3748', accento: '#F687B3', pulsanti: 'pill' },
  { nome: 'Lavanda', primaria: '#6B46C1', secondaria: '#3C366B', sfondo: '#FAF5FF', testo: '#2D3748', accento: '#B794F4', pulsanti: 'arrotondati' },
  { nome: 'Agrumi', primaria: '#DD6B20', secondaria: '#652B19', sfondo: '#FFFAF0', testo: '#2D3748', accento: '#FBD38D', pulsanti: 'squadrati' },
  { nome: 'Menta', primaria: '#2C7A7B', secondaria: '#234E52', sfondo: '#E6FFFA', testo: '#1A202C', accento: '#81E6D9', pulsanti: 'pill' },
  { nome: 'Bordeaux', primaria: '#9B2C2C', secondaria: '#521B1B', sfondo: '#FFF5F5', testo: '#2D3748', accento: '#FC8181', pulsanti: 'arrotondati' },
  { nome: 'Grafite', primaria: '#4A5568', secondaria: '#1A202C', sfondo: '#F7FAFC', testo: '#1A202C', accento: '#A0AEC0', pulsanti: 'squadrati' },
  { nome: 'Sabbia', primaria: '#975A16', secondaria: '#5C3A0E', sfondo: '#FDF8F0', testo: '#3C2A12', accento: '#D6A35C', pulsanti: 'arrotondati' },
  { nome: 'Indaco', primaria: '#434190', secondaria: '#1E1B4B', sfondo: '#EBF4FF', testo: '#1A202C', accento: '#7F9CF5', pulsanti: 'pill' },
  { nome: 'Corallo', primaria: '#E53E3E', secondaria: '#631717', sfondo: '#FFF5F5', testo: '#2D3748', accento: '#FEB2B2', pulsanti: 'arrotondati' },
  { nome: 'Oliva', primaria: '#5F6C37', secondaria: '#2F3A1D', sfondo: '#F7F8EF', testo: '#232A15', accento: '#A3B86B', pulsanti: 'squadrati' },
];

const FONTS = [
  'Playfair Display', 'Montserrat', 'Lora', 'Poppins', 'Merriweather',
  'Inter', 'DM Serif Display', 'Nunito', 'Libre Baskerville', 'Work Sans',
  'Cormorant Garamond', 'Raleway', 'PT Serif', 'Manrope', 'Fraunces',
];

// Nomi "vetrina" per categoria, usati per i nomi univoci dei template
const NOMI_VETRINA = {
  'ristorante': ['Osteria', 'Trattoria', 'Bistrot', 'Pizzeria', 'Enoteca', 'Ristoro', 'Locanda', 'Taverna'],
  'attivita-locale': ['Bottega', 'Studio', 'Officina', 'Atelier', 'Negozio', 'Laboratorio', 'Emporio', 'Salone'],
  'freelance-portfolio': ['Portfolio', 'Studio Creativo', 'Atelier', 'Collezione', 'Showcase', 'Profilo', 'Opere', 'Visioni'],
  'e-commerce': ['Shop', 'Store', 'Boutique', 'Market', 'Emporio', 'Outlet', 'Galleria', 'Bazar'],
};

/* ==========================================================================
 * 3. SEED TEMPLATE (equivalente di src/lib/seedTemplates.js)
 *    Seed parametrico IDEMPOTENTE: 150 template per categoria × 4 = 600.
 *    Sicuro da eseguire a ogni avvio: usa INSERT OR IGNORE, non duplica,
 *    non tocca mai utenti, siti o abbonamenti.
 * ========================================================================== */

function generaSeed() {
  const inserisci = db.prepare(`
    INSERT OR IGNORE INTO template (id, categoria, nome, layout, palette, font, riservato)
    VALUES (@id, @categoria, @nome, @layout, @palette, @font, 0)
  `);

  const prima = db.prepare('SELECT COUNT(*) AS c FROM template').get().c;
  let nuovi = 0;
  const riepilogo = {};

  const tx = db.transaction(() => {
    for (const categoria of CATEGORIE) {
      const layouts = LAYOUTS[categoria];
      const vetrine = NOMI_VETRINA[categoria];
      let n = 0;
      for (let li = 0; li < layouts.length; li++) {
        for (let pi = 0; pi < PALETTES.length; pi++) {
          n += 1;
          const numero = String(n).padStart(3, '0');
          const id = `tpl-${categoria}-${numero}`;
          const nomeVetrina = vetrine[(li + pi) % vetrine.length];
          const nome = `${NOMI_CATEGORIE[categoria]} · ${nomeVetrina} ${numero}`;
          const font = FONTS[(li * PALETTES.length + pi) % FONTS.length];
          const res = inserisci.run({
            id,
            categoria,
            nome,
            layout: layouts[li],
            palette: JSON.stringify(PALETTES[pi]),
            font,
          });
          nuovi += res.changes; // 1 se inserito, 0 se esisteva già (IGNORE)
        }
      }
      riepilogo[categoria] = n;
    }
  });

  tx();

  const dopo = db.prepare('SELECT COUNT(*) AS c FROM template').get().c;
  const conteggio = db.prepare('SELECT categoria, COUNT(*) AS c FROM template GROUP BY categoria').all();
  return { prima, nuovi, dopo, riepilogo, conteggio };
}

/* ==========================================================================
 * 4. RENDERING DEI SITI PUBBLICI (equivalente di src/lib/siteRenderer.js)
 *    HTML dal template + contenuti personalizzati del cliente.
 * ========================================================================== */

function esc(testo) {
  return String(testo ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function stilePulsante(palette) {
  const radius = palette.pulsanti === 'pill' ? '999px' : palette.pulsanti === 'squadrati' ? '4px' : '10px';
  return `display:inline-block;background:${palette.primaria};color:#fff;padding:0.8rem 1.6rem;border-radius:${radius};text-decoration:none;font-weight:600`;
}

function hero(contenuti, palette, layout) {
  const titolo = esc(contenuti.nome_attivita);
  const tagline = esc(contenuti.tagline);
  if (layout.includes('fullscreen')) {
    return `<section style="min-height:70vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:linear-gradient(135deg,${palette.primaria},${palette.secondaria});color:#fff;padding:4rem 1.5rem">
      <h1 style="font-size:3rem;margin:0 0 1rem">${titolo}</h1><p style="font-size:1.3rem;opacity:.9">${tagline}</p></section>`;
  }
  if (layout.includes('split') || layout.includes('personale')) {
    return `<section style="display:flex;flex-wrap:wrap;align-items:center;gap:2rem;padding:4rem 1.5rem;max-width:1100px;margin:0 auto">
      <div style="flex:1;min-width:260px"><h1 style="font-size:2.6rem;margin:0 0 1rem">${titolo}</h1>
      <p style="font-size:1.2rem;color:${palette.secondaria}">${tagline}</p>
      <p>${esc(contenuti.descrizione)}</p></div>
      <div style="flex:1;min-width:260px;background:${palette.accento};border-radius:16px;min-height:280px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.1rem">La tua foto qui</div></section>`;
  }
  return `<section style="text-align:center;padding:4rem 1.5rem;background:${palette.sfondo}">
    <h1 style="font-size:2.8rem;margin:0 0 1rem">${titolo}</h1><p style="font-size:1.25rem">${tagline}</p></section>`;
}

function sezioniCategoria(contenuti, palette, categoria) {
  const card = (titolo, corpo, extra = '') =>
    `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,.05)">
      <h3 style="margin-top:0;color:${palette.primaria}">${esc(titolo)}</h3><p>${esc(corpo)}</p>${extra}</div>`;
  const griglia = (items) =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem">${items}</div>`;

  if (categoria === 'ristorante' && contenuti.piatti) {
    return `<section style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>Il nostro menu</h2>${griglia(contenuti.piatti.map((p) =>
      card(p.nome, p.descrizione, `<strong>${esc(p.prezzo)}</strong>`)).join(''))}</section>
      <section style="max-width:1100px;margin:0 auto;padding:1rem 1.5rem 3rem"><p><strong>Orari:</strong> ${esc(contenuti.orari)}</p></section>`;
  }
  if (categoria === 'attivita-locale' && contenuti.servizi) {
    return `<section style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>I nostri servizi</h2>${griglia(contenuti.servizi.map((s) =>
      card(s.nome, s.descrizione)).join(''))}</section>
      <section style="max-width:1100px;margin:0 auto;padding:1rem 1.5rem 3rem"><p><strong>Orari:</strong> ${esc(contenuti.orari)}</p></section>`;
  }
  if (categoria === 'freelance-portfolio' && contenuti.progetti) {
    return `<section style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2 style="color:${palette.secondaria}">${esc(contenuti.ruolo)}</h2>
      <p>${esc(contenuti.bio)}</p><h2>Progetti</h2>${griglia(contenuti.progetti.map((p) =>
      card(p.titolo, p.descrizione)).join(''))}</section>`;
  }
  if (categoria === 'e-commerce' && contenuti.prodotti) {
    return `<section style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>I nostri prodotti</h2>${griglia(contenuti.prodotti.map((p) =>
      card(p.nome, p.descrizione, `<div style="margin-top:.5rem"><strong>${esc(p.prezzo)}</strong>
      <a href="mailto:${esc(contenuti.email)}?subject=Ordine: ${esc(p.nome)}" style="${stilePulsante(palette)};margin-left:.75rem;padding:.5rem 1rem">Ordina</a></div>`)).join(''))}</section>`;
  }
  return `<section style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><p>${esc(contenuti.descrizione)}</p></section>`;
}

function renderSito({ sito, template, contenuti }) {
  const palette = JSON.parse(template.palette);
  const font = template.font;
  const titolo = esc(contenuti.nome_attivita || template.nome);

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titolo} — powered by Sitevaro</title>
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;600;700&display=swap" rel="stylesheet">
<style>body{font-family:'${font}',system-ui,sans-serif;margin:0;background:${palette.sfondo};color:${palette.testo}}h1,h2,h3{font-family:'${font}',serif}</style>
</head>
<body>
<header style="display:flex;justify-content:space-between;align-items:center;padding:1rem 1.5rem;background:${palette.secondaria};color:#fff">
  <strong style="font-size:1.2rem">${titolo}</strong>
  <a href="tel:${esc(contenuti.telefono)}" style="color:#fff;text-decoration:none">${esc(contenuti.telefono)}</a>
</header>
${hero(contenuti, palette, template.layout)}
${sezioniCategoria(contenuti, palette, template.categoria)}
<footer style="background:${palette.secondaria};color:#fff;padding:2rem 1.5rem;text-align:center">
  <p style="margin:.25rem">${esc(contenuti.indirizzo)} · ${esc(contenuti.email)}</p>
  <p style="margin:.25rem;opacity:.7;font-size:.85rem">Sito creato con Sitevaro · Template ${esc(template.nome)}</p>
</footer>
</body>
</html>`;
}

/* ==========================================================================
 * 5. PROVISIONING (equivalente di src/lib/provisioning.js)
 *    Crea sito + abbonamento dopo un pagamento riuscito; sospende il sito
 *    se l'abbonamento viene cancellato.
 * ========================================================================== */

function slugify(testo) {
  return (testo || 'sito')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sito';
}

function generaSlug(base) {
  for (let i = 0; i < 10; i++) {
    const slug = `${slugify(base)}-${crypto.randomBytes(3).toString('hex')}`;
    const esiste = db.prepare('SELECT id FROM siti WHERE slug = ?').get(slug);
    if (!esiste) return slug;
  }
  return `sito-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function contenutiDefault(categoria) {
  const base = {
    nome_attivita: 'La mia attività',
    tagline: 'Il tuo sito pronto in minuti con Sitevaro',
    descrizione: 'Benvenuto nel nostro sito! Personalizza questi testi dal tuo pannello.',
    telefono: '+39 000 000 0000',
    email: 'info@esempio.it',
    indirizzo: 'Via Esempio 1, Milano',
  };
  if (categoria === 'ristorante') {
    return { ...base, orari: 'Lun–Dom 12:00–23:00', piatti: [
      { nome: 'Piatto della casa', prezzo: '€14', descrizione: 'La nostra specialità, ingredienti freschi di stagione.' },
      { nome: 'Antipasto misto', prezzo: '€9', descrizione: 'Selezione di antipasti della tradizione.' },
      { nome: 'Dolce del giorno', prezzo: '€6', descrizione: 'Chiedi al nostro staff il dolce di oggi.' },
    ]};
  }
  if (categoria === 'attivita-locale') {
    return { ...base, orari: 'Lun–Ven 9:00–19:00', servizi: [
      { nome: 'Servizio 1', descrizione: 'Descrizione del primo servizio offerto.' },
      { nome: 'Servizio 2', descrizione: 'Descrizione del secondo servizio offerto.' },
      { nome: 'Servizio 3', descrizione: 'Descrizione del terzo servizio offerto.' },
    ]};
  }
  if (categoria === 'freelance-portfolio') {
    return { ...base, nome_attivita: 'Mario Rossi', ruolo: 'Freelance Designer', bio: 'Creo esperienze digitali memorabili da oltre 5 anni.', progetti: [
      { titolo: 'Progetto Alpha', descrizione: 'Restyling completo di un brand locale.' },
      { titolo: 'Progetto Beta', descrizione: 'Sito vetrina per uno studio professionale.' },
      { titolo: 'Progetto Gamma', descrizione: 'Identità visiva per una startup.' },
    ]};
  }
  // e-commerce
  return { ...base, nome_attivita: 'Il mio negozio', prodotti: [
    { nome: 'Prodotto 1', prezzo: '€29', descrizione: 'Descrizione del prodotto in vendita.' },
    { nome: 'Prodotto 2', prezzo: '€49', descrizione: 'Descrizione del prodotto in vendita.' },
    { nome: 'Prodotto 3', prezzo: '€19', descrizione: 'Descrizione del prodotto in vendita.' },
  ]};
}

/**
 * Gestisce checkout.session.completed.
 * session = { metadata: { userId, templateId, priceId? }, subscription, customer }
 * Ritorna il sito creato. Idempotente: se esiste già un sito con la stessa
 * stripe_subscription_id, lo restituisce senza duplicare.
 */
function handleCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const userId = Number(metadata.userId);
  const templateId = metadata.templateId;
  const subscriptionId = session.subscription || null;

  if (!userId || !templateId) throw new Error('Metadata userId/templateId mancanti nella sessione');

  const utente = db.prepare('SELECT id FROM utenti WHERE id = ?').get(userId);
  if (!utente) throw new Error(`Utente ${userId} non trovato`);

  if (subscriptionId) {
    const gia = db.prepare('SELECT * FROM siti WHERE stripe_subscription_id = ?').get(subscriptionId);
    if (gia) return gia; // webhook ricevuto due volte: niente duplicati
  }

  const template = db.prepare('SELECT * FROM template WHERE id = ?').get(templateId);
  if (!template) throw new Error(`Template ${templateId} non trovato`);
  if (template.riservato) throw new Error(`Template ${templateId} già riservato da un altro cliente`);

  const priceId = metadata.priceId || null;
  const slug = generaSlug(contenutiDefault(template.categoria).nome_attivita);

  const tx = db.transaction(() => {
    db.prepare('UPDATE template SET riservato = 1, reserved_by = ? WHERE id = ?').run(userId, templateId);
    const info = db.prepare(`
      INSERT INTO siti (slug, utente_id, template_id, stripe_subscription_id, stato, contenuti_json)
      VALUES (?, ?, ?, ?, 'attivo', ?)
    `).run(slug, userId, templateId, subscriptionId, JSON.stringify(contenutiDefault(template.categoria)));
    db.prepare(`
      INSERT INTO abbonamenti (utente_id, stripe_subscription_id, price_id, stato)
      VALUES (?, ?, ?, 'attivo')
      ON CONFLICT(stripe_subscription_id) DO UPDATE SET stato = 'attivo', price_id = excluded.price_id
    `).run(userId, subscriptionId, priceId);
    return db.prepare('SELECT * FROM siti WHERE id = ?').get(info.lastInsertRowid);
  });

  return tx();
}

/**
 * Gestisce customer.subscription.deleted: sospende sito e abbonamento.
 * subscription = { id }
 */
function handleSubscriptionDeleted(subscription) {
  const subscriptionId = subscription.id;
  const tx = db.transaction(() => {
    db.prepare("UPDATE siti SET stato = 'sospeso' WHERE stripe_subscription_id = ?").run(subscriptionId);
    db.prepare("UPDATE abbonamenti SET stato = 'cancellato' WHERE stripe_subscription_id = ?").run(subscriptionId);
  });
  tx();
  return db.prepare('SELECT * FROM siti WHERE stripe_subscription_id = ?').get(subscriptionId) || null;
}

/* ==========================================================================
 * 6. AUTENTICAZIONE JWT (equivalente di src/middleware/auth.js)
 * ========================================================================== */

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET non configurato: impostalo nel file .env');
  return s;
}

function firmaToken(utente) {
  return jwt.sign(
    { id: utente.id, email: utente.email, is_admin: !!utente.is_admin },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
}

// Richiede Authorization: Bearer <token>. Popola req.utente.
function richiedeAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ errore: 'Autenticazione richiesta' });
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const utente = db.prepare('SELECT id, email, is_admin, created_at FROM utenti WHERE id = ?').get(payload.id);
    if (!utente) return res.status(401).json({ errore: 'Utente non trovato' });
    req.utente = utente;
    next();
  } catch (e) {
    return res.status(401).json({ errore: 'Token non valido o scaduto' });
  }
}

function richiedeAdmin(req, res, next) {
  if (!req.utente || !req.utente.is_admin) {
    return res.status(403).json({ errore: 'Accesso riservato agli amministratori' });
  }
  next();
}

/* ==========================================================================
 * 7. STRIPE — client e allowlist dei prezzi
 * ========================================================================== */

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return require('stripe')(key);
}

// Allowlist dei prezzi reali (modalità TEST, account CLARIVO) — prezzi aggiornati 2026-10-02
const PREZZI = {
  'price_1ULt9qHOHbkO5FAoxAdgUvMO': { piano: 'Base', periodo: 'mese', importo: '€29,99/mese' },
  'price_1ULt9rHOHbkO5FAo6Gzsli9V': { piano: 'Pro', periodo: 'mese', importo: '€39,99/mese' },
  'price_1ULt9tHOHbkO5FAoGY9VCSJa': { piano: 'Max', periodo: 'mese', importo: '€59,99/mese' },
  'price_1ULt9uHOHbkO5FAoJMdcRIOw': { piano: 'Base', periodo: 'anno', importo: '€299,90/anno' },
  'price_1ULt9vHOHbkO5FAoADkFz887': { piano: 'Pro', periodo: 'anno', importo: '€399,90/anno' },
  'price_1ULt9xHOHbkO5FAo464JSaqd': { piano: 'Max', periodo: 'anno', importo: '€599,90/anno' },
};

/* ==========================================================================
 * 8. ROTTE
 * ========================================================================== */

/* ---- 8.1 Auth (equivalente di src/routes/auth.js) ---------------------- */

const authRoutes = express.Router();

function emailValida(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// POST /api/auth/register { email, password }
authRoutes.post('/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!emailValida(email)) return res.status(400).json({ errore: 'Email non valida' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ errore: 'La password deve avere almeno 8 caratteri' });
  }
  const emailNorm = email.trim().toLowerCase();
  const esiste = db.prepare('SELECT id FROM utenti WHERE email = ?').get(emailNorm);
  if (esiste) return res.status(409).json({ errore: 'Email già registrata' });

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO utenti (email, password_hash) VALUES (?, ?)').run(emailNorm, password_hash);
  const utente = db.prepare('SELECT id, email, is_admin, created_at FROM utenti WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ utente, token: firmaToken(utente) });
});

// POST /api/auth/login { email, password }
authRoutes.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!emailValida(email) || typeof password !== 'string') {
    return res.status(400).json({ errore: 'Email e password sono obbligatorie' });
  }
  const row = db.prepare('SELECT * FROM utenti WHERE email = ?').get(email.trim().toLowerCase());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ errore: 'Credenziali non valide' });
  }
  const utente = { id: row.id, email: row.email, is_admin: !!row.is_admin, created_at: row.created_at };
  res.json({ utente, token: firmaToken(utente) });
});

// GET /api/auth/me
authRoutes.get('/me', richiedeAuth, (req, res) => {
  res.json({ utente: req.utente });
});

/* ---- 8.2 Template (equivalente di src/routes/templates.js) ------------- */

const templateRoutes = express.Router();

function serializzaTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    categoria: row.categoria,
    nome: row.nome,
    layout: row.layout,
    palette: JSON.parse(row.palette),
    font: row.font,
    riservato: !!row.riservato,
  };
}

// GET /api/templates?categoria=ristorante — solo template NON riservati
templateRoutes.get('/', (req, res) => {
  const { categoria } = req.query;
  let rows;
  if (categoria) {
    if (!CATEGORIE.includes(categoria)) {
      return res.status(400).json({ errore: `Categoria non valida. Valori ammessi: ${CATEGORIE.join(', ')}` });
    }
    rows = db.prepare('SELECT * FROM template WHERE categoria = ? AND riservato = 0 ORDER BY id').all(categoria);
  } else {
    rows = db.prepare('SELECT * FROM template WHERE riservato = 0 ORDER BY categoria, id').all();
  }
  res.json({ totale: rows.length, template: rows.map(serializzaTemplate) });
});

// GET /api/templates/:id
templateRoutes.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM template WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ errore: 'Template non trovato' });
  res.json({ template: serializzaTemplate(row) });
});

/* ---- 8.3 Checkout Stripe (equivalente di src/routes/checkout.js) ------- */

const checkoutRoutes = express.Router();

// GET /api/checkout/piani — elenco piani disponibili (pubblico)
checkoutRoutes.get('/piani', (req, res) => {
  res.json({ piani: Object.entries(PREZZI).map(([priceId, info]) => ({ priceId, ...info })) });
});

// POST /api/checkout { priceId, templateId } → { url }
checkoutRoutes.post('/', richiedeAuth, async (req, res) => {
  const { priceId, templateId } = req.body || {};

  if (!priceId || !PREZZI[priceId]) {
    return res.status(400).json({ errore: 'Piano non valido' });
  }
  if (!templateId) return res.status(400).json({ errore: 'templateId obbligatorio' });

  const template = db.prepare('SELECT id, riservato FROM template WHERE id = ?').get(templateId);
  if (!template) return res.status(404).json({ errore: 'Template non trovato' });
  if (template.riservato) return res.status(409).json({ errore: 'Template già riservato da un altro cliente' });

  const stripe = stripeClient();
  if (!stripe) {
    return res.status(503).json({
      errore: 'Pagamenti non configurati',
      dettaglio: 'STRIPE_SECRET_KEY mancante nel file .env. Vedi README.md per come ottenere le chiavi di test da Stripe.',
    });
  }

  const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId: String(req.utente.id), templateId, priceId },
      success_url: `${baseUrl}/checkout/successo?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/annullato`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Errore Stripe checkout:', e.message);
    res.status(502).json({ errore: 'Errore nella creazione del pagamento', dettaglio: e.message });
  }
});

// Pagine HTML semplici di esito (pubbliche)
checkoutRoutes.get('/successo', (req, res) => {
  res.send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pagamento completato — Sitevaro</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem">
<h1>🎉 Pagamento completato!</h1><p>Il tuo sito Sitevaro è in preparazione e sarà online tra pochi minuti.</p>
<p>Riceverai il link del tuo sito via email.</p></body></html>`);
});

checkoutRoutes.get('/annullato', (req, res) => {
  res.send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pagamento annullato — Sitevaro</title></head>
<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem 1rem">
<h1>Pagamento annullato</h1><p>Nessun addebito effettuato. Puoi riprovare quando vuoi.</p></body></html>`);
});

/* ---- 8.4 Webhook Stripe (equivalente di src/routes/webhooks.js) -------- */
/* IMPORTANTE: questa rotta deve ricevere il corpo RAW (non JSON già
 * decodificato) per verificare la firma Stripe. Per questo il router viene
 * montato in app PRIMA del parser JSON globale. */

const webhookRoutes = express.Router();

// POST /api/webhooks/stripe — corpo RAW (necessario per verificare la firma)
webhookRoutes.post('/', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = stripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    console.error('Webhook Stripe ricevuto ma chiavi non configurate');
    return res.status(503).json({ errore: 'Webhook non configurato (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET mancanti)' });
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (e) {
    console.error('Firma webhook non valida:', e.message);
    return res.status(400).json({ errore: 'Firma webhook non valida' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const sito = handleCheckoutCompleted(event.data.object);
      console.log(`Provisioning completato: sito #${sito.id} (slug: ${sito.slug})`);
    } else if (event.type === 'customer.subscription.deleted') {
      handleSubscriptionDeleted(event.data.object);
      console.log(`Abbonamento ${event.data.object.id} cancellato: sito sospeso`);
    } else {
      console.log(`Webhook ignorato: ${event.type}`);
    }
    res.json({ ricevuto: true });
  } catch (e) {
    console.error('Errore gestione webhook:', e.message);
    res.status(500).json({ errore: e.message });
  }
});

/* ---- 8.5 Siti (equivalente di src/routes/sites.js) --------------------- */

const sitiApi = express.Router();      // montato su /api/sites
const sitiPubblico = express.Router(); // montato su / (GET /s/:slug)

function sitoConTemplate(id) {
  return db.prepare(`
    SELECT s.*, t.categoria, t.nome AS template_nome, t.layout, t.palette, t.font
    FROM siti s JOIN template t ON t.id = s.template_id
    WHERE s.id = ?
  `).get(id);
}

function serializzaSito(sito) {
  return {
    id: sito.id,
    slug: sito.slug,
    stato: sito.stato,
    template_id: sito.template_id,
    template_nome: sito.template_nome,
    categoria: sito.categoria,
    url: `/s/${sito.slug}`,
    contenuti: JSON.parse(sito.contenuti_json || '{}'),
    created_at: sito.created_at,
  };
}

// GET /api/sites/miei — siti dell'utente loggato
sitiApi.get('/miei', richiedeAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, t.categoria, t.nome AS template_nome
    FROM siti s JOIN template t ON t.id = s.template_id
    WHERE s.utente_id = ? ORDER BY s.created_at DESC
  `).all(req.utente.id);
  res.json({ siti: rows.map(serializzaSito) });
});

// PUT /api/sites/:id/contenuti — solo il proprietario; merge dei campi inviati
sitiApi.put('/:id/contenuti', richiedeAuth, (req, res) => {
  const sito = db.prepare('SELECT * FROM siti WHERE id = ?').get(req.params.id);
  if (!sito) return res.status(404).json({ errore: 'Sito non trovato' });
  if (sito.utente_id !== req.utente.id) return res.status(403).json({ errore: 'Non sei il proprietario di questo sito' });

  const nuovi = req.body && typeof req.body === 'object' ? req.body : {};
  const attuali = JSON.parse(sito.contenuti_json || '{}');
  const aggiornati = { ...attuali, ...nuovi };
  db.prepare('UPDATE siti SET contenuti_json = ? WHERE id = ?').run(JSON.stringify(aggiornati), sito.id);
  res.json({ sito: serializzaSito(sitoConTemplate(sito.id)) });
});

// GET /s/:slug — sito pubblico del cliente
sitiPubblico.get('/s/:slug', (req, res) => {
  const sito = db.prepare(`
    SELECT s.*, t.categoria, t.nome AS template_nome, t.layout, t.palette, t.font
    FROM siti s JOIN template t ON t.id = s.template_id
    WHERE s.slug = ?
  `).get(req.params.slug);
  if (!sito) return res.status(404).send('<h1>Sito non trovato</h1>');
  if (sito.stato !== 'attivo') {
    return res.status(410).send('<h1>Sito temporaneamente sospeso</h1><p>Abbonamento non attivo.</p>');
  }
  res.send(renderSito({ sito, template: sito, contenuti: JSON.parse(sito.contenuti_json || '{}') }));
});

/* ---- 8.6 Admin (equivalente di src/routes/admin.js) -------------------- */

const adminRoutes = express.Router();

// GET /api/admin/panoramica — solo admin
adminRoutes.get('/panoramica', richiedeAuth, richiedeAdmin, (req, res) => {
  const conta = (sql, params = []) => db.prepare(sql).get(...params);
  res.json({
    utenti: conta('SELECT COUNT(*) AS c FROM utenti').c,
    abbonamenti_attivi: conta("SELECT COUNT(*) AS c FROM abbonamenti WHERE stato = 'attivo'").c,
    abbonamenti_totali: conta('SELECT COUNT(*) AS c FROM abbonamenti').c,
    template_totali: conta('SELECT COUNT(*) AS c FROM template').c,
    template_riservati: conta('SELECT COUNT(*) AS c FROM template WHERE riservato = 1').c,
    siti_totali: conta('SELECT COUNT(*) AS c FROM siti').c,
    siti_attivi: conta("SELECT COUNT(*) AS c FROM siti WHERE stato = 'attivo'").c,
    siti_sospesi: conta("SELECT COUNT(*) AS c FROM siti WHERE stato = 'sospeso'").c,
  });
});

/* ==========================================================================
 * 9. AVVIO — seed automatico, app Express, ascolto (come src/index.js)
 * ========================================================================== */

// Seed automatico dei template a ogni avvio (idempotente: non duplica,
// non tocca utenti/siti/abbonamenti). Così il deploy funziona anche
// senza eseguire un seed separatamente.
try {
  const { nuovi, dopo } = generaSeed();
  console.log(`Seed template: ${nuovi} nuovi inseriti (totale ${dopo})`);
} catch (e) {
  console.error('Seed automatico fallito:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// Webhook Stripe PRIMA del parser JSON (serve il corpo raw per la firma)
app.use('/api/webhooks/stripe', webhookRoutes);

app.use(express.json({ limit: '1mb' }));

app.get('/api/salute', (req, res) => res.json({ ok: true, servizio: 'sitevaro-backend' }));

// Health check per Render (healthCheckPath in render.yaml)
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/sites', sitiApi);
app.use('/api/admin', adminRoutes);
app.use('/', sitiPubblico); // GET /s/:slug

// 404 JSON per le API
app.use('/api', (req, res) => res.status(404).json({ errore: 'Risorsa non trovata' }));

// Gestore errori generico
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ errore: 'Errore interno del server' });
});

app.listen(PORT, () => {
  console.log(`Sitevaro backend in ascolto su http://localhost:${PORT}`);
  if (!process.env.STRIPE_SECRET_KEY) console.log('⚠️  STRIPE_SECRET_KEY non impostata: i pagamenti restituiranno errore 503 (vedi README).');
  if (!process.env.JWT_SECRET) console.log('⚠️  JWT_SECRET non impostata: auth non funzionerà. Copia .env.example in .env');
});
