// server.js
// Requires: "type": "module" in package.json
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { HUBSPOT_TOKEN, JWT_SECRET, PORT = process.env.PORT || 3000 } = process.env;

app.use(express.json());
app.use(cors());

// allow embedding in HubSpot UI
app.use((_, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com");
  next();
});

/* ------------ load config (calc.config.json) ------------ */
let CALC_CFG = { features: [], lineItems: { standard: [], options: [] } };
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'calc.config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    CALC_CFG = {
      features: Array.isArray(cfg.features) ? cfg.features : [],
      lineItems: cfg.lineItems || { standard: [], options: [] }
    };
  } catch (e) {
    console.error('Config load error:', e.message);
    CALC_CFG = { features: [], lineItems: { standard: [], options: [] } };
  }
}
loadConfig();

app.get('/api/calc-config', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.send(JSON.stringify(CALC_CFG));
});

app.post('/api/reload-config', (_req, res) => {
  loadConfig();
  res.json({ ok: true, features: CALC_CFG.features.length });
});

/* ------------ static (no-store for HTML) ------------ */
app.disable('etag');
const staticDir = path.join(__dirname, 'public');
const staticOpts = {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-store' : 'no-cache');
  }
};
app.use('/toolbxrevops', express.static(staticDir, staticOpts));
app.get('/toolbxrevops/calc', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(staticDir, 'calc.html')); });
app.get('/toolbxrevops/calc-v3', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(staticDir, 'calc.html')); });

app.get('/', (_req, res) => {
  res.send(`<h3>TOOLBX RevOps Calculator</h3>
  <p>Try <code>/toolbxrevops/calc-v3?dealId=YOUR_DEAL_ID&t=YOUR_JWT</code></p>`);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'toolbxrevops', version: 'v3' }));

/* ------------ JWT (5-minute token) ------------ */
app.get('/api/jwt', (req, res) => {
  const { dealId } = req.query;
  if (!dealId) return res.status(400).send('dealId required');
  try {
    const t = jwt.sign({ dealId: String(dealId) }, JWT_SECRET, { expiresIn: '5m' });
    res.type('text/plain').send(t);
  } catch {
    res.status(500).send('Failed to mint JWT');
  }
});

/* ------------ Deal read (+ optional write) ------------ */
function configDealProps() {
  const featureProps = (CALC_CFG.features || []).map(f => f.fromDealProperty).filter(Boolean);
  const baseProps = ['dealname', 'dealstage', 'pipeline', 'hs_currency'];
  return Array.from(new Set([...baseProps, ...featureProps]));
}

app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params; const { t } = req.query;
    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) return res.status(403).json({ error: 'Deal mismatch' });

    const propsParam = encodeURIComponent(configDealProps().join(','));
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=${propsParam}`;
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    res.json({ id: data.id, properties: data.properties });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Request failed', message: e.message, hubspot: e?.response?.data });
  }
});

// optional: update deal properties
app.patch('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params; const { t, properties } = req.body || {};
    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) return res.status(403).json({ error: 'Deal mismatch' });

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}`;
    const { data } = await axios.patch(url, { properties }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    res.json({ ok: true, deal: data });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Deal update failed', message: e.message, hubspot: e?.response?.data });
  }
});

/* ------------ Line items: read ------------ */
const LINE_ITEM_PROPS = [
  'name',
  'price',
  'quantity',
  'hs_discount_percentage',
  'hs_discount_amount',
  'recurringbillingfrequency',
  'hs_line_item_currency_code'
];

async function getAssociatedLineItemIds(dealId) {
  const ids = [];
  let after = undefined;
  do {
    const url = new URL(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const { data } = await axios.get(url.toString(), { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    for (const r of (data?.results || [])) if (r.to?.id) ids.push(String(r.to.id));
    after = data?.paging?.next?.after;
  } while (after);
  return ids;
}

app.get('/api/deals/:id/line-items', async (req, res) => {
  try {
    const { id } = req.params; const { t } = req.query;
    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) return res.status(403).json({ error: 'Deal mismatch' });

    const ids = await getAssociatedLineItemIds(id);
    if (ids.length === 0) return res.json({ results: [] });

    const batchUrl = 'https://api.hubapi.com/crm/v3/objects/line_items/batch/read';
    const { data } = await axios.post(
      batchUrl,
      { properties: LINE_ITEM_PROPS, inputs: ids.map(x => ({ id: x })) },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );
    res.json({ results: data.results || [] });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Line item read failed', message: e.message, hubspot: e?.response?.data });
  }
});

/* ------------ Line items: create + update (upsert) ------------ */
function toLineItemProperties(item) {
  const p = {
    name: item.name,
    price: String(item.unitPrice ?? item.price ?? 0),
    quantity: String(item.quantity ?? item.qty ?? 1),
    hs_line_item_currency_code: item.currency || item.hs_line_item_currency_code || 'USD'
  };
  if (item.discountPercent != null) p.hs_discount_percentage = String(item.discountPercent);
  if (item.discountAmount  != null) p.hs_discount_amount = String(item.discountAmount);
  if (item.term) p.recurringbillingfrequency = String(item.term);
  return p;
}

// items with "id" are updated; without "id" are created + associated to the deal
app.post('/api/line-items/upsert', async (req, res) => {
  try {
    const { dealId, t, items } = req.body || {};
    if (!dealId || !t || !Array.isArray(items)) return res.status(400).json({ error: 'Missing dealId, t, or items[]' });

    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(dealId)) return res.status(403).json({ error: 'Deal mismatch' });

    const createInputs = [];
    const updateInputs = [];

    for (const it of items) {
      if (it.id) {
        updateInputs.push({ id: String(it.id), properties: toLineItemProperties(it) });
      } else {
        createInputs.push({
          properties: toLineItemProperties(it),
          associations: [
            { to: { id: String(dealId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }] }
          ]
        });
      }
    }

    const results = { created: [], updated: [] };

    if (createInputs.length) {
      const url = 'https://api.hubapi.com/crm/v3/objects/line_items/batch/create';
      const { data } = await axios.post(url, { inputs: createInputs }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
      results.created = data.results || [];
    }

    if (updateInputs.length) {
      const url = 'https://api.hubapi.com/crm/v3/objects/line_items/batch/update';
      const { data } = await axios.post(url, { inputs: updateInputs }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
      results.updated = data.results || [];
    }

    res.json({ ok: true, ...results });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Upsert failed', message: e.message, hubspot: e?.response?.data });
  }
});

/* ------------ start ------------ */
app.listen(PORT, () => console.log(`toolbxrevops server on :${PORT}`));
