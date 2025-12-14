// auth0Sync.js
const fetch = global.fetch || ((...args) => import("node-fetch").then(({default: f}) => f(...args)));

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN; // e.g. "dev-xxxx.us.auth0.com"
const AUTH0_M2M_CLIENT_ID = process.env.AUTH0_M2M_CLIENT_ID;
const AUTH0_M2M_CLIENT_SECRET = process.env.AUTH0_M2M_CLIENT_SECRET;

// If you're using Auth0 Database connection:
const AUTH0_DB_CONNECTION = process.env.AUTH0_DB_CONNECTION || "Username-Password-Authentication";

async function getManagementToken() {
  const res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: AUTH0_M2M_CLIENT_ID,
      client_secret: AUTH0_M2M_CLIENT_SECRET,
      audience: `https://${AUTH0_DOMAIN}/api/v2/`,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Auth0 token error: ${data.error || res.statusText}`);
  return data.access_token;
}

async function getUsersByEmail(token, email) {
  const url = `https://${AUTH0_DOMAIN}/api/v2/users-by-email?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Auth0 users-by-email error: ${data.message || res.statusText}`);
  return data; // array
}

function strongRandomPassword() {
  // Good enough for "account exists" until they reset/set password
  // (Auth0 requires a password to create DB users)
  return `S!${cryptoRandom()}aA9#${cryptoRandom()}`;
}
function cryptoRandom() {
  return require("crypto").randomBytes(16).toString("hex");
}

async function createDbUser(token, email) {
  const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      connection: AUTH0_DB_CONNECTION,
      email,
      email_verified: true,        // ✅ you said you trust Stripe email
      verify_email: false,         // don't send verification
      password: strongRandomPassword(),
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Auth0 create user error: ${data.message || res.statusText}`);
  return data; // user object
}

async function updateAppMetadata(token, userId, appMetadata) {
  const res = await fetch(`https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ app_metadata: appMetadata }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Auth0 update user error: ${data.message || res.statusText}`);
  return data;
}

/**
 * Create user if missing, then set tier in app_metadata.
 * Returns { userId, created, user }
 */
async function getOrCreateUserAndSetTier({ email, tier, billing, stripeCustomerId, subscriptionId }) {
  if (!email) throw new Error("Missing email for Auth0 sync");

  const token = await getManagementToken();

  const matches = await getUsersByEmail(token, email);
  let user = matches?.[0];
  let created = false;

  if (!user) {
    user = await createDbUser(token, email);
    created = true;
  }

  // Merge existing app_metadata (if any) with new values
  const nextAppMetadata = {
    ...(user.app_metadata || {}),
    tier,
    billing,
    stripeCustomerId,
    subscriptionId,
    updatedAt: new Date().toISOString(),
  };

  const updated = await updateAppMetadata(token, user.user_id, nextAppMetadata);

  return { userId: updated.user_id, created, user: updated };
}

module.exports = { getOrCreateUserAndSetTier };

