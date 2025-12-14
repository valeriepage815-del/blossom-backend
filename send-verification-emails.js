const fetch = (...args) =>
  import('node-fetch').then(({ default: f }) => f(...args));

const fs = require("fs");
const path = require("path");

// --- 1. Config from environment variables ---
const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_MGMT_TOKEN = process.env.AUTH0_MGMT_TOKEN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;

// Validate env vars
if (!AUTH0_DOMAIN || !AUTH0_MGMT_TOKEN || !AUTH0_CLIENT_ID) {
  console.error("❌ Missing environment variables");
  console.error("Make sure you ran:");
  console.error("  export AUTH0_DOMAIN=xxxx");
  console.error("  export AUTH0_MGMT_TOKEN=xxxx");
  console.error("  export AUTH0_CLIENT_ID=xxxx");
  process.exit(1);
}

// --- 2. Load unverified users CSV ---
const csvPath = path.join(__dirname, "data", "unverified-users.csv");
if (!fs.existsSync(csvPath)) {
  console.error("❌ Missing data/unverified-users.csv. Run analyze-auth0-users.js first.");
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, "utf8");
const rows = csv
  .split("\n")
  .slice(1) // skip header
  .map((line) => line.split(","))
  .filter((cols) => cols.length >= 2)
  .map((cols) => ({
    id: cols[0].replace(/"/g, ""),
    email: cols[1].replace(/"/g, ""),
  }));

console.log(`📬 Preparing to resend verification to ${rows.length} users...`);

// --- 3. Send verification email for each user ---
async function sendVerifyEmail(user) {
  const url = `https://${AUTH0_DOMAIN}/api/v2/jobs/verification-email`;

  const body = {
    user_id: user.id,
    client_id: AUTH0_CLIENT_ID,
  };

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
    console.error(`❌ Failed for ${user.email}:`, text);
    return false;
  }

  console.log(`✅ Sent verification email to: ${user.email}`);
  return true;
}

// --- 4. Process all users sequentially ---
(async () => {
  for (const user of rows) {
    await sendVerifyEmail(user);
    await new Promise((res) => setTimeout(res, 300)); // small delay to avoid rate limit
  }

  console.log("🎉 Done sending all verification emails!");
})();
