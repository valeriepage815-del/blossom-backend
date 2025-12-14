// merge-duplicate-users.js
// Usage:
//   export AUTH0_DOMAIN=dev-uklq6cttc00bipil.us.auth0.com
//   export AUTH0_MGMT_TOKEN=your_management_api_token
//   node merge-duplicate-users.js

const fs = require("fs");
const path = require("path");

// Node 18+ has global fetch; if you were on older Node, we'd add node-fetch.

// --- Config -----------------------------------------------------------------

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_MGMT_TOKEN = process.env.AUTH0_MGMT_TOKEN;

// SAFETY: start in DRY RUN mode so you can see what it *would* do.
const DRY_RUN = true; // <-- flip to false when you're 100% ready

if (!AUTH0_DOMAIN || !AUTH0_MGMT_TOKEN) {
  console.error("❌ Missing AUTH0_DOMAIN or AUTH0_MGMT_TOKEN env vars.");
  console.error("Example:");
  console.error("  export AUTH0_DOMAIN=dev-uklq6cttc00bipil.us.auth0.com");
  console.error("  export AUTH0_MGMT_TOKEN=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...");
  process.exit(1);
}

// --- 1. Read duplicate-candidates.csv ---------------------------------------

const csvPath = path.join(__dirname, "data", "duplicate-candidates.csv");
if (!fs.existsSync(csvPath)) {
  console.error("❌ data/duplicate-candidates.csv not found. Run analyze-auth0-users.js first.");
  process.exit(1);
}

const rawCsv = fs.readFileSync(csvPath, "utf8").trim();
const lines = rawCsv.split("\n");

// header:
// email,primary_id,primary_connection,primary_has_app_metadata,
// secondary_id,secondary_connection,secondary_has_app_metadata
const header = lines[0];
const rows = lines.slice(1).filter((l) => l.trim().length > 0);

function parseCsvLine(line) {
  // We wrote fields as JSON.stringify(...) so we can safely parse by wrapping in []
  return JSON.parse("[" + line + "]");
}

const pairs = rows.map((line) => {
  const [
    email,
    primary_id,
    primary_connection,
    primary_has_app_metadata,
    secondary_id,
    secondary_connection,
    secondary_has_app_metadata,
  ] = parseCsvLine(line);

  return {
    email,
    primary_id,
    primary_connection,
    primary_has_app_metadata,
    secondary_id,
    secondary_connection,
    secondary_has_app_metadata,
  };
});

console.log(`📂 Loaded ${pairs.length} duplicate user pair(s) from CSV.`);

// --- 2. Helpers for Auth0 Management API ------------------------------------

async function auth0GetUser(userId) {
  const url = `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${AUTH0_MGMT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${userId} failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function auth0PatchUser(userId, body) {
  const url = `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`;

  if (DRY_RUN) {
    console.log(`🧪 [DRY RUN] Would PATCH user ${userId} with:`, JSON.stringify(body, null, 2));
    return;
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${AUTH0_MGMT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH ${userId} failed: ${res.status} ${text}`);
  }

  console.log(`✅ Updated user ${userId}`);
}

async function auth0DeleteUser(userId) {
  const url = `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(userId)}`;

  if (DRY_RUN) {
    console.log(`🧪 [DRY RUN] Would DELETE secondary user ${userId}`);
    return;
  }

  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${AUTH0_MGMT_TOKEN}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${userId} failed: ${res.status} ${text}`);
  }

  console.log(`🗑️  Deleted secondary user ${userId}`);
}

// Optional: link identities so one user can log in with both methods
async function auth0LinkUsers(primaryUser, secondaryUser) {
  const secondaryIdentity = secondaryUser.identities && secondaryUser.identities[0];
  if (!secondaryIdentity) {
    console.log(
      `⚠️ No identities found on secondary user ${secondaryUser.user_id}, skipping link.`
    );
    return;
  }

  const url = `https://${AUTH0_DOMAIN}/api/v2/users/${encodeURIComponent(
    primaryUser.user_id
  )}/identities`;

  const body = {
    provider: secondaryIdentity.provider,
    user_id: secondaryIdentity.user_id,
  };

  if (DRY_RUN) {
    console.log(
      `🧪 [DRY RUN] Would LINK identity ${secondaryIdentity.provider}|${secondaryIdentity.user_id} into ${primaryUser.user_id}`
    );
    return;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AUTH0_MGMT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `LINK ${secondaryIdentity.provider}|${secondaryIdentity.user_id} -> ${primaryUser.user_id} failed: ${res.status} ${text}`
    );
  }

  console.log(
    `🔗 Linked secondary identity ${secondaryIdentity.provider}|${secondaryIdentity.user_id} into primary user ${primaryUser.user_id}`
  );
}

// --- 3. Merge app_metadata ---------------------------------------------------

function mergeAppMetadata(primary, secondary) {
  const pMeta = primary.app_metadata || {};
  const sMeta = secondary.app_metadata || {};

  // Merge: primary wins on conflicts (so we don't overwrite your existing data)
  return { ...sMeta, ...pMeta };
}

// --- 4. Main processing loop -------------------------------------------------

(async () => {
  console.log(DRY_RUN ? "🧪 Running in DRY RUN mode." : "🚨 LIVE MODE: changes will be applied.");

  for (const pair of pairs) {
    const { email, primary_id, secondary_id } = pair;

    console.log("\n────────────────────────────────────────────");
    console.log(`👤 Email: ${email}`);
    console.log(`   Primary:   ${primary_id}`);
    console.log(`   Secondary: ${secondary_id}`);

    try {
      const primaryUser = await auth0GetUser(primary_id);
      const secondaryUser = await auth0GetUser(secondary_id);

      console.log(
        `   Primary app_metadata:`,
        JSON.stringify(primaryUser.app_metadata || {}, null, 2)
      );
      console.log(
        `   Secondary app_metadata:`,
        JSON.stringify(secondaryUser.app_metadata || {}, null, 2)
      );

      // 1) Merge app_metadata onto primary
      const mergedMeta = mergeAppMetadata(primaryUser, secondaryUser);
      console.log("   → Merged app_metadata would be:", JSON.stringify(mergedMeta, null, 2));

      await auth0PatchUser(primary_id, { app_metadata: mergedMeta });

      // 2) Link identities (so user can log in via email/password OR Google)
      await auth0LinkUsers(primaryUser, secondaryUser);

      // 3) Delete secondary (once you're sure)
      await auth0DeleteUser(secondary_id);

      // Small delay so we don't hammer the API
      await new Promise((res) => setTimeout(res, 1500));
    } catch (e) {
      const msg = e.message || "";
      console.error(`❌ Error processing pair for ${email}:`, msg);

      // If we hit Auth0 global rate limit, stop this run
      if (msg.includes("too_many_requests") || msg.includes("Too Many Requests")) {
        console.error(
          "⏸ Hit Auth0 global rate limit. Stopping this run. Wait 5–10 minutes, then re-run."
        );
        break;
      }
    }
  }

  console.log("\n✨ Done processing duplicate users.");
})();

