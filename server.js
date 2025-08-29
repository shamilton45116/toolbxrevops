import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { HUBSPOT_TOKEN, JWT_SECRET, PORT = 3000 } = process.env;

app.use(cors());
app.use(express.json());

// allow iframe inside HubSpot
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy",
    "frame-ancestors 'self' https://app.hubspot.com https://*.hubspot.com");
  next();
});

// serve the calculator page
app.use('/hubspot', express.static(path.join(__dirname, 'public')));

// short-lived JWT for iframe URL
app.get('/api/jwt', (req, res) => {
  const { dealId } = req.query;
  if (!dealId) return res.status(400).send('dealId required');
  const t = jwt.sign({ dealId }, JWT_SECRET, { expiresIn: '5m' });
  res.type('text/plain').send(t);
});

// read specific Deal properties from HubSpot
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
    res.status(500).json({ error: 'Failed to fetch deal' });
  }
});

app.listen(PORT, () => console.log(`Server on :${PORT}`));
