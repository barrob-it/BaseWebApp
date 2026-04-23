#!/usr/bin/env node
'use strict';

/**
 * figma-export.js
 *
 * Esporta un frame Figma e lo carica su HubSpot come template HTML.
 *
 * Uso:
 *   node figma-export.js
 *
 * Output:
 *   ./figma-export/          ← immagini scaricate + template.html
 *   HubSpot template (Draft) ← caricato via API
 */

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const path     = require('path');
const { URL }  = require('url');
const crypto   = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

// Leggi le credenziali da variabili d'ambiente oppure crea un file .env
// e avvia con: source .env && node figma-export.js
const FIGMA_TOKEN    = process.env.FIGMA_TOKEN    || '';
const FIGMA_FILE_ID  = process.env.FIGMA_FILE_ID  || '';
const FIGMA_NODE_ID  = process.env.FIGMA_NODE_ID  || '292:76';
const HS_TOKEN       = process.env.HS_TOKEN       || '';
const HS_BASE        = 'https://api.hubapi.com';
const HS_FOLDER      = '/figma-exports';
const OUT_DIR        = path.join(__dirname, 'figma-export');
const SCALE          = 2;          // 2x per retina
const IMG_FORMAT     = 'png';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── HTTP utilities ───────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const mod      = parsed.protocol === 'https:' ? https : http;
    const options  = { headers };

    mod.get(url, options, (res) => {
      // follow redirects
      if (res.statusCode >= 301 && res.statusCode <= 303 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          return reject(new Error(`GET ${url} → HTTP ${res.statusCode}: ${body.toString().slice(0,300)}`));
        }
        resolve({ status: res.statusCode, body, text: body.toString() });
      });
    }).on('error', reject);
  });
}

function httpPost(url, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const parsed  = new URL(url);
    const options = {
      hostname : parsed.hostname,
      port     : parsed.port || 443,
      path     : parsed.pathname + parsed.search,
      method   : 'POST',
      headers  : {
        'Content-Length': bodyBuf.length,
        ...extraHeaders,
      },
    };
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          return reject(new Error(`POST ${url} → HTTP ${res.statusCode}: ${text.slice(0,500)}`));
        }
        resolve(JSON.parse(text));
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

// Multipart form-data builder (per upload file binari senza dipendenze npm)
function buildMultipart(fields, files) {
  const boundary = '----FormBoundary' + crypto.randomBytes(12).toString('hex');
  const parts    = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(String(value)),
      Buffer.from('\r\n'),
    );
  }
  for (const { name, filename, contentType, data } of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
      ),
      data,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  return {
    body        : Buffer.concat(parts),
    contentType : `multipart/form-data; boundary=${boundary}`,
  };
}

// ─── Figma helpers ────────────────────────────────────────────────────────────

async function figmaGet(endpoint) {
  const { text } = await httpGet(
    `https://api.figma.com/v1${endpoint}`,
    { 'X-Figma-Token': FIGMA_TOKEN }
  );
  const json = JSON.parse(text);
  if (json.status && json.status >= 400) throw new Error(`Figma API: ${json.err || JSON.stringify(json)}`);
  return json;
}

async function getFrameData() {
  console.log('📐 Recupero struttura Figma...');
  const data = await figmaGet(
    `/files/${FIGMA_FILE_ID}/nodes?ids=${encodeURIComponent(FIGMA_NODE_ID)}&geometry=paths`
  );
  const nodeKey  = Object.keys(data.nodes)[0];
  const document = data.nodes[nodeKey].document;
  return document;
}

async function exportFigmaImages(nodeIds) {
  const ids = nodeIds.map(id => encodeURIComponent(id)).join(',');
  console.log(`🖼  Esporto ${nodeIds.length} immagini da Figma (${IMG_FORMAT} ${SCALE}x)...`);
  const data = await figmaGet(
    `/images/${FIGMA_FILE_ID}?ids=${nodeIds.map(encodeURIComponent).join(',')}&format=${IMG_FORMAT}&scale=${SCALE}`
  );
  if (data.err) throw new Error(`Figma export error: ${data.err}`);
  return data.images; // { "nodeId": "https://..." }
}

// ─── HubSpot helpers ──────────────────────────────────────────────────────────

async function uploadFileToHubSpot(filepath, remoteFilename) {
  console.log(`  ↑ Upload HubSpot: ${remoteFilename}...`);
  const fileData = fs.readFileSync(filepath);
  const { body, contentType } = buildMultipart(
    {
      options    : JSON.stringify({ access: 'PUBLIC_INDEXABLE' }),
      folderPath : HS_FOLDER,
    },
    [{ name: 'file', filename: remoteFilename, contentType: 'image/png', data: fileData }]
  );

  const result = await httpPost(
    `${HS_BASE}/files/v3/files`,
    body,
    {
      'Authorization' : `Bearer ${HS_TOKEN}`,
      'Content-Type'  : contentType,
    }
  );
  console.log(`     ✓ URL: ${result.url}`);
  return result.url;
}

async function createHubSpotTemplate(label, htmlSource) {
  console.log(`📤 Creo template HubSpot: "${label}"...`);
  const result = await httpPost(
    `${HS_BASE}/content/api/v2/templates`,
    JSON.stringify({
      label,
      source               : htmlSource,
      template_type        : 4,              // 4 = landing page
      is_available_for_new_content: true,
    }),
    {
      'Authorization' : `Bearer ${HS_TOKEN}`,
      'Content-Type'  : 'application/json',
    }
  );
  return result;
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function generateTemplate(pageName, sections) {
  const sectionsHTML = sections.map((s, i) => {
    const ratio = ((s.height / s.width) * 100).toFixed(3);
    return `
  <!-- ${s.name} -->
  <section class="hs-section" id="s${i}">
    <div class="hs-section__img-wrap" style="padding-bottom:${ratio}%">
      <img
        src="${s.hsUrl}"
        alt="${s.name}"
        width="${s.width}"
        height="${s.height}"
        loading="${i === 0 ? 'eager' : 'lazy'}"
      >
    </div>
  </section>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ content.html_title }}</title>
  <meta name="description" content="{{ content.meta_description }}">
  {{ standard_header_includes }}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #fff; }
    .hs-page { width: 100%; }
    .hs-section { width: 100%; }
    .hs-section__img-wrap {
      position: relative;
      width: 100%;
      overflow: hidden;
    }
    .hs-section__img-wrap img {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      object-fit: cover;
      display: block;
    }
  </style>
</head>
<body>
  <main class="hs-page">
${sectionsHTML}
  </main>
  {{ standard_footer_includes }}
</body>
</html>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!FIGMA_TOKEN || !FIGMA_FILE_ID || !HS_TOKEN) {
    console.error('❌ Variabili mancanti. Esegui:');
    console.error('   cp .env.example .env   # e compila con i tuoi token');
    console.error('   source .env && node figma-export.js');
    process.exit(1);
  }

  console.log('\n🚀 Figma → HubSpot Export\n' + '─'.repeat(40));

  // 1. Struttura del frame
  const frame = await getFrameData();
  const bb    = frame.absoluteBoundingBox || { width: 1440, height: 900 };
  console.log(`\n✅ Frame: "${frame.name}" (${bb.width}×${bb.height}px)`);

  const children = (frame.children || []).filter(c =>
    ['FRAME', 'COMPONENT', 'GROUP', 'RECTANGLE', 'VECTOR', 'INSTANCE'].includes(c.type)
  );
  console.log(`   Sezioni trovate: ${children.length}`);
  children.forEach((c, i) => {
    const cbb = c.absoluteBoundingBox || {};
    console.log(`   ${i + 1}. "${c.name}" (${cbb.width}×${cbb.height})`);
  });

  // 2. Export immagini da Figma
  // Usiamo il frame intero se non ci sono sezioni utili, altrimenti esportiamo sezione per sezione
  const idsToExport = children.length > 0
    ? children.map(c => c.id)
    : [FIGMA_NODE_ID];

  const imageUrls = await exportFigmaImages(idsToExport);

  // 3. Download + upload su HubSpot
  console.log('\n⬇️  Download & upload immagini...');
  const sections = [];

  const items = children.length > 0 ? children : [{ id: FIGMA_NODE_ID, name: frame.name, absoluteBoundingBox: bb }];

  for (const item of items) {
    const figmaUrl = imageUrls[item.id];
    if (!figmaUrl) {
      console.warn(`  ⚠️  Nessuna immagine per "${item.name}" — skip`);
      continue;
    }
    const safeName = item.name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const filename = `${safeName}.${IMG_FORMAT}`;
    const filepath = path.join(OUT_DIR, filename);

    // download
    const { body } = await httpGet(figmaUrl);
    fs.writeFileSync(filepath, body);
    console.log(`  ✓ Scaricato ${filename} (${Math.round(body.length / 1024)} KB)`);

    // upload HubSpot
    let hsUrl;
    try {
      hsUrl = await uploadFileToHubSpot(filepath, filename);
    } catch (err) {
      console.warn(`     ⚠️  Upload HubSpot fallito: ${err.message}`);
      console.warn(`     → Uso URL Figma temporaneo (scade in ~24h)`);
      hsUrl = figmaUrl;
    }

    const cbb = item.absoluteBoundingBox || {};
    sections.push({ name: item.name, hsUrl, width: cbb.width || 1440, height: cbb.height || 900 });
  }

  // 4. Genera HTML
  console.log('\n🔨 Genero template HTML...');
  const html     = generateTemplate(frame.name, sections);
  const htmlPath = path.join(OUT_DIR, 'template.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');
  console.log(`   ✓ Salvato: ${htmlPath}`);

  // 5. Crea template su HubSpot
  try {
    const tmpl = await createHubSpotTemplate(`ETL Italy – ${frame.name}`, html);
    console.log(`\n🎉 Template creato su HubSpot!`);
    console.log(`   ID      : ${tmpl.id}`);
    console.log(`   Label   : ${tmpl.label}`);
    console.log(`   Modifica: https://app-eu1.hubspot.com/design-manager/${tmpl.portal_id}/edit/dnd/${tmpl.id}`);
  } catch (err) {
    console.error(`\n⚠️  Creazione template HubSpot fallita: ${err.message}`);
    console.log(`   → Template HTML salvato localmente in: ${htmlPath}`);
    console.log(`   → Puoi importarlo manualmente dal Design Manager di HubSpot`);
  }

  console.log('\n✅ Esportazione completata!');
  console.log(`   File salvati in: ${OUT_DIR}\n`);
}

main().catch(err => {
  console.error('\n❌ Errore fatale:', err.message);
  process.exit(1);
});
