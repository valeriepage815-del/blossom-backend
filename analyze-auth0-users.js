// analyze-auth0-users.js
// Usage: node analyze-auth0-users.js

const fs = require("fs");
const path = require("path");

// 1. Load the export file
const filePath = path.join(__dirname, "data", "auth0-users-export.json");
const raw = fs.readFileSync(filePath, "utf8");

// Your export might be either:
//  - a JSON array: [ {...}, {...} ]
//  - newline-delimited JSON: {...}\n{...}\n
let records;
try {
  // Try parsing as full JSON array
  const parsed = JSON.parse(raw);
  records = Array.isArray(parsed) ? parsed : [];
} catch (e) {
  // Fallback: newline-delimited JSON, ignoring bad lines
  records = raw
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("{") && line.endsWith("}"))
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(Boolean);
}

console.log(`Loaded ${records.length} user records`);

// Helper to safely read keys like "Email Verified", "app_metadata"
const get = (obj, key) =>
  Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;

// ---- Quick stats ----
const total = records.length;
const verifiedCount = records.filter((u) => get(u, "Email Verified")).length;
const byTier = records.reduce((acc, u) => {
  // app_metadata might be under "app_metadata" or "App Metadata"
  const meta = get(u, "app_metadata") || get(u, "App Metadata") || {};
  let tier = "none";
  if (typeof meta === "object" && meta.tier) {
    tier = meta.tier;
  } else if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta);
      if (parsed && parsed.tier) tier = parsed.tier;
    } catch {
      /* ignore */
    }
  }
  acc[tier] = (acc[tier] || 0) + 1;
  return acc;
}, {});

console.log("Total users:", total);
console.log("Verified emails:", verifiedCount);
console.log("Users by tier:", byTier);

// 2. ---- Users with unverified email ----
const unverified = records.filter((u) => !get(u, "Email Verified"));

console.log(`Found ${unverified.length} users with unverified email.`);

// Write a simple CSV with the info you care about
const unverifiedCsvLines = [
  "id,email,email_verified,connection", // header
  ...unverified.map((u) =>
    [
      JSON.stringify(get(u, "Id") || ""),
      JSON.stringify(get(u, "Email") || ""),
      JSON.stringify(get(u, "Email Verified")),
      JSON.stringify(get(u, "Connection") || ""),
    ].join(",")
  ),
];

fs.writeFileSync(
  path.join(__dirname, "data", "unverified-users.csv"),
  unverifiedCsvLines.join("\n"),
  "utf8"
);
console.log("Wrote data/unverified-users.csv");

// 3. ---- Duplicate emails (possible merges) ----
const byEmail = new Map();

for (const u of records) {
  const email = (get(u, "Email") || "").toLowerCase();
  if (!email) continue;

  if (!byEmail.has(email)) byEmail.set(email, []);
  byEmail.get(email).push(u);
}

// Only keep emails that appear more than once
const duplicateGroups = Array.from(byEmail.values()).filter(
  (group) => group.length > 1
);

console.log(`Found ${duplicateGroups.length} email(s) with duplicates.`);

// For each group, pick a "primary" user and mark the rest as "secondary"
function hasAppMetadata(u) {
  const meta = get(u, "app_metadata") || get(u, "App Metadata");
  if (!meta) return false;
  if (typeof meta === "object") return Object.keys(meta).length > 0;
  // if it's a JSON string:
  try {
    const parsed = JSON.parse(meta);
    return parsed && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

const mergeRows = [];
mergeRows.push(
  [
    "email",
    "primary_id",
    "primary_connection",
    "primary_has_app_metadata",
    "secondary_id",
    "secondary_connection",
    "secondary_has_app_metadata",
  ].join(",")
);

for (const group of duplicateGroups) {
  // Choose primary:
  //   1) user with app_metadata, otherwise
  //   2) fall back to the first user
  const primary = group.find(hasAppMetadata) || group[0];

  for (const u of group) {
    if (u === primary) continue;

    const row = [
      JSON.stringify((get(primary, "Email") || "").toLowerCase()),
      JSON.stringify(get(primary, "Id") || ""),
      JSON.stringify(get(primary, "Connection") || ""),
      JSON.stringify(hasAppMetadata(primary)),
      JSON.stringify(get(u, "Id") || ""),
      JSON.stringify(get(u, "Connection") || ""),
      JSON.stringify(hasAppMetadata(u)),
    ].join(",");
    mergeRows.push(row);
  }
}

fs.writeFileSync(
  path.join(__dirname, "data", "duplicate-candidates.csv"),
  mergeRows.join("\n"),
  "utf8"
);
console.log("Wrote data/duplicate-candidates.csv");

