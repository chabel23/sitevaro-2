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

CREATE TABLE IF NOT EXISTS materiali (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sito_id INTEGER NOT NULL REFERENCES siti(id),
  utente_id INTEGER NOT NULL REFERENCES utenti(id),
  dati_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_materiali_sito ON materiali(sito_id);

CREATE TABLE IF NOT EXISTS messaggi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  utente_id INTEGER NOT NULL REFERENCES utenti(id),
  testo TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messaggi_utente ON messaggi(utente_id);
`);

// Stato di lavorazione del sito (flusso fatto-per-te): i siti già esistenti
// lo ricevono come 'in-attesa-materiali'.
try {
  const colonneSiti = db.prepare('PRAGMA table_info(siti)').all().map((c) => c.name);
  if (!colonneSiti.includes('lavorazione')) {
    db.exec("ALTER TABLE siti ADD COLUMN lavorazione TEXT NOT NULL DEFAULT 'in-attesa-materiali'");
  }
} catch (e) {
  console.error('Migrazione colonna lavorazione fallita:', e.message);
}

// Nome visualizzato del cliente: la vetrina lo chiede in registrazione e
// lo mostra nel saluto ("Ciao, <nome>") e nelle Impostazioni account.
try {
  const colonneUtenti = db.prepare('PRAGMA table_info(utenti)').all().map((c) => c.name);
  if (!colonneUtenti.includes('nome')) {
    db.exec("ALTER TABLE utenti ADD COLUMN nome TEXT NOT NULL DEFAULT ''");
  }
} catch (e) {
  console.error('Migrazione colonna nome fallita:', e.message);
}

// Cartella dei file caricati dai clienti (foto e logo), sullo stesso disco dati
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) { /* creata al primo upload */ }

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

// Foto di esempio per categoria (Unsplash, verificate il 2026-10-03).
// Ogni template ne riceve una come immagine principale più tre di galleria,
// scelte a rotazione: così le anteprime mostrano un sito vero, con foto,
// e non solo colori. Quando il cliente invia le sue foto, le sostituiscono.
const FOTO_CATEGORIA = {
  'ristorante': [
    '1517248135467-4c7edcad34c4', '1414235077428-338989a2e8c0', '1552566626-52f8b828add9',
    '1555396273-367ea4eb4db5', '1565299624946-b28f40a0ae38', '1504674900247-0877df9cc836',
  ],
  'attivita-locale': [
    '1503951914875-452162b0f3f1', '1560066984-138dadb4c035', '1441986300917-64674bd600d8',
    '1556742049-0cfed4f6a45d', '1600880292203-757bb62b4baf',
  ],
  'freelance-portfolio': [
    '1499951360447-b19be8fe80f5', '1461749280684-dccba630e2f6', '1522542550221-31fd19575a2d',
    '1486312338219-ce68d2c6f44d', '1516035069371-29a1b244cc32', '1493863641943-9b68992a8d07',
  ],
  'e-commerce': [
    '1472851294608-062f824d29cc', '1445205170230-053b83016050', '1523275335684-37898b6baf30',
    '1505740420928-5e560c06d30e', '1560343090-f0409e92791a', '1542291026-7eec264c27ff',
  ],
};

function urlFoto(idFoto, larghezza) {
  return `https://images.unsplash.com/photo-${idFoto}?q=80&w=${larghezza || 1200}&auto=format&fit=crop`;
}

// Foto abbinate a un template: deterministiche (stesso template, stesse foto).
function fotoTemplate(categoria, templateId) {
  const pool = FOTO_CATEGORIA[categoria] || FOTO_CATEGORIA['attivita-locale'];
  const m = String(templateId || '').match(/(\d+)\s*$/);
  const n = m ? parseInt(m[1], 10) : 0;
  const i = ((n % pool.length) + pool.length) % pool.length;
  return {
    hero: urlFoto(pool[i]),
    galleria: [0, 1, 2].map((k) => urlFoto(pool[(i + 1 + k) % pool.length], 800)),
  };
}

// Abbinamento tipografico (titoli + testo) per categoria, dalle coppie
// consigliate dalla skill ui-ux-pro-max installata in ~/workspace/skills:
// ogni template tiene il suo font per i titoli e riceve un font di testo
// pensato per il suo settore (ristorante elegante, negozio leggibile, ecc.).
const FONT_TESTO = {
  'ristorante': 'Karla',
  'attivita-locale': 'Inter',
  'freelance-portfolio': 'Archivo',
  'e-commerce': 'Nunito Sans',
};

function fontTesto(categoria) {
  return FONT_TESTO[categoria] || 'Inter';
}

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

// Pulsante principale per categoria: in alto nella prima schermata e
// ripetuto in fondo (schema consigliato: invito subito + invito finale).
const CTA_SITO = {
  'ristorante': ['Prenota un tavolo', 'tel'],
  'attivita-locale': ['Prenota ora', 'tel'],
  'freelance-portfolio': ['Contattami', 'mail'],
  'e-commerce': ['Scopri i prodotti', '#servizi'],
};

function hero(contenuti, palette, layout, fotoHero, categoria) {
  const titolo = esc(contenuti.nome_attivita);
  const tagline = esc(contenuti.tagline);
  const ctaCfg = CTA_SITO[categoria] || CTA_SITO['attivita-locale'];
  const ctaHref = ctaCfg[1] === 'tel' ? `tel:${esc(contenuti.telefono)}`
    : ctaCfg[1] === 'mail' ? `mailto:${esc(contenuti.email)}` : ctaCfg[1];
  const cta = `<p style="margin:1.75rem 0 0"><a class="sv-btn" href="${ctaHref}" style="${stilePulsante(palette)}">${ctaCfg[0]}</a></p>`;
  if (layout.includes('fullscreen')) {
    return `<section id="home" style="min-height:70vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;background:linear-gradient(rgba(10,15,12,.45),rgba(10,15,12,.6)),url('${esc(fotoHero)}') center/cover,linear-gradient(135deg,${palette.primaria},${palette.secondaria});color:#fff;padding:4rem 1.5rem">
      <h1 style="font-size:3rem;margin:0 0 1rem">${titolo}</h1><p style="font-size:1.3rem;opacity:.9">${tagline}</p>${cta}</section>`;
  }
  if (layout.includes('split') || layout.includes('personale')) {
    return `<section id="home" style="display:flex;flex-wrap:wrap;align-items:center;gap:2rem;padding:4rem 1.5rem;max-width:1100px;margin:0 auto">
      <div style="flex:1;min-width:260px"><h1 style="font-size:2.6rem;margin:0 0 1rem">${titolo}</h1>
      <p style="font-size:1.2rem;color:${palette.secondaria}">${tagline}</p>
      <p>${esc(contenuti.descrizione)}</p>${cta}</div>
      <div style="flex:1;min-width:260px;border-radius:16px;min-height:280px;background:url('${esc(fotoHero)}') center/cover"></div></section>`;
  }
  return `<section id="home" style="text-align:center;padding:4rem 1.5rem 2rem;background:${palette.sfondo}">
    <h1 style="font-size:2.8rem;margin:0 0 1rem">${titolo}</h1><p style="font-size:1.25rem">${tagline}</p>${cta}
    <img src="${esc(fotoHero)}" alt="${titolo}" style="width:min(900px,100%);height:340px;object-fit:cover;border-radius:16px;margin-top:2rem"></section>`;
}

function sezioniCategoria(contenuti, palette, categoria, foto) {
  const immagini = Array.isArray(foto) && foto.length ? foto : [];
  const card = (titolo, corpo, extra = '', indice = 0) =>
    `<div class="sv-card" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05)">
      ${immagini.length ? `<img src="${esc(immagini[indice % immagini.length])}" alt="" loading="lazy" style="width:100%;height:150px;object-fit:cover;display:block">` : ''}
      <div style="padding:1.25rem 1.5rem 1.5rem"><h3 style="margin-top:0;color:${palette.primaria}">${esc(titolo)}</h3><p>${esc(corpo)}</p>${extra}</div></div>`;
  const griglia = (items) =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem">${items}</div>`;

  if (categoria === 'ristorante' && contenuti.piatti) {
    return `<section id="servizi" style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>Il nostro menu</h2>${griglia(contenuti.piatti.map((p, i) =>
      card(p.nome, p.descrizione, `<strong>${esc(p.prezzo)}</strong>`, i)).join(''))}</section>
      <section style="max-width:1100px;margin:0 auto;padding:1rem 1.5rem 3rem"><p><strong>Orari:</strong> ${esc(contenuti.orari)}</p></section>`;
  }
  if (categoria === 'attivita-locale' && contenuti.servizi) {
    return `<section id="servizi" style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>I nostri servizi</h2>${griglia(contenuti.servizi.map((s, i) =>
      card(s.nome, s.descrizione, '', i)).join(''))}</section>
      <section style="max-width:1100px;margin:0 auto;padding:1rem 1.5rem 3rem"><p><strong>Orari:</strong> ${esc(contenuti.orari)}</p></section>`;
  }
  if (categoria === 'freelance-portfolio' && contenuti.progetti) {
    return `<section id="servizi" style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2 style="color:${palette.secondaria}">${esc(contenuti.ruolo)}</h2>
      <p>${esc(contenuti.bio)}</p><h2>Progetti</h2>${griglia(contenuti.progetti.map((p, i) =>
      card(p.titolo, p.descrizione, '', i)).join(''))}</section>`;
  }
  if (categoria === 'e-commerce' && contenuti.prodotti) {
    return `<section id="servizi" style="max-width:1100px;margin:0 auto;padding:2rem 1.5rem"><h2>I nostri prodotti</h2>${griglia(contenuti.prodotti.map((p, i) =>
      card(p.nome, p.descrizione, `<div style="margin-top:.5rem"><strong>${esc(p.prezzo)}</strong>
      <a class="sv-btn" href="mailto:${esc(contenuti.email)}?subject=Ordine: ${esc(p.nome)}" style="${stilePulsante(palette)};margin-left:.75rem;padding:.5rem 1rem">Ordina</a></div>`, i)).join(''))}</section>`;
  }
  return '';
}

function renderSito({ sito, template, contenuti }) {
  const palette = JSON.parse(template.palette);
  const font = template.font;
  const titolo = esc(contenuti.nome_attivita || template.nome);
  const fotoTpl = fotoTemplate(template.categoria, template.id);
  const fotoSito = Array.isArray(contenuti.foto) && contenuti.foto.length
    ? contenuti.foto
    : [fotoTpl.hero, ...fotoTpl.galleria];
  const etichettaSezione = { 'ristorante': 'Menu', 'attivita-locale': 'Servizi', 'freelance-portfolio': 'Progetti', 'e-commerce': 'Prodotti' }[template.categoria] || 'Servizi';

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titolo} — powered by Sitevaro</title>
<link href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;600;700&family=${encodeURIComponent(fontTesto(template.categoria))}:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
html{scroll-behavior:smooth}
body{font-family:'${fontTesto(template.categoria)}',system-ui,sans-serif;margin:0;background:${palette.sfondo};color:${palette.testo};line-height:1.6;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:'${font}',serif;line-height:1.12;letter-spacing:-.01em}
h2{font-size:clamp(1.55rem,3.2vw,2.15rem);margin:0 0 1rem}
section{scroll-margin-top:84px}
a{transition:color .2s ease,background-color .2s ease,transform .2s ease,box-shadow .25s ease,filter .2s ease}
:focus-visible{outline:3px solid ${palette.accento};outline-offset:2px;border-radius:4px}
.sv-card{transition:transform .25s ease,box-shadow .25s ease}
.sv-card:hover{transform:translateY(-4px);box-shadow:0 14px 30px rgba(15,25,20,.13)}
.sv-btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
img{background:#e8e2d2}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}*,*::before,*::after{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<header style="display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap;padding:1rem 1.5rem;background:${palette.secondaria};color:#fff;position:sticky;top:0;z-index:20;box-shadow:0 2px 12px rgba(0,0,0,.15)">
  <strong style="font-size:1.2rem">${titolo}</strong>
  <nav style="display:flex;gap:1.25rem;flex-wrap:wrap;font-size:.95rem">
    <a href="#home" style="color:#fff;text-decoration:none">Home</a>
    <a href="#servizi" style="color:#fff;text-decoration:none">${etichettaSezione}</a>
    <a href="#foto" style="color:#fff;text-decoration:none">Foto</a>
    <a href="#contatti" style="color:#fff;text-decoration:none">Contatti</a>
  </nav>
  <a href="tel:${esc(contenuti.telefono)}" style="color:#fff;text-decoration:none">${esc(contenuti.telefono)}</a>
</header>
${hero(contenuti, palette, template.layout, fotoSito[0], template.categoria)}
<section id="chisiamo" style="max-width:1100px;margin:0 auto;padding:2.5rem 1.5rem 0.5rem"><h2>Chi siamo</h2><p style="font-size:1.05rem;line-height:1.6">${esc(contenuti.descrizione)}</p></section>
${sezioniCategoria(contenuti, palette, template.categoria, fotoSito)}
${Array.isArray(contenuti.recensioni) && contenuti.recensioni.length ? `<section id="recensioni" style="max-width:1100px;margin:0 auto;padding:0 1.5rem 3rem"><h2>Cosa dicono di noi</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1.25rem">${contenuti.recensioni.slice(0, 6).map((r) => `<div class="sv-card" style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1.5rem;box-shadow:0 2px 8px rgba(0,0,0,.05)"><div style="color:${palette.accento};letter-spacing:.15em" aria-hidden="true">${'★'.repeat(Math.max(1, Math.min(5, r.stelle || 5)))}</div><p style="font-style:italic">“${esc(r.testo)}”</p><strong>${esc(r.nome)}</strong></div>`).join('')}</div></section>` : ''}
<section id="foto" style="max-width:1100px;margin:0 auto;padding:0 1.5rem 3rem"><h2>Le nostre foto</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem">${fotoSito.map((f) => `<img src="${esc(f)}" alt="" loading="lazy" style="width:100%;height:220px;object-fit:cover;border-radius:12px">`).join('')}</div></section>
${Array.isArray(contenuti.faq) && contenuti.faq.length ? `<section id="faq" style="max-width:1100px;margin:0 auto;padding:0 1.5rem 3rem"><h2>Domande frequenti</h2>${contenuti.faq.slice(0, 8).map((f) => `<details style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:1rem 1.25rem;margin-bottom:.75rem"><summary style="font-weight:600;cursor:pointer;padding:.25rem 0">${esc(f.domanda || f.d || '')}</summary><p>${esc(f.risposta || f.r || '')}</p></details>`).join('')}</section>` : ''}
<section id="contatti" style="max-width:1100px;margin:0 auto;padding:0 1.5rem 3.5rem"><h2>Contatti</h2>
  <p style="line-height:1.7">${esc(contenuti.indirizzo)}<br>Telefono: <a href="tel:${esc(contenuti.telefono)}" style="color:${palette.primaria}">${esc(contenuti.telefono)}</a><br>Email: <a href="mailto:${esc(contenuti.email)}" style="color:${palette.primaria}">${esc(contenuti.email)}</a>${contenuti.orari ? `<br>Orari: ${esc(contenuti.orari)}` : ''}</p>
  ${contenuti.indirizzo ? `<div style="margin:1.25rem 0"><iframe title="Dove siamo: ${esc(contenuti.indirizzo)}" src="https://www.google.com/maps?q=${encodeURIComponent(contenuti.indirizzo)}&output=embed" loading="lazy" style="width:100%;height:280px;border:0;border-radius:12px"></iframe></div>` : ''}
  <p><a class="sv-btn" href="tel:${esc(contenuti.telefono)}" style="${stilePulsante(palette)}">Chiamaci ora</a></p></section>
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
    const utente = db.prepare('SELECT id, email, nome, is_admin, created_at FROM utenti WHERE id = ?').get(payload.id);
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

// POST /api/auth/register { nome?, email, password }
authRoutes.post('/register', (req, res) => {
  const { nome, email, password } = req.body || {};
  if (!emailValida(email)) return res.status(400).json({ errore: 'Email non valida' });
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ errore: 'La password deve avere almeno 8 caratteri' });
  }
  const emailNorm = email.trim().toLowerCase();
  const esiste = db.prepare('SELECT id FROM utenti WHERE email = ?').get(emailNorm);
  if (esiste) return res.status(409).json({ errore: 'Email già registrata' });

  const nomeNorm = typeof nome === 'string' ? nome.trim().slice(0, 80) : '';
  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO utenti (email, nome, password_hash) VALUES (?, ?, ?)').run(emailNorm, nomeNorm, password_hash);
  const utente = db.prepare('SELECT id, email, nome, is_admin, created_at FROM utenti WHERE id = ?').get(info.lastInsertRowid);
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
  const utente = { id: row.id, email: row.email, nome: row.nome || '', is_admin: !!row.is_admin, created_at: row.created_at };
  res.json({ utente, token: firmaToken(utente) });
});

// GET /api/auth/me
authRoutes.get('/me', richiedeAuth, (req, res) => {
  res.json({ utente: req.utente });
});

// PATCH /api/auth/profilo { nome } — nome visualizzato dell'account
authRoutes.patch('/profilo', richiedeAuth, (req, res) => {
  const nome = typeof (req.body && req.body.nome) === 'string' ? req.body.nome.trim().slice(0, 80) : '';
  db.prepare('UPDATE utenti SET nome = ? WHERE id = ?').run(nome, req.utente.id);
  const utente = db.prepare('SELECT id, email, nome, is_admin, created_at FROM utenti WHERE id = ?').get(req.utente.id);
  res.json({ utente });
});

// POST /api/auth/cambia-password { passwordAttuale, nuovaPassword }
authRoutes.post('/cambia-password', richiedeAuth, (req, res) => {
  const { passwordAttuale, nuovaPassword } = req.body || {};
  if (typeof nuovaPassword !== 'string' || nuovaPassword.length < 8) {
    return res.status(400).json({ errore: 'La nuova password deve avere almeno 8 caratteri' });
  }
  const row = db.prepare('SELECT password_hash FROM utenti WHERE id = ?').get(req.utente.id);
  if (!row || typeof passwordAttuale !== 'string' || !bcrypt.compareSync(passwordAttuale, row.password_hash)) {
    return res.status(401).json({ errore: 'La password attuale non è corretta' });
  }
  db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(nuovaPassword, 10), req.utente.id);
  res.json({ ok: true });
});

// POST /api/auth/cambia-email { password, nuovaEmail } — restituisce un token nuovo
authRoutes.post('/cambia-email', richiedeAuth, (req, res) => {
  const { password, nuovaEmail } = req.body || {};
  if (!emailValida(nuovaEmail)) return res.status(400).json({ errore: 'Email non valida' });
  const emailNorm = nuovaEmail.trim().toLowerCase();
  if (emailNorm === req.utente.email) return res.status(400).json({ errore: 'È già la tua email' });
  const row = db.prepare('SELECT password_hash FROM utenti WHERE id = ?').get(req.utente.id);
  if (!row || typeof password !== 'string' || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ errore: 'Password non corretta' });
  }
  const esiste = db.prepare('SELECT id FROM utenti WHERE email = ? AND id != ?').get(emailNorm, req.utente.id);
  if (esiste) return res.status(409).json({ errore: 'Email già usata da un altro account' });
  db.prepare('UPDATE utenti SET email = ? WHERE id = ?').run(emailNorm, req.utente.id);
  const utente = db.prepare('SELECT id, email, nome, is_admin, created_at FROM utenti WHERE id = ?').get(req.utente.id);
  res.json({ utente, token: firmaToken(utente) });
});

/* ---- 8.2 Template (equivalente di src/routes/templates.js) ------------- */

const templateRoutes = express.Router();

function serializzaTemplate(row) {
  if (!row) return null;
  const foto = fotoTemplate(row.categoria, row.id);
  return {
    id: row.id,
    categoria: row.categoria,
    nome: row.nome,
    layout: row.layout,
    palette: JSON.parse(row.palette),
    font: row.font,
    riservato: !!row.riservato,
    foto: foto.hero,
    foto_galleria: foto.galleria,
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
    lavorazione: sito.lavorazione || 'in-attesa-materiali',
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

// POST /api/sites/:id/materiali — il cliente invia testi, foto e logo.
// I campi di testo compilano subito i contenuti del sito; menu/listino e
// note restano nei materiali a disposizione di chi costruisce il sito.
// Foto: [{ nome, tipo, dati (base64, anche con prefisso data:) }]; logo analogo.
sitiApi.post('/:id/materiali', richiedeAuth, (req, res) => {
  const sito = db.prepare('SELECT * FROM siti WHERE id = ?').get(req.params.id);
  if (!sito) return res.status(404).json({ errore: 'Sito non trovato' });
  if (sito.utente_id !== req.utente.id) return res.status(403).json({ errore: 'Non sei il proprietario di questo sito' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const campiTesto = {};
  for (const k of ['nome_attivita', 'tagline', 'descrizione', 'telefono', 'email', 'indirizzo', 'orari', 'ruolo', 'bio']) {
    if (typeof body[k] === 'string' && body[k].trim()) campiTesto[k] = body[k].trim().slice(0, 2000);
  }

  const salvaImmagine = (img, prefisso) => {
    if (!img || typeof img.dati !== 'string') return null;
    const base64 = img.dati.includes(',') ? img.dati.split(',').pop() : img.dati;
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { return null; }
    if (buf.length < 1024 || buf.length > 8 * 1024 * 1024) return null;
    const tipo = (img.tipo || '').toLowerCase();
    const est = tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : 'jpg';
    const nomeFile = `${prefisso}-${sito.id}-${crypto.randomBytes(8).toString('hex')}.${est}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, nomeFile), buf);
    return `/uploads/${nomeFile}`;
  };

  const foto = [];
  if (Array.isArray(body.foto)) {
    for (const img of body.foto.slice(0, 8)) {
      const url = salvaImmagine(img, 'foto');
      if (url) foto.push(url);
    }
  }
  const logo = salvaImmagine(body.logo, 'logo');

  const attuali = JSON.parse(sito.contenuti_json || '{}');
  const aggiornati = { ...attuali, ...campiTesto };
  if (foto.length) aggiornati.foto = [...(Array.isArray(attuali.foto) ? attuali.foto : []), ...foto].slice(0, 12);
  if (logo) aggiornati.logo = logo;
  db.prepare('UPDATE siti SET contenuti_json = ?, lavorazione = ? WHERE id = ?')
    .run(JSON.stringify(aggiornati), 'materiali-ricevuti', sito.id);

  db.prepare('INSERT INTO materiali (sito_id, utente_id, dati_json) VALUES (?, ?, ?)')
    .run(sito.id, req.utente.id, JSON.stringify({
      campi: campiTesto,
      elenco_testo: typeof body.elenco_testo === 'string' ? body.elenco_testo.slice(0, 20000) : '',
      note: typeof body.note === 'string' ? body.note.slice(0, 5000) : '',
      foto,
      logo,
    }));

  res.json({ ok: true, foto, lavorazione: 'materiali-ricevuti', sito: serializzaSito(sitoConTemplate(sito.id)) });
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

// GET /api/admin/ordini — siti con cliente, template, lavorazione e materiali
adminRoutes.get('/ordini', richiedeAuth, richiedeAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, t.categoria, t.nome AS template_nome, u.email AS email_cliente
    FROM siti s
    JOIN template t ON t.id = s.template_id
    JOIN utenti u ON u.id = s.utente_id
    ORDER BY s.created_at DESC
  `).all();
  const ordini = rows.map((s) => {
    const m = db.prepare('SELECT dati_json, created_at FROM materiali WHERE sito_id = ? ORDER BY id DESC LIMIT 1').get(s.id);
    return {
      ...serializzaSito(s),
      email_cliente: s.email_cliente,
      materiali: m ? { ...JSON.parse(m.dati_json || '{}'), inviati_il: m.created_at } : null,
    };
  });
  res.json({ ordini });
});

// PATCH /api/admin/siti/:id/lavorazione { stato } — avanza il lavoro sul sito
adminRoutes.patch('/siti/:id/lavorazione', richiedeAuth, richiedeAdmin, (req, res) => {
  const stati = ['in-attesa-materiali', 'materiali-ricevuti', 'in-lavorazione', 'pubblicato'];
  const stato = req.body && req.body.stato;
  if (!stati.includes(stato)) return res.status(400).json({ errore: 'Stato non valido' });
  const info = db.prepare('UPDATE siti SET lavorazione = ? WHERE id = ?').run(stato, req.params.id);
  if (!info.changes) return res.status(404).json({ errore: 'Sito non trovato' });
  res.json({ ok: true, lavorazione: stato });
});

// PUT /api/admin/siti/:id/contenuti — l'operatore compila i contenuti veri
adminRoutes.put('/siti/:id/contenuti', richiedeAuth, richiedeAdmin, (req, res) => {
  const sito = db.prepare('SELECT * FROM siti WHERE id = ?').get(req.params.id);
  if (!sito) return res.status(404).json({ errore: 'Sito non trovato' });
  const nuovi = req.body && typeof req.body === 'object' ? req.body : {};
  const attuali = JSON.parse(sito.contenuti_json || '{}');
  db.prepare('UPDATE siti SET contenuti_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...attuali, ...nuovi }), sito.id);
  res.json({ sito: serializzaSito(sitoConTemplate(sito.id)) });
});

// GET /api/admin/messaggi — messaggi di assistenza scritti dai clienti
adminRoutes.get('/messaggi', richiedeAuth, richiedeAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT m.id, m.testo, m.created_at, u.email AS email_cliente, u.nome AS nome_cliente
    FROM messaggi m JOIN utenti u ON u.id = m.utente_id
    ORDER BY m.id DESC LIMIT 50
  `).all();
  res.json({ messaggi: rows });
});

/* ---- 8.9 Account cliente: abbonamento, fatture, portale Stripe -------- */

const accountRoutes = express.Router();

// Cliente Stripe dell'utente: lo ricaviamo dall'ultima sottoscrizione
// registrata (nel DB non salviamo il customer id separatamente).
async function clienteStripeDi(utenteId) {
  const stripe = stripeClient();
  if (!stripe) return { stripe: null, customerId: null };
  const abb = db.prepare(
    'SELECT stripe_subscription_id FROM abbonamenti WHERE utente_id = ? AND stripe_subscription_id IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(utenteId);
  if (!abb) return { stripe, customerId: null };
  try {
    const sub = await stripe.subscriptions.retrieve(abb.stripe_subscription_id);
    return { stripe, customerId: sub.customer || null };
  } catch (e) {
    return { stripe, customerId: null };
  }
}

// GET /api/account/abbonamento — piani dell'utente con stato e prossimo rinnovo
accountRoutes.get('/abbonamento', richiedeAuth, async (req, res) => {
  const rows = db.prepare('SELECT * FROM abbonamenti WHERE utente_id = ? ORDER BY id DESC').all(req.utente.id);
  const stripe = stripeClient();
  const abbonamenti = [];
  for (const a of rows) {
    const info = PREZZI[a.price_id] || null;
    const voce = {
      id: a.id,
      stato: a.stato,
      piano: info ? info.piano : null,
      importo: info ? info.importo : null,
      periodo: info ? info.periodo : null,
      dal: a.created_at,
      prossimo_rinnovo: null,
      cancella_a_fine_periodo: false,
    };
    if (stripe && a.stripe_subscription_id && a.stato === 'attivo') {
      try {
        const sub = await stripe.subscriptions.retrieve(a.stripe_subscription_id);
        voce.prossimo_rinnovo = sub.current_period_end
          ? new Date(sub.current_period_end * 1000).toISOString() : null;
        voce.cancella_a_fine_periodo = !!sub.cancel_at_period_end;
      } catch (e) { /* Stripe non raggiungibile: restano i dati del DB */ }
    }
    abbonamenti.push(voce);
  }
  res.json({ abbonamenti });
});

// GET /api/account/fatture — ultime fatture Stripe dell'utente
accountRoutes.get('/fatture', richiedeAuth, async (req, res) => {
  const { stripe, customerId } = await clienteStripeDi(req.utente.id);
  if (!stripe || !customerId) return res.json({ fatture: [] });
  try {
    const lista = await stripe.invoices.list({ customer: customerId, limit: 12 });
    const fatture = (lista.data || []).map((inv) => ({
      id: inv.id,
      numero: inv.number || '',
      data: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      importo: (inv.amount_paid || inv.total || 0) / 100,
      valuta: (inv.currency || 'eur').toUpperCase(),
      stato: inv.status || '',
      url: inv.hosted_invoice_url || null,
      pdf: inv.invoice_pdf || null,
    }));
    res.json({ fatture });
  } catch (e) {
    res.json({ fatture: [] });
  }
});

// POST /api/account/portale — sessione del portale clienti Stripe
// (carta di pagamento, fatture, cancellazione: li gestisce Stripe)
accountRoutes.post('/portale', richiedeAuth, async (req, res) => {
  const { stripe, customerId } = await clienteStripeDi(req.utente.id);
  if (!stripe) return res.status(503).json({ errore: 'Pagamenti non configurati sul server' });
  if (!customerId) return res.status(400).json({ errore: 'Nessun abbonamento da gestire' });
  const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${baseUrl}/`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Errore portale Stripe:', e.message);
    res.status(502).json({ errore: 'Impossibile aprire la gestione abbonamento', dettaglio: e.message });
  }
});

// POST /api/account/assistenza { testo } — messaggio di assistenza del cliente.
// Nessuna email esposta sul sito: l'operatore li legge nel pannello admin.
accountRoutes.post('/assistenza', richiedeAuth, (req, res) => {
  const testo = typeof (req.body && req.body.testo) === 'string' ? req.body.testo.trim() : '';
  if (testo.length < 3) return res.status(400).json({ errore: 'Scrivi un messaggio un po’ più lungo' });
  if (testo.length > 4000) return res.status(400).json({ errore: 'Messaggio troppo lungo' });
  db.prepare('INSERT INTO messaggi (utente_id, testo) VALUES (?, ?)').run(req.utente.id, testo);
  res.json({ ok: true });
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

// Promozione amministratore: se ADMIN_EMAIL è impostata e l'utente esiste,
// diventa admin (serve all'operatore Sitevaro per vedere gli ordini).
if (process.env.ADMIN_EMAIL) {
  try {
    const info = db.prepare('UPDATE utenti SET is_admin = 1 WHERE lower(email) = lower(?)')
      .run(process.env.ADMIN_EMAIL.trim());
    if (info.changes) console.log(`Admin Sitevaro attivo per ${process.env.ADMIN_EMAIL}`);
  } catch (e) { console.error('Promozione admin fallita:', e.message); }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));

// Webhook Stripe PRIMA del parser JSON (serve il corpo raw per la firma)
app.use('/api/webhooks/stripe', webhookRoutes);

// I materiali dei clienti includono foto in base64: per le sole rotte
// /api/sites alziamo il limite del corpo a 30 MB (prima del parser globale).
app.use('/api/sites', express.json({ limit: '30mb' }));
app.use(express.json({ limit: '1mb' }));

// Foto e loghi caricati dai clienti
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

app.get('/api/salute', (req, res) => res.json({ ok: true, servizio: 'sitevaro-backend' }));

// Health check per Render (healthCheckPath in render.yaml)
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Vetrina pubblica Sitevaro servita alla radice: stesso server dell'API,
// così la pagina parla con le API in stessa origine e nessun filtro esterno
// può bloccarla. Il CSP di helmet è troppo stretto per la pagina (script
// inline), quindi per questa sola rotta lo sostituiamo con uno permissivo.
let vetrinaHtml = null;
try {
  vetrinaHtml = fs.readFileSync(path.join(__dirname, 'vetrina.html'), 'utf8');
} catch (e) {
  console.warn('⚠️  vetrina.html non trovata: la vetrina alla radice non sarà servita.');
}
app.get('/', (req, res) => {
  if (!vetrinaHtml) return res.status(503).send('Vetrina non disponibile');
  res.setHeader('Content-Security-Policy',
    "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type('html').send(vetrinaHtml);
});

app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/checkout', checkoutRoutes);
app.use('/api/sites', sitiApi);
app.use('/api/admin', adminRoutes);
app.use('/api/account', accountRoutes);
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
