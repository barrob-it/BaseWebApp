#!/usr/bin/env node
'use strict';

/**
 * figma-export.js  –  v2
 *
 * Esporta un frame Figma come template HubSpot DND (drag-and-drop) editabile.
 *
 * Approccio:
 *   1. Legge il JSON Figma in profondità (depth 8) per trovare le sezioni reali
 *   2. Per ogni sezione estrae i TEXT node (contenuto editabile)
 *   3. Esporta ogni sezione come immagine di sfondo
 *   4. Genera un template HubSpot DND:
 *        - Nav = modulo HTML con menu reale
 *        - Sezioni visive (hero, ecc.) = dnd_section con bg-image + rich_text editabile
 *        - Sezioni testo (su sfondo chiaro) = dnd_section con rich_text editabile
 *   5. Carica le immagini su HubSpot File Manager
 *   6. Salva template.html pronto per il Design Manager
 *
 * Uso: source .env && node figma-export.js
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { URL } = require('url');
const crypto  = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const FIGMA_TOKEN   = process.env.FIGMA_TOKEN   || '';
const FIGMA_FILE_ID = process.env.FIGMA_FILE_ID || '';
const FIGMA_NODE_ID = process.env.FIGMA_NODE_ID || '292:76';
const HS_TOKEN      = process.env.HS_TOKEN      || '';
const HS_BASE       = 'https://api.hubapi.com';
const HS_FOLDER     = '/figma-exports';
const OUT_DIR       = path.join(__dirname, 'figma-export');
const SCALE         = 2;
const IMG_FORMAT    = 'png';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === 'https:' ? https : http;
    mod.get(url, { headers }, res => {
      if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location)
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400)
          return reject(new Error(`GET ${url} → ${res.statusCode}: ${body.toString().slice(0,300)}`));
        resolve({ status: res.statusCode, body, text: body.toString() });
      });
    }).on('error', reject);
  });
}

function httpPost(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;
    const req     = mod.request({
      hostname: parsed.hostname,
      port    : parsed.port || 443,
      path    : parsed.pathname + parsed.search,
      method  : 'POST',
      headers : { 'Content-Length': bodyBuf.length, ...extraHeaders },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400)
          return reject(new Error(`POST ${url} → ${res.statusCode}: ${text.slice(0,500)}`));
        resolve(JSON.parse(text));
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function buildMultipart(fields, files) {
  const boundary = '----FormBoundary' + crypto.randomBytes(12).toString('hex');
  const parts    = [];
  for (const [name, value] of Object.entries(fields))
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(String(value)), Buffer.from('\r\n')
    );
  for (const { name, filename, contentType, data } of files)
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data, Buffer.from('\r\n')
    );
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── Figma API ────────────────────────────────────────────────────────────────
async function figmaGet(endpoint) {
  const { text } = await httpGet(`https://api.figma.com/v1${endpoint}`, { 'X-Figma-Token': FIGMA_TOKEN });
  const json = JSON.parse(text);
  if (json.status >= 400) throw new Error(`Figma: ${json.err || JSON.stringify(json)}`);
  return json;
}

async function getFrameDeep() {
  console.log('📐 Recupero struttura Figma (depth 8)...');
  // Fetch con depth elevato per avere tutto l'albero
  const data = await figmaGet(`/files/${FIGMA_FILE_ID}/nodes?ids=${encodeURIComponent(FIGMA_NODE_ID)}&geometry=paths`);
  const nodeKey = Object.keys(data.nodes)[0];
  return data.nodes[nodeKey].document;
}

async function exportImages(nodeIds) {
  console.log(`🖼  Esporto ${nodeIds.length} immagini da Figma...`);
  const data = await figmaGet(
    `/images/${FIGMA_FILE_ID}?ids=${nodeIds.map(encodeURIComponent).join(',')}&format=${IMG_FORMAT}&scale=${SCALE}`
  );
  if (data.err) throw new Error(`Figma export: ${data.err}`);
  return data.images;
}

// ─── HubSpot API ──────────────────────────────────────────────────────────────
async function uploadToHubSpot(filepath, filename) {
  const fileData = fs.readFileSync(filepath);
  const { body, contentType } = buildMultipart(
    { options: JSON.stringify({ access: 'PUBLIC_INDEXABLE' }), folderPath: HS_FOLDER },
    [{ name: 'file', filename, contentType: 'image/png', data: fileData }]
  );
  const result = await httpPost(`${HS_BASE}/files/v3/files`, body,
    { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': contentType }
  );
  return result.url;
}

// ─── Figma → struttura ────────────────────────────────────────────────────────

// Colore RGBA → stringa CSS hex o rgba
function figmaColor(color) {
  if (!color) return null;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = color.a !== undefined ? color.a : 1;
  return a < 1 ? `rgba(${r},${g},${b},${a.toFixed(2)})` : `#${[r,g,b].map(v => v.toString(16).padStart(2,'0')).join('')}`;
}

// Primo colore pieno di un array di fills
function firstSolidColor(fills) {
  const f = (fills || []).find(f => f.type === 'SOLID' && (f.opacity || 1) > 0.1);
  return f ? figmaColor(f.color) : null;
}

// Luminosità di un colore hex (0-255)
function luminance(hex) {
  if (!hex || !hex.startsWith('#')) return 255;
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return 0.299*r + 0.587*g + 0.114*b;
}

// Una sezione è "scura" se ha sfondo con luminosità < 100
function isDarkSection(node) {
  const color = firstSolidColor(node.background || node.fills);
  return luminance(color) < 100;
}

// Estrae tutti i TEXT node sotto un nodo
function extractTexts(node) {
  const texts = [];
  function walk(n) {
    if (n.type === 'TEXT' && n.characters?.trim()) texts.push(n);
    if (n.children) n.children.forEach(walk);
  }
  walk(node);
  return texts;
}

// Converte testi Figma in HTML con h1/h2/h3/p basato sulla dimensione
function textsToHTML(texts, isDark) {
  const sorted = [...texts].sort((a, b) => {
    const ay = a.absoluteBoundingBox?.y || 0;
    const by = b.absoluteBoundingBox?.y || 0;
    return ay !== by ? ay - by : (a.absoluteBoundingBox?.x || 0) - (b.absoluteBoundingBox?.x || 0);
  });

  return sorted.map(t => {
    const size   = t.style?.fontSize || 16;
    const weight = t.style?.fontWeight || 400;
    const family = t.style?.fontFamily || 'sans-serif';
    const color  = firstSolidColor(t.fills) || (isDark ? '#ffffff' : '#1a1a1a');
    const tag    = size >= 48 ? 'h1' : size >= 32 ? 'h2' : size >= 22 ? 'h3' : size >= 18 ? 'h4' : 'p';
    const style  = `font-family:'${family}',sans-serif;font-size:${size}px;font-weight:${weight};color:${color};margin:0 0 0.5em;line-height:1.3;`;
    const text   = t.characters.replace(/\n/g, '<br>');
    return `<${tag} style="${style}">${esc(text)}</${tag}>`;
  }).join('\n          ');
}

// Estrae le voci di menu dal frame nav
function extractNavItems(navNode) {
  const texts = extractTexts(navNode);
  return texts.map(t => t.characters.trim()).filter(Boolean);
}

// Cerca il logo nel frame nav (primo IMAGE fill)
function findLogoUrl(navNode) {
  function walk(n) {
    const imgFill = (n.fills || []).find(f => f.type === 'IMAGE');
    if (imgFill) return imgFill;
    for (const c of (n.children || [])) { const r = walk(c); if (r) return r; }
    return null;
  }
  return walk(navNode);
}

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Carattere " in HubL attribute → &quot;
function escAttr(html) {
  return html.replace(/"/g, '&quot;');
}

// ─── Trovare le sezioni reali ─────────────────────────────────────────────────
function findRealSections(frameNode) {
  // Il frame può avere "nav" e "body" come figli diretti.
  // Le sezioni reali sono dentro "body".
  const nav  = frameNode.children?.find(c => c.name.toLowerCase() === 'nav');
  const body = frameNode.children?.find(c => c.name.toLowerCase() === 'body' || c.name.toLowerCase() === 'content');
  const sections = body
    ? (body.children || []).filter(c => c.absoluteBoundingBox)
    : (frameNode.children || []).filter(c => c.name.toLowerCase() !== 'nav' && c.absoluteBoundingBox);
  return { nav, sections };
}

// ─── Generatore template HubSpot DND ─────────────────────────────────────────
function generateNavHTML(navNode, navItems) {
  const bgColor = firstSolidColor(navNode?.fills || navNode?.background) || '#1a0000';
  const menuHTML = navItems.slice(0, 8)
    .map(label => `<li style="margin:0;padding:0;"><a href="#" style="color:#fff;text-decoration:none;font-family:sans-serif;font-size:15px;white-space:nowrap;">${esc(label)}</a></li>`)
    .join('\n          ');

  return `  <!-- ── Navigazione ── -->
  <header style="background:${bgColor};padding:0 5%;display:flex;align-items:center;justify-content:space-between;height:64px;position:sticky;top:0;z-index:100;">
    <div style="font-weight:bold;color:#fff;font-size:18px;">ETL ITALIA</div>
    <nav>
      <ul style="display:flex;gap:28px;list-style:none;margin:0;padding:0;align-items:center;">
        ${menuHTML}
      </ul>
    </nav>
  </header>`;
}

function generateDNDSection(section, bgUrl, textHTML, isDark) {
  const bb          = section.absoluteBoundingBox || {};
  const ratio       = bb.height && bb.width ? (bb.height / bb.width * 100).toFixed(2) : '50';
  const textColor   = isDark ? '#ffffff' : '#1a1a1a';

  // Padding proporzionale all'altezza per dare spazio al testo
  const vPad = Math.min(80, Math.max(20, Math.round(bb.height * 0.08)));

  const bgProp = bgUrl
    ? `background_image={"backgroundPosition": "top center", "backgroundSize": "cover", "src": "${bgUrl}"}`
    : ``;

  return `
  {# ──── ${section.name} ──── #}
  {% dnd_section
     ${bgProp}
     padding={"top": ${vPad}, "bottom": ${vPad}, "left": 0, "right": 0}
     min_height=${Math.round((bb.height || 400) / 2)}
  %}
    {% dnd_column width=12 %}
      {% dnd_row %}
        {% dnd_module path="@hubspot/rich_text"
           label="${esc(section.name)}"
           html="${escAttr(textHTML)}"
        %}{% end_dnd_module %}
      {% end_dnd_row %}
    {% end_dnd_column %}
  {% end_dnd_section %}`;
}

function generateTemplate(pageName, navHTML, dndSections) {
  return `<!DOCTYPE html>
<!--
  templateType: page
  isAvailableForNewContent: true
  label: ETL Italy - ${pageName}
-->
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ content.html_title }}</title>
  <meta name="description" content="{{ content.meta_description }}">
  {{ standard_header_includes }}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
    .hs-page-width-normal { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
${navHTML}

  {% dnd_area "main" label="Contenuto pagina" %}
${dndSections}
  {% end_dnd_area %}

  {{ standard_footer_includes }}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!FIGMA_TOKEN || !FIGMA_FILE_ID || !HS_TOKEN) {
    console.error('❌ Variabili mancanti. Esegui: source .env && node figma-export.js');
    process.exit(1);
  }

  console.log('\n🚀 Figma → HubSpot DND Export  (v2)\n' + '─'.repeat(40));

  // 1. Struttura completa
  const frame = await getFrameDeep();
  const bb    = frame.absoluteBoundingBox || { width: 1440, height: 5000 };
  console.log(`\n✅ Frame: "${frame.name}" (${bb.width}×${bb.height}px)`);

  const { nav, sections } = findRealSections(frame);
  console.log(`   Nav trovata : ${nav ? `"${nav.name}" (${nav.absoluteBoundingBox?.width}×${nav.absoluteBoundingBox?.height})` : 'no'}`);
  console.log(`   Sezioni reali: ${sections.length}`);
  sections.forEach((s, i) => {
    const cbb = s.absoluteBoundingBox || {};
    const txtCount = extractTexts(s).length;
    console.log(`   ${i+1}. "${s.name}" (${cbb.width}×${cbb.height}) — ${txtCount} testi`);
  });

  // 2. Export immagini (sezioni + nav)
  const toExport = [...sections.map(s => s.id), ...(nav ? [nav.id] : [])];
  const imageUrls = await exportImages(toExport);

  // 3. Download + upload su HubSpot
  console.log('\n⬇️  Download & upload immagini...');
  const sectionData = [];

  for (const section of sections) {
    const figmaUrl = imageUrls[section.id];
    if (!figmaUrl) { console.warn(`  ⚠️  Nessuna immagine per "${section.name}"`); continue; }
    const safe     = section.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const filename = `${safe}.${IMG_FORMAT}`;
    const filepath = path.join(OUT_DIR, filename);

    const { body } = await httpGet(figmaUrl);
    fs.writeFileSync(filepath, body);
    console.log(`  ✓ ${filename} (${Math.round(body.length/1024)} KB)`);

    let hsUrl;
    try {
      hsUrl = await uploadToHubSpot(filepath, filename);
      console.log(`    ↑ HubSpot: ${hsUrl}`);
    } catch (err) {
      console.warn(`    ⚠️  Upload fallito: ${err.message} – uso URL Figma`);
      hsUrl = figmaUrl;
    }

    const texts  = extractTexts(section);
    const dark   = isDarkSection(section);
    const html   = textsToHTML(texts, dark);

    sectionData.push({ section, hsUrl, textHTML: html, isDark: dark });
  }

  // 4. Nav HTML
  let navItems = [];
  if (nav) {
    navItems = extractNavItems(nav);
    console.log(`\n🧭 Menu: ${navItems.join(' | ')}`);
  }
  const navHTML = generateNavHTML(nav, navItems);

  // 5. DND sections
  const dndSections = sectionData.map(({ section, hsUrl, textHTML, isDark }) =>
    generateDNDSection(section, hsUrl, textHTML, isDark)
  ).join('\n');

  // 6. Template HTML
  console.log('\n🔨 Genero template DND...');
  const html     = generateTemplate(frame.name, navHTML, dndSections);
  const htmlPath = path.join(OUT_DIR, 'template.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`   ✓ Salvato: ${htmlPath}`);

  // 7. Tenta upload su HubSpot (richiede design-manager-access – può fallire)
  try {
    const tmpl = await httpPost(
      `${HS_BASE}/content/api/v2/templates`,
      JSON.stringify({ label: `ETL Italy – ${frame.name}`, source: html, template_type: 4, is_available_for_new_content: true }),
      { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    );
    console.log(`\n🎉 Template creato! ID: ${tmpl.id}`);
  } catch (err) {
    console.log(`\n⚠️  API template non disponibile (${err.message.slice(0,80)})`);
    console.log(`   → Importa manualmente: ${htmlPath}`);
    console.log(`   → Design Manager → File → New file → HTML+HubL → incolla il contenuto`);
  }

  console.log('\n✅ Completato!  File in: ' + OUT_DIR + '\n');
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
