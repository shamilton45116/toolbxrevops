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

// Serve static assets
