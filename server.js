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

app.use(cors());
app.use(express.json());

// Allow embedding inside HubSpot (important for iframe modal)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com"
  );
  next();
});

// --- Friendly root handler ---
app.get('/', (req, res) => {
  res.send(
    `<h3>HubSpot Calculator</h3>
     <p>Try <code>/hubspot/calc?dealId=YOUR_DEAL_ID&t=YOUR_JWT</code></p>`
  );
});

// --- Static calculator page ---
app.use('/hubspot', express.static(path.join(__dirname, 'public')));
app.get('/hubspot/calc', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calc.html'));
});

// --- Serve config from disk (this is the part you asked for) ---
app.get('/api/calc-config', (req, res) => {
  try {
    const file = path.join(__dirname, 'calc.config.json');
    const raw = fs.readFileSync(file, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    // Optional caching:
    res.setHeader('Cache-Control', 'no-store');
    res.send(raw);
  } catch (e) {
    console.error('Config load error:', e.message);
    res.status(500).json({ error: 'Missing or unreadable calc.config.json' });
  }
});

// --- Short-lived JWT for iframe URL ---
app.get('/api/jwt', (req, res) => {
  const { dealId } = req.query;
  if (!dealId) return res.status(400).send('dealId required');
  try {
    const t = jwt.sign({ dealId: String(dealId) }, JWT_SECRET, { expiresIn: '5m' });
    res.type('text/plain').send(t);
  } catch (e) {
    res.status(500).send('Failed to mint JWT');
  }
});

// --- Read selected Deal properties from HubSpot ---
app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { t } = req.query;

    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(id)) {
      return res.status(403).json({
        error: 'Deal mismatch',
        hint: `Token is for dealId=${payload.dealId}, request is for id=${id}`,
      });
    }

    // Ask ONLY for needed fields
    const props = [
      'dealname',
      'amount',
      'dealstage',
      'pipeline',
      'custom_region',
      'custom_segment',
      'custom_discount_rate',
      'custom_user_seats',
    ].join(',');

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=${encodeURIComponent(
      props
    )}`;

    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` },
    });

    res.json({ id: data.id, properties: data.properties });
  } catch (e) {
    const status = e?.response?.status || 500;
    const hs = e?.response?.data;
    console.error('JWT/HubSpot error ->', e.message, hs || '');
    res.status(status).json({
      error: 'Request failed',
      status,
      cause: e.name || 'Unknown',
      message: e.message,
      hubspot: hs,
      hints: [
        'If cause=TokenExpiredError: mint a new /api/jwt token',
        'If cause=JsonWebTokenError: check JWT_SECRET in Render',
        'If status=403: add crm.objects.deals.read scope & rotate token',
        'If status=404: wrong dealId or wrong portal/token',
      ],
    });
  }
});

// --- Helper: build inputs for batch line-item create ---
function buildLineItemInputs({ dealId, items }) {
  return items.map((item) => {
    const properties = {
      name: item.name, // required
      quantity: String(item.qty ?? 1),
      price: String(item.unitPrice ?? 0),
      hs_line_item_currency_code: item.currency || 'USD',
    };

    if (item.description) properties.description = item.description;
    if (item.discountPercent != null)
      properties.hs_discount_percentage = String(item.discountPercent);
    if (item.discountAmount != null)
      properties.hs_discount_amount = String(item.discountAmount);
    if (item.hsProductId) properties.hs_product_id = String(item.hsProductId);
    if (item.taxRateGroupId) properties.hs_tax_rate_group_id = String(item.taxRateGroupId);

    // Optional recurring examples (uncomment if you use them and your portal has these props)
    // if (item.recurringbillingfrequency) properties.recurringbillingfrequency = item.recurringbillingfrequency;
    // if (item.hs_recurring_billing_start_date) properties.hs_recurring_billing_start_date = item.hs_recurring_billing_start_date;

    return {
      properties,
      associations: [
        {
          to: { id: String(dealId) },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }],
        },
      ],
    };
  });
}

// --- Create HubSpot line items (batch) and associate to deal ---
app.post('/api/line-items', async (req, res) => {
  try {
    const { dealId, t, items, dedupeKey } = req.body;
    if (!dealId || !t || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Missing dealId, t, or items[]' });
    }

    const payload = jwt.verify(t, JWT_SECRET, { clockTolerance: 5 });
    if (String(payload.dealId) !== String(dealId)) {
      return res.status(403).json({ error: 'Deal mismatch for token' });
    }

    // Simple in-memory idempotency (dev only). For prod, use Redis/DB with TTL.
    // globalThis._seenKeys = globalThis._seenKeys || new Map();
    // if (dedupeKey && globalThis._seenKeys.has(dedupeKey)) {
    //   return res.status(409).json({ error: 'Duplicate submission' });
    // }
    // if (dedupeKey) globalThis._seenKeys.set(dedupeKey, Date.now());

    const inputs = buildLineItemInputs({ dealId, items });

    const url = 'https://api.hubapi.com/crm/v3/objects/line_items/batch/create';
    const { data } = await axios.post(
      url,
      { inputs },
      { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
    );

    res.json({ ok: true, created: data.results || data });
  } catch (e) {
    const status = e?.response?.status || 500;
    console.error('Create line items error:', status, e?.response?.data || e.message);
    res.status(status).json({
      error: 'Failed to create line items',
      status,
      hubspot: e?.response?.data,
      hint: status === 403 ? 'Check crm.objects.line_items.write scope & token' : undefined,
    });
  }
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { HUBSPOT_TOKEN, JWT_SECRET, PORT = process.env.PORT || 3000 } = process.env;

app.use(cors());
app.use(express.json());

// Allow embedding inside HubSpot (important for iframe modal)
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com"
  );
  next();
});

// -------------- NEW: friendly root handler --------------
app.get('/', (req, res) => {
  res.send(
    `<h3>HubSpot Calculator</h3>
     <p>Try <code>/hubspot/calc?dealId=YOUR_DEAL_ID&t=YOUR_JWT</code></p>`
  );
});

// Serve static assets under /hubspot
app.use('/hubspot', express.static(path.join(__dirname, 'public')));

// -------------- NEW: serve /hubspot/calc without .html --------------
app.get('/hubspot/calc', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'calc.html'));
});

// Short-lived JWT for iframe URL
app.get('/api/jwt', (req, res) => {
  const { dealId } = req.query;
  if (!dealId) return res.status(400).send('dealId required');
  const t = jwt.sign({ dealId }, JWT_SECRET, { expiresIn: '5m' });
  res.type('text/plain').send(t);
});

// Read selected Deal properties from HubSpot
app.get('/api/deals/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { t } = req.query;
    jwt.verify(t, JWT_SECRET); // throws if invalid/expired

    const props = [
      'dealname','amount','dealstage','pipeline',
      'custom_region','custom_segment','custom_discount_rate'
    ].join(',');

    const url = `https://api.hubapi.com/crm/v3/objects/deals/${id}?properties=${encodeURIComponent(props)}`;
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` }
    });

    res.json({ id: data.id, properties: data.properties });
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
