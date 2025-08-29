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

const {
  HUBSPOT_TOKEN,
  JWT_SECRET,
  PORT = process.env.PORT || 3000,
} = process.env;

app.use(express.json());
app.use(cors());

// Allow embedding inside HubSpot (iframe modal)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com"
  );
  next();
});

// ----------------------- Load config -----------------------
let CALC_CFG = { features: [], lineItems: { standard: [], options: [] } };
function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'calc.config.json'), 'utf8');
    CALC_CFG = JSON.parse(raw);
    if (!Array.isArray(CALC_CFG.features)) CALC_CFG.features = [];
    if (!CALC_CFG.lineItems) CALC_CFG.lineItems = { standard: [], options: [] };
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

// --- Static / Root (no caching for HTML) ---
app.disable('etag'); // disable ETag for the whole app

const staticDir = path.join(__dirname, 'public');
app.use(
  '/hubspot',
  express.static(staticDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res, filePath) => {
      // Never cache HTML
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      } else {
        // cache bust for other assets if you like
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  })
);

// Serve calc.html explicitly and also set no-store
app.get('/hubspot/calc', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(staticDir, 'calc.html'));
});

// Add a versioned path so you can bypass any old URL completely
app.get('/hubspot/calc-v3', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(staticDir, 'calc.html'));
});

// Friendly root
app.get('/', (_req, res) => {
  res.send(`<h3>HubSpot Calculator</h3>
  <p>Try <code>/hubspot/calc-v3?dealId=YOUR_DEAL_ID&t=YOUR_JWT</code></p>`);
});


// ----------------------- Deals (read + optional write) -----------------------
function configDealProps() {
  const featureProps = (CALC_CFG.features || []).map(f => f.fromDealProperty).filter(Boolean);
  const baseProps = ['dealname', 'dealstage', 'pipeline', 'hs_currency']; // Deal Name, Stage, Currency
  return Array.from(new Set([...baseProps, ...featureProps]));
}

app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params; const { t } = req.query;
    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) {
      return res.status(403).json({ error: 'Deal mismatch' });
    }
    const propsParam = encodeURIComponent(configDealProps().join(','));
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=${propsParam}`;
    const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    res.json({ id: data.id, properties: data.properties });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Request failed', message: e.message, hubspot: e?.response?.data });
  }
});

// (Optional) write Deal properties
app.patch('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params; const { t, properties } = req.body || {};
    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) {
      return res.status(403).json({ error: 'Deal mismatch' });
    }
    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}`;
    const { data } = await axios.patch(url, { properties }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    res.json({ ok: true, deal: data });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: 'Deal update failed', message: e.message, hubspot: e?.response?.data });
  }
});

// ----------------------- Line Items (read) -----------------------
// Fetch all line items associated to a deal, then batch-read their properties.
const LINE_ITEM_PROPS = [
  'name',                          // Name
  'price',                         // Unit Price
  'quantity',                      // Quantity
  'hs_discount_percentage',        // Unit Discount (%)
  'hs_discount_amount',            // Unit Discount (absolute)
  'recurringbillingfrequency',     // Term
  'hs_line_item_currency_code'     // Currency per line item
];

async function getAssociatedLineItemIds(dealId) {
  const ids = [];
  let after = undefined;
  do {
    const url = new URL(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/line_items`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const { data } = await axios.get(url.toString(), { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
    for (const r of (data?.results || [])) if (r.to && r.to.id) ids.push(String(r.to.id));
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

// ----------------------- Line Items (create + update) -----------------------
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

// Upsert: items with "id" are UPDATED; without "id" are CREATED & associated to deal
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

// ----------------------- Start -----------------------
app.listen(PORT, () => console.log(`Server on :${PORT}`));
