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
