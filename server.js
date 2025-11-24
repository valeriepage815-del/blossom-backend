
// (Consolidated server - /api endpoints are added below)
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const { ManagementClient } = require('auth0');
const multer = require('multer');
const cors = require('cors');

const app = express();

// ---- Auth0 Management (M2M app) ----
const auth0Mgmt = new ManagementClient({
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_M2M_CLIENT_ID,
  clientSecret: process.env.AUTH0_M2M_CLIENT_SECRET,
  audience: process.env.AUTH0_MANAGEMENT_API_AUDIENCE,
  scope: 'read:users update:users_app_metadata',
});

// ---- Stripe ----
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// CORS for frontend
app.use(cors());

/* ------------------------------------------------------------------
   Stripe Webhook (MUST be before express.json)
-------------------------------------------------------------------*/
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

// (Consolidated server - /api endpoints are added below)
require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');
const { ManagementClient } = require('auth0');
const multer = require('multer');
const cors = require('cors');

const app = express();

// ---- Auth0 Management (M2M app) ----
const auth0Mgmt = new ManagementClient({
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_M2M_CLIENT_ID,
  clientSecret: process.env.AUTH0_M2M_CLIENT_SECRET,
  audience: process.env.AUTH0_MANAGEMENT_API_AUDIENCE,
  scope: 'read:users update:users_app_metadata',
});

// ---- Stripe ----
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// CORS for frontend
app.use(cors());

/* ------------------------------------------------------------------
   Stripe Webhook (MUST be before express.json)
-------------------------------------------------------------------*/
app.post(
  '/webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          console.log('Invoice paid:', invoice.id);

          // Update local subscriptions.json status
          try {
            const outPath = path.join(__dirname, 'public', 'data');
            const subsFile = path.join(outPath, 'subscriptions.json');
            if (fs.existsSync(subsFile)) {
              const subs =
                JSON.parse(fs.readFileSync(subsFile, 'utf8') || '{}') || {};
              const subId =
                invoice.subscription ||
                invoice.lines?.data?.[0]?.subscription;

              if (subId && subs[subId]) {
                subs[subId].status = 'active';
                subs[subId].lastInvoice = invoice.id;
                fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
              }
            }
          } catch (err) {
            console.error('Failed to update subscription status', err);
          }

          // Sync Auth0 tier based on invoice metadata
          try {
            const email =
              invoice.customer_email || invoice.customer_details?.email;
            const tier = getTierFromInvoice(invoice);

            if (!email) {
              console.warn(
                '[auth0-sync] No customer_email on invoice; cannot sync tier.'
              );
            } else if (!tier) {
              console.warn(
                '[auth0-sync] No tier metadata on invoice/line/price; cannot sync tier.'
              );
            } else {
              console.log(
                `[auth0-sync] Setting tier="${tier}" for email=${email}`
              );
              await updateAuth0TierByEmail(email, tier);
            }
          } catch (err) {
            console.error('[auth0-sync] Error syncing tier to Auth0:', err);
          }

          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          console.log('Invoice payment failed:', invoice.id);

          // Mark subscription as past_due locally
          try {
            const outPath = path.join(__dirname, 'public', 'data');
            const subsFile = path.join(outPath, 'subscriptions.json');
            if (fs.existsSync(subsFile)) {
              const subs =
                JSON.parse(fs.readFileSync(subsFile, 'utf8') || '{}') || {};
              const subId =
                invoice.subscription ||
                invoice.lines?.data?.[0]?.subscription;

              if (subId && subs[subId]) {
                subs[subId].status = 'past_due';
                fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
              }
            }
          } catch (err) {
            console.error('Failed to update subscription status', err);
          }

          break;
        }

        case 'customer.subscription.created': {
          const sub = event.data.object;
          console.log('Subscription created:', sub.id);

          // 1) Keep your existing file-based tracking
          try {
            const outPath = path.join(__dirname, 'public', 'data');
            if (!fs.existsSync(outPath)) {
              fs.mkdirSync(outPath, { recursive: true });
            }
            const subsFile = path.join(outPath, 'subscriptions.json');
            let subs = {};
            if (fs.existsSync(subsFile)) {
              subs = JSON.parse(fs.readFileSync(subsFile, 'utf8') || '{}') || {};
            }

            const sid = sub.id;
            subs[sid] = subs[sid] || {
              id: sid,
              email: sub.customer_email || '',
              created: new Date().toISOString(),
            };
            subs[sid].status = sub.status || subs[sid].status || 'created';

            fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
          } catch (err) {
            console.error('Failed to update subscription file', err);
          }

          // 2) Sync Auth0 tier using subscription metadata (price/plan.metadata.tier)
          try {
            const tier = getTierFromSubscription(sub);

            // Try to get an email directly on the subscription…
            let email = (sub.customer_email || '').trim();

            // …if not there, fetch the Customer object and use its email
            if (!email && typeof sub.customer === 'string') {
              try {
                const customer = await stripe.customers.retrieve(sub.customer);
                email = (customer.email || '').trim();
              } catch (custErr) {
                console.error(
                  '[auth0-sync] Failed to retrieve Stripe customer:',
                  custErr
                );
              }
            }

            if (!email) {
              console.warn(
                '[auth0-sync] (subscription.created) No email found; cannot sync tier.'
              );
            } else if (!tier) {
              console.warn(
                '[auth0-sync] (subscription.created) No tier metadata on subscription items; cannot sync tier.'
              );
            } else {
              console.log(
                `[auth0-sync] (subscription.created) Setting tier="${tier}" for email=${email}`
              );
              await updateAuth0TierByEmail(email, tier);
            }
          } catch (err) {
            console.error(
              '[auth0-sync] Error syncing tier on customer.subscription.created:',
              err
            );
          }

          break;
        }

        default:
          console.log('Unhandled event type:', event.type);
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Webhook handler error:', err);
      res.status(500).send('Webhook handler error');
    }
  }
);

/* ------------------------------------------------------------------
   All other middleware/routes AFTER webhook
-------------------------------------------------------------------*/
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

/* ------------------------------------------------------------------
   Multer setup for image uploads
-------------------------------------------------------------------*/
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, unique + '-' + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

/* ------------------------------------------------------------------
   Image Upload Endpoints
-------------------------------------------------------------------*/
// Image upload endpoint
app.post('/upload-image', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${
    req.file.filename
  }`;

  // persist metadata
  try {
    const metaPath = path.join(
      __dirname,
      'public',
      'uploads',
      'metadata.json'
    );
    let meta = [];
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '[]');
    }
    meta.push({
      filename: req.file.filename,
      url: publicUrl,
      uploadedAt: new Date().toISOString(),
    });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.error('Failed to write metadata', err);
  }

  res.json({ url: publicUrl, filename: req.file.filename });
});

// Admin: list uploads
app.get('/admin/uploads', (req, res) => {
  try {
    const metaPath = path.join(
      __dirname,
      'public',
      'uploads',
      'metadata.json'
    );
    if (!fs.existsSync(metaPath)) return res.json([]);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '[]');
    res.json(meta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: delete upload
app.delete('/admin/uploads/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'public', 'uploads', filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const metaPath = path.join(
      __dirname,
      'public',
      'uploads',
      'metadata.json'
    );
    let meta = [];
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '[]');
    }
    meta = meta.filter((m) => m.filename !== filename);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Admin: save powergrid JSON (for resume dashboard resources)
-------------------------------------------------------------------*/
app.post('/admin/powergrid', requireAdmin, (req, res) => {
  try {
    const body = req.body;
    const outPath = path.join(__dirname, 'public', 'data');
    if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });
    const filePath = path.join(outPath, 'powergrid.json');
    fs.writeFileSync(filePath, JSON.stringify(body, null, 2));
    res.json({ saved: true, path: '/data/powergrid.json' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Create a subscription (Payment Element flow)
-------------------------------------------------------------------*/
app.post('/create-subscription', async (req, res) => {
  const { priceId, email } = req.body;
  if (!priceId) return res.status(400).json({ error: 'Missing priceId' });

  try {
    // Create a customer using the provided email (in production, reuse existing customers)
    const customer = await stripe.customers.create({ email });

    // Create subscription in 'default_incomplete' so we can collect payment using the Payment Element
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    const clientSecret =
      subscription.latest_invoice.payment_intent.client_secret;

    // Persist a lightweight subscriptions JSON
    try {
      const outPath = path.join(__dirname, 'public', 'data');
      if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });
      const subsFile = path.join(outPath, 'subscriptions.json');
      let subs = {};
      if (fs.existsSync(subsFile)) {
        subs = JSON.parse(fs.readFileSync(subsFile, 'utf8') || '{}') || {};
      }

      subs[subscription.id] = {
        id: subscription.id,
        email: email || '',
        status: subscription.status || 'incomplete',
        created: new Date().toISOString(),
      };

      fs.writeFileSync(subsFile, JSON.stringify(subs, null, 2));
    } catch (err) {
      console.error('Failed to write subscriptions file', err);
    }

    res.json({
      clientSecret,
      subscriptionId: subscription.id,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    });
  } catch (err) {
    console.error('Error creating subscription:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Debug: View Auth0 tier for a user by email
-------------------------------------------------------------------*/
app.get('/debug/auth0-tier', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Missing ?email= parameter' });
  }

  try {
    const users = await auth0Mgmt.getUsersByEmail(email);

    if (!users || users.length === 0) {
      return res
        .status(404)
        .json({ error: `No Auth0 user found for ${email}` });
    }

    const user = users[0];

    return res.json({
      email,
      user_id: user.user_id,
      app_metadata: user.app_metadata || {},
      user_metadata: user.user_metadata || {},
    });
  } catch (err) {
    console.error('Debug Auth0 error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Admin auth middleware
-------------------------------------------------------------------*/
function requireAdmin(req, res, next) {
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!pw)
    return res
      .status(403)
      .json({ error: 'Admin password not configured' });

  const header = req.headers['x-admin-password'];
  if (header && header === pw) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

/* ------------------------------------------------------------------
   AI rewrite endpoint (OpenAI)
-------------------------------------------------------------------*/
app.post('/ai/rewrite', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: 'OpenAI API key not configured' });

  const { bullets, tone = 'concise' } = req.body;
  if (!bullets || !Array.isArray(bullets)) {
    return res.status(400).json({ error: 'Missing bullets array' });
  }

  try {
    const fetch = require('node-fetch');
    const prompt = `Rewrite these resume bullets to be ${tone} and metrics-focused where possible:\n\n${bullets
      .map((b, i) => `${i + 1}. ${b}`)
      .join('\n')}`;
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
      }),
    });
    const j = await resp.json();
    const text =
      j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || '';
    const out = text
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    res.json({ rewritten: out, raw: text });
  } catch (err) {
    console.error('AI rewrite error', err);
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Local Bullet Crafting Endpoint
-------------------------------------------------------------------*/
function craftBulletsLocalServer(answers = {}, opts = {}) {
  const tone = opts.tone || 'concise';
  const chkCompliance = !!opts.emphasis?.compliance;
  const chkSafety = !!opts.emphasis?.safety;
  const chkLeadership = !!opts.emphasis?.leadership;

  const bits = {
    role: answers.role || '',
    scope: answers.scope || '',
    problem: answers.problem || '',
    actions: answers.actions || '',
    tools: answers.tools || '',
    metrics: answers.metrics || '',
    compliance: answers.compliance || '',
    safety: answers.safety || '',
  };

  const verbs = chkLeadership
    ? ['led', 'orchestrated', 'directed']
    : ['implemented', 'streamlined', 'optimized'];

  const closers = [];
  if (bits.metrics) closers.push(bits.metrics.replace(/^[-–—]\s*/, ''));
  if (chkCompliance && bits.compliance) closers.push(bits.compliance);
  if (chkSafety && bits.safety) closers.push(bits.safety);
  const closeStr = closers.length ? `; ${closers.join('; ')}` : '';

  const tonePrefix =
    tone === 'impact'
      ? 'Delivered measurable results: '
      : tone === 'compliance'
      ? 'Ensured regulatory readiness: '
      : tone === 'patient'
      ? 'Elevated patient safety: '
      : tone === 'leadership'
      ? 'Provided cross-functional leadership: '
      : '';

  const scopeStr = bits.scope ? ` (${bits.scope})` : '';
  const toolsStr = bits.tools ? ` using ${bits.tools}` : '';
  const probStr = bits.problem ? ` to address ${bits.problem}` : '';

  const base = `${tonePrefix}${verbs[0]} ${bits.actions}${toolsStr}${probStr}${scopeStr}${closeStr}`;
  const alt1 = `${verbs[1]} ${bits.actions}${probStr}; leveraged ${
    bits.tools || 'key tools'
  }${scopeStr}${closeStr}`;
  const alt2 = `${verbs[2]} workflows${toolsStr}${probStr}${scopeStr}${closeStr}`;

  return [base, alt1, alt2]
    .filter(Boolean)
    .map((s) => s.trim());
}

app.post('/api/bullets', (req, res) => {
  try {
    const { transcript = {}, emphasis = {}, tone = 'concise' } = req.body || {};
    const bullets = craftBulletsLocalServer(transcript, { emphasis, tone });
    return res.json({ bullets });
  } catch (err) {
    console.error('api/bullets error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/* ------------------------------------------------------------------
   Export HTML / DOCX
-------------------------------------------------------------------*/
app.post('/export/html', (req, res) => {
  const { title = 'Resume', html } = req.body;
  if (!html) return res.status(400).json({ error: 'Missing html' });

  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="/../style.css"></head><body>${html}</body></html>`;
  res.setHeader('Content-Disposition', 'attachment; filename="resume.html"');
  res.setHeader('Content-Type', 'text/html');
  res.send(doc);
});

app.post('/export/docx', (req, res) => {
  const { title = 'Resume', html } = req.body;
  if (!html) return res.status(400).json({ error: 'Missing html' });

  try {
    const htmlDocx = require('html-docx-js');
    const docx = htmlDocx.asBlob(
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${html}</body></html>`
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="resume.docx"'
    );
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    res.send(Buffer.from(docx));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------
   Tier helpers for Stripe / Auth0
-------------------------------------------------------------------*/
/**
 * Try to extract the tier ("starter", "pro", "elite") from the invoice.
 * You can store { "tier": "pro" } as metadata on:
 *  - the invoice itself
 *  - the first line item
 *  - the price or product
 */
function getTierFromInvoice(invoice) {
  const mdInvoice = invoice.metadata || {};
  const firstLine =
    invoice.lines && invoice.lines.data && invoice.lines.data[0];
  const mdLine = firstLine?.metadata || {};
  const price = firstLine?.price || {};
  const mdPrice = price.metadata || {};
  let mdProduct = {};
  if (price.product && typeof price.product === 'object') {
    mdProduct = price.product.metadata || {};
  }

  const tier = mdLine.tier || mdPrice.tier || mdProduct.tier || mdInvoice.tier;
  if (!tier) return null;

  const normalized = String(tier).toLowerCase();
  if (['starter', 'pro', 'elite'].includes(normalized)) return normalized;
  return null;
}

/**
 * Get tier ("starter", "pro", "elite") from a Stripe subscription object.
 * Looks at the first subscription item’s price/plan metadata.
 */
function getTierFromSubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  if (!item) return null;

  const mdPrice = (item.price && item.price.metadata) || {};
  const mdPlan = (item.plan && item.plan.metadata) || {};

  const rawTier = mdPrice.tier || mdPlan.tier;
  if (!rawTier) return null;

  const normalized = String(rawTier).toLowerCase();
  if (['starter', 'pro', 'elite'].includes(normalized)) return normalized;
  return null;
}

/**
 * Lookup Auth0 user by email, then set app_metadata.tier
 */
async function updateAuth0TierByEmail(email, tier) {
  const trimmed = (email || '').trim();
  if (!trimmed || !tier) return;

  try {
    const users = await auth0Mgmt.getUsersByEmail(trimmed);

    if (!users || users.length === 0) {
      console.warn('[auth0-sync] No user found for email:', trimmed);
      return;
    }

    const user = users[0];
    const userId = user.user_id;

    const newAppMetadata = {
      ...(user.app_metadata || {}),
      tier,
    };

    await auth0Mgmt.updateAppMetadata({ id: userId }, newAppMetadata);

    console.log(`[auth0-sync] Updated tier="${tier}" for userId=${userId}`);
  } catch (err) {
    console.error('Error updating Auth0 tier:', err);
  }
}

/* ------------------------------------------------------------------
   Basic health check
-------------------------------------------------------------------*/
app.get('/', (req, res) => {
  res.send('Blossom backend is running!');
});

/* ------------------------------------------------------------------
   Start server
-------------------------------------------------------------------*/
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => {
  console.log(`Stripe test server listening on http://localhost:${PORT}`);
});
