#!/usr/bin/env node
'use strict';

/**
 * figma-export.js  –  v3
 *
 * Approccio progressivo: chiama l'API Figma con depth=1 per volta
 * (invece di scaricare l'intero albero in una volta sola).
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
const REQ_TIMEOUT   = 25000; // 25 s per singola richiesta

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Timeout wrapper ──────────────────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`⏱  Timeout ${ms/1000}s: ${label}`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); },
                 e => { clearTimeout(t); reject(e);  });
  });
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function httpGet(url, headers = {}) {
  const req = () => new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const r      = mod.request(
      { hostname: parsed.hostname, port: parsed.port || 443,
        path: parsed.pathname + parsed.search, method: 'GET', headers },
      res => {
        if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location)
          return httpGet(res.headers.location, headers).then(resolve).catch(reject);
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${body.toString().slice(0,200)}`));
          resolve({ body, text: body.toString() });
        });
      });
    r.on('error', reject);
    r.end();
  });
  return withTimeout(req(), REQ_TIMEOUT, url.slice(0, 80));
}

function httpPost(url, payload, extraHeaders = {}) {
  const req = () => new Promise((resolve, reject) => {
    const bodyBuf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? https : http;
    const r       = mod.request(
      { hostname: parsed.hostname, port: parsed.port || 443,
        path: parsed.pathname + parsed.search, method: 'POST',
        headers: { 'Content-Length': bodyBuf.length, ...extraHeaders } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400)
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0,300)}`));
          resolve(JSON.parse(text));
        });
      });
    r.on('error', reject);
    r.write(bodyBuf);
    r.end();
  });
  return withTimeout(req(), REQ_TIMEOUT, url.slice(0, 80));
}

function buildMultipart(fields, files) {
  const boundary = '----FormBoundary' + crypto.randomBytes(12).toString('hex');
  const parts    = [];
  for (const [name, value] of Object.entries(fields))
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(String(value)), Buffer.from('\r\n'));
  for (const { name, filename, contentType, data } of files)
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ─── Figma API – chiamate progressive con depth=1 ────────────────────────────
async function figmaNodes(nodeId, depth = 1) {
  const url  = `https://api.figma.com/v1/files/${FIGMA_FILE_ID}/nodes?ids=${encodeURIComponent(nodeId)}&depth=${depth}`;
  const { text } = await httpGet(url, { 'X-Figma-Token': FIGMA_TOKEN });
  const json = JSON.parse(text);
  if (json.status >= 400) throw new Error(`Figma: ${json.err}`);
  const key  = Object.keys(json.nodes)[0];
  return json.nodes[key]?.document;
}

async function figmaImages(nodeIds) {
  const ids  = nodeIds.map(encodeURIComponent).join(',');
  const url  = `https://api.figma.com/v1/images/${FIGMA_FILE_ID}?ids=${ids}&format=${IMG_FORMAT}&scale=${SCALE}`;
  const { text } = await httpGet(url, { 'X-Figma-Token': FIGMA_TOKEN });
  const json = JSON.parse(text);
  if (json.err) throw new Error(`Figma images: ${json.err}`);
  return json.images;
}

// ─── HubSpot ──────────────────────────────────────────────────────────────────
async function uploadToHubSpot(filepath, filename) {
  const fileData = fs.readFileSync(filepath);
  const { body, contentType } = buildMultipart(
    { options: JSON.stringify({ access: 'PUBLIC_INDEXABLE' }), folderPath: HS_FOLDER },
    [{ name: 'file', filename, contentType: 'image/png', data: fileData }]);
  const result = await httpPost(`${HS_BASE}/files/v3/files`, body,
    { Authorization: `Bearer ${HS_TOKEN}`, 'Content-Type': contentType });
  return result.url;
}

// ─── Utilità colori ───────────────────────────────────────────────────────────
function figmaColor(c) {
  if (!c) return null;
  const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  const a = c.a !== undefined ? c.a : 1;
  return a < 0.99
    ? `rgba(${r},${g},${b},${a.toFixed(2)})`
    : '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
}

function firstSolidColor(fills) {
  const f = (fills || []).find(f => f.type === 'SOLID' && (f.opacity || 1) > 0.1);
  return f ? figmaColor(f.color) : null;
}

function luminance(hex) {
  if (!hex || !hex.startsWith('#')) return 200;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return 0.299*r + 0.587*g + 0.114*b;
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s) { return String(s).replace(/"/g,'&quot;'); }

// ─── Parser testi Figma ───────────────────────────────────────────────────────
function collectTexts(node) {
  const list = [];
  function walk(n) {
    if (n.type === 'TEXT' && n.characters?.trim()) list.push(n);
    (n.children || []).forEach(walk);
  }
  walk(node);
  return list.sort((a,b) => (a.absoluteBoundingBox?.y||0) - (b.absoluteBoundingBox?.y||0));
}

function textsToHTML(texts, isDark) {
  return texts.map(t => {
    const size   = t.style?.fontSize || 16;
    const weight = t.style?.fontWeight || 400;
    const family = (t.style?.fontFamily || 'sans-serif').replace(/'/g,"\\'");
    const color  = firstSolidColor(t.fills) || (isDark ? '#ffffff' : '#1a1a1a');
    const tag    = size >= 48 ? 'h1' : size >= 32 ? 'h2' : size >= 22 ? 'h3' : size >= 18 ? 'h4' : 'p';
    const style  = `font-family:'${family}',sans-serif;font-size:${size}px;font-weight:${weight};color:${color};margin:0 0 0.6em;line-height:1.3;`;
    const text   = t.characters.replace(/\n/g, '<br>');
    return `<${tag} style="${style}">${esc(text)}</${tag}>`;
  }).join('\n          ');
}

// ─── Generatori HTML ──────────────────────────────────────────────────────────
function makeNav(navItems, bgColor) {
  const bg = bgColor || '#1a0000';
  const items = navItems
    .map(l => `<li style="margin:0;"><a href="#" style="color:#fff;text-decoration:none;font-size:15px;">${esc(l)}</a></li>`)
    .join('\n        ');
  return `  <!-- Nav -->
  <header style="background:${bg};padding:0 5%;display:flex;align-items:center;justify-content:space-between;height:64px;position:sticky;top:0;z-index:100;">
    <div style="font-weight:bold;color:#fff;font-size:20px;">ETL ITALIA</div>
    <nav><ul style="display:flex;gap:28px;list-style:none;margin:0;padding:0;align-items:center;">
        ${items}
    </ul></nav>
  </header>`;
}

function makeDNDSection(name, bgUrl, textHTML, sectionHeight) {
  const minH   = Math.round((sectionHeight || 400) / 2);
  const bgProp = bgUrl
    ? `background_image={"backgroundPosition": "top center", "backgroundSize": "cover", "src": "${bgUrl}"}`
    : '';
  const vPad   = Math.min(80, Math.max(16, Math.round((sectionHeight||400) * 0.07)));

  return `
  {# ── ${name} ── #}
  {% dnd_section
     ${bgProp}
     padding={"top": ${vPad}, "bottom": ${vPad}, "left": 40, "right": 40}
     min_height=${minH}
  %}
    {% dnd_column width=12 %}
      {% dnd_row %}
        {% dnd_module path="@hubspot/rich_text"
           label="${escAttr(name)}"
           html="${escAttr(textHTML || '<p>Contenuto editabile</p>')}"
        %}{% end_dnd_module %}
      {% end_dnd_row %}
    {% end_dnd_column %}
  {% end_dnd_section %}`;
}

function makeTemplate(pageName, navHTML, dndBody) {
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
    body { font-family: 'Helvetica Neue', Arial, sans-serif; }
  </style>
</head>
<body>
${navHTML}
  {% dnd_area "main" label="Contenuto pagina" %}
${dndBody}
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

  console.log('\n🚀 Figma → HubSpot Export  (v3 – progressive)\n' + '─'.repeat(44));

  // 1. Frame: solo i figli diretti (depth=1, risposta piccola)
  console.log('\n[1/6] Struttura frame (depth=1)...');
  const frame = await figmaNodes(FIGMA_NODE_ID, 1);
  const bb    = frame.absoluteBoundingBox || { width: 1440, height: 5000 };
  console.log(`      Frame: "${frame.name}" (${bb.width}×${bb.height}px)`);
  console.log(`      Figli diretti: ${(frame.children||[]).map(c=>c.name).join(', ')}`);

  // 2. Trova nav e body
  const navChild  = (frame.children||[]).find(c => c.name.toLowerCase() === 'nav');
  const bodyChild = (frame.children||[]).find(c =>
    ['body','content','main'].includes(c.name.toLowerCase())) || frame;

  // 3. Sezioni dentro body (depth=1)
  console.log('\n[2/6] Sezioni dentro body (depth=1)...');
  const bodyNode = bodyChild.id !== frame.id
    ? await figmaNodes(bodyChild.id, 1)
    : bodyChild;
  const sections = (bodyNode.children || []).filter(c => c.absoluteBoundingBox);
  console.log(`      ${sections.length} sezioni: ${sections.map(s=>s.name).join(', ')}`);

  // 4. Testi di ogni sezione (depth=2 per sezione – chiamate separate)
  console.log('\n[3/6] Testi per sezione...');
  const sectionDetails = [];
  for (const s of sections) {
    process.stdout.write(`      "${s.name}" ... `);
    try {
      const detail = await figmaNodes(s.id, 2);
      const texts  = collectTexts(detail);
      const dark   = luminance(firstSolidColor(detail.fills) || '#ffffff') < 100;
      const html   = textsToHTML(texts, dark);
      sectionDetails.push({ node: s, detail, textHTML: html, isDark: dark });
      console.log(`${texts.length} testi ✓`);
    } catch (err) {
      console.log(`errore (${err.message}) – uso placeholder`);
      sectionDetails.push({ node: s, detail: s, textHTML: '', isDark: false });
    }
  }

  // 5. Nav items
  let navItems = [], navBg = '#1a0000';
  if (navChild) {
    console.log('\n[4/6] Nav items...');
    try {
      const navDetail = await figmaNodes(navChild.id, 2);
      const texts     = collectTexts(navDetail);
      navItems = texts.map(t => t.characters.trim()).filter(Boolean);
      navBg    = firstSolidColor(navDetail.fills) || '#1a0000';
      console.log(`      Menu: ${navItems.join(' | ')}`);
    } catch (err) {
      console.log(`      ⚠️  ${err.message}`);
    }
  }

  // 6. Export immagini Figma
  console.log('\n[5/6] Export immagini Figma...');
  const allIds   = sections.map(s => s.id);
  const imgUrls  = await figmaImages(allIds);

  // 7. Download + upload HubSpot
  console.log('\n[6/6] Download & upload immagini...');
  for (const sd of sectionDetails) {
    const figmaUrl = imgUrls[sd.node.id];
    if (!figmaUrl) { console.log(`      ⚠️  "${sd.node.name}" – nessuna immagine`); continue; }
    const safe     = sd.node.name.replace(/[^a-zA-Z0-9_-]/g,'_').toLowerCase();
    const filename = `${safe}.${IMG_FORMAT}`;
    const filepath = path.join(OUT_DIR, filename);
    const { body } = await httpGet(figmaUrl);
    fs.writeFileSync(filepath, body);
    process.stdout.write(`      ${filename} (${Math.round(body.length/1024)}KB) → HubSpot... `);
    try {
      sd.hsUrl = await uploadToHubSpot(filepath, filename);
      console.log('✓');
    } catch (err) {
      sd.hsUrl = figmaUrl;
      console.log(`⚠️  upload fallito, uso URL Figma`);
    }
  }

  // 8. Genera template
  const navHTML  = makeNav(navItems, navBg);
  const dndBody  = sectionDetails.map(sd =>
    makeDNDSection(sd.node.name, sd.hsUrl, sd.textHTML, sd.node.absoluteBoundingBox?.height)
  ).join('\n');
  const html     = makeTemplate(frame.name, navHTML, dndBody);
  const htmlPath = path.join(OUT_DIR, 'template.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  console.log(`\n✅  Template salvato: ${htmlPath}`);
  console.log('\n→  Apri HubSpot Design Manager, sostituisci il contenuto di home-page.html');
  console.log('   con il contenuto di template.html e clicca "Publish changes".\n');
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
