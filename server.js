const express = require("express");
const session = require("express-session");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// Fanvue OAuth config
const FANVUE_CLIENT_ID = process.env.FANVUE_CLIENT_ID;
const FANVUE_CLIENT_SECRET = process.env.FANVUE_CLIENT_SECRET;
const FANVUE_REDIRECT_URI = process.env.FANVUE_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const FANVUE_AUTH_URL = "https://auth.fanvue.com/oauth2/auth";
const FANVUE_TOKEN_URL = "https://auth.fanvue.com/oauth2/token";
const FANVUE_API = "https://api.fanvue.com";
const APIV = "2025-06-26";

// Model UUIDs (your 3 models)
const MODELS = {
  leah: "47a27228-eb4a-48f5-949c-76f973410dd5",
  chloe: "f901ce73-86dd-4ebe-890f-8476176d9cd9",
  millie: "6f3cdfc7-ffb9-49d0-89bc-ca264c384ed8",
};
const MODEL_LIST = Object.values(MODELS);

// In-memory token storage (replace with Redis/DB in production)
let accessToken = null;
let refreshToken = null;
let tokenExpiry = null;
let cachedEarnings = null;  // Cache from artifact push

// Load mock data from JSON files
let mockSubscribers = [];
let mockFollowers = [];
try {
  mockSubscribers = JSON.parse(fs.readFileSync("./mock-subscribers.json", "utf8"));
  mockFollowers = JSON.parse(fs.readFileSync("./mock-followers.json", "utf8"));
  console.log(`Loaded ${mockSubscribers.length} mock subscriber records and ${mockFollowers.length} mock follower records`);
} catch(e) {
  console.warn("Could not load mock data files:", e.message);
  mockSubscribers = [];
  mockFollowers = [];
}

const mockRoster = [
  { uuid: "47a27228-eb4a-48f5-949c-76f973410dd5", name: "Leah" },
  { uuid: "f901ce73-86dd-4ebe-890f-8476176d9cd9", name: "Chloe" },
  { uuid: "6f3cdfc7-ffb9-49d0-89bc-ca264c384ed8", name: "Millie" },
];

// Session config
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-prod",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === "production", httpOnly: true },
  })
);

app.use(express.json());
app.use(express.static("public"));

// Helper: refresh access token if expired
async function ensureValidToken() {
  if (!refreshToken) throw new Error("Not authenticated with Fanvue");
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;

  console.log("Refreshing Fanvue token...");
  const res = await axios.post(FANVUE_TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: FANVUE_CLIENT_ID,
    client_secret: FANVUE_CLIENT_SECRET,
  });

  accessToken = res.data.access_token;
  refreshToken = res.data.refresh_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000 - 60000); // 1 min buffer
  return accessToken;
}

// Helper: paginated Fanvue API calls
async function fanvueCall(method, path, data = null, params = {}) {
  const token = await ensureValidToken();
  const config = {
    method,
    url: `${FANVUE_API}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Fanvue-API-Version": APIV,
    },
    params,
  };
  if (data) config.data = data;
  return axios(config);
}

async function fanvuePaged(path, baseParams = {}) {
  let all = [];
  let page = 1;
  for (;;) {
    const res = await fanvueCall("GET", path, null, {
      ...baseParams,
      page,
      size: 50,
    });
    const data = res.data.data || [];
    all.push(...data);
    if (!res.data.pagination || !res.data.pagination.hasMore) break;
    page++;
    if (page > 100) break;
  }
  return all;
}

// Routes

app.get("/auth/login", (req, res) => {
  const state = Math.random().toString(36);
  req.session.oauthState = state;
  const url = new URL(FANVUE_AUTH_URL);
  url.searchParams.set("client_id", FANVUE_CLIENT_ID);
  url.searchParams.set("redirect_uri", FANVUE_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "creator");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (state !== req.session.oauthState) {
    return res.status(400).send("OAuth state mismatch");
  }
  try {
    const tok = await axios.post(FANVUE_TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      client_id: FANVUE_CLIENT_ID,
      client_secret: FANVUE_CLIENT_SECRET,
      redirect_uri: FANVUE_REDIRECT_URI,
    });
    accessToken = tok.data.access_token;
    refreshToken = tok.data.refresh_token;
    tokenExpiry = Date.now() + (tok.data.expires_in * 1000 - 60000);
    req.session.authenticated = true;
    res.redirect("/");
  } catch (e) {
    console.error("OAuth error:", e.message);
    res.status(500).send("Authentication failed: " + e.message);
  }
});

// API: Get roster (only the 3 models)
app.get("/api/roster", async (req, res) => {
  try {
    if (!accessToken) {
      return res.json(mockRoster);
    }
    const all = await fanvuePaged("/agencies/creators");
    const roster = all.filter((c) => MODEL_LIST.includes(c.uuid));
    res.json(roster);
  } catch (e) {
    console.error("Roster error:", e.message);
    res.json(mockRoster);
  }
});

// API: Get earnings (last 30 days)
app.get("/api/earnings", async (req, res) => {
  try {
    // Return cached data from artifact push if available
    if (cachedEarnings && Array.isArray(cachedEarnings) && cachedEarnings.length > 0) {
      return res.json(cachedEarnings);
    }

    if (!accessToken) {
      // Fallback to mock data from Excel snapshot
      const mockData = JSON.parse(fs.readFileSync("./mock-earnings.json", "utf8"));
      return res.json(mockData);
    }
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 30);
    const startDate = start.toISOString().split("T")[0] + "T00:00:00Z";
    const endDate = new Date(today + "T00:00:00Z");
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    const earnings = await fanvuePaged("/agencies/earnings-by-day", {
      startDate,
      endDate: endDate.toISOString(),
      creatorUuids: [MODEL_LIST.join(",")],
    });
    res.json(earnings);
  } catch (e) {
    console.error("Earnings error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// API: Accept earnings data from artifact (POST)
app.post("/api/earnings", express.json(), (req, res) => {
  try {
    const data = req.body;
    if (!Array.isArray(data)) {
      return res.status(400).json({ error: "Expected array of earnings records" });
    }
    cachedEarnings = data;
    console.log(`Cached ${data.length} earnings records from artifact`);
    res.json({ ok: true, cached: data.length });
  } catch (e) {
    console.error("POST earnings error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// API: Get subscribers (last 30 days)
app.get("/api/subscribers", async (req, res) => {
  try {
    if (!accessToken) {
      return res.json(mockSubscribers);
    }
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 30);
    const startDate = start.toISOString().split("T")[0] + "T00:00:00Z";
    const endDate = new Date(today + "T00:00:00Z");
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    const subs = await fanvuePaged("/agencies/subscribers-history", {
      startDate,
      endDate: endDate.toISOString(),
      creatorUuids: [MODEL_LIST.join(",")],
    });
    res.json(subs);
  } catch (e) {
    console.error("Subscribers error:", e.message);
    res.json(mockSubscribers);
  }
});

// API: Get followers (last 30 days)
app.get("/api/followers", async (req, res) => {
  try {
    if (!accessToken) {
      return res.json(mockFollowers);
    }
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 30);
    const startDate = start.toISOString().split("T")[0] + "T00:00:00Z";
    const endDate = new Date(today + "T00:00:00Z");
    endDate.setUTCDate(endDate.getUTCDate() + 1);

    const followers = await fanvuePaged("/agencies/followers-history", {
      startDate,
      endDate: endDate.toISOString(),
      creatorUuids: [MODEL_LIST.join(",")],
    });
    res.json(followers);
  } catch (e) {
    console.error("Followers error:", e.message);
    res.json(mockFollowers);
  }
});

// Simple push form
app.get("/push", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Push Earnings Data</title>
      <style>
        body { background: #0F1117; color: #C9D1D9; font-family: -apple-system, "Segoe UI", sans-serif; padding: 40px; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { color: #58A6FF; }
        textarea { width: 100%; height: 300px; background: #161B22; color: #C9D1D9; border: 1px solid #30363D; padding: 12px; border-radius: 6px; font-family: monospace; }
        button { background: #3FB950; color: #161B22; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 14px; }
        button:hover { background: #2ea043; }
        .note { color: #8B949E; font-size: 13px; margin: 16px 0; }
        .success { color: #3FB950; }
        .error { color: #F85149; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Push Earnings to Dashboard</h1>
        <p>Paste your earnings data as JSON and submit</p>
        <textarea id="data" placeholder='[{"date":"2026-07-18","creatorUuid":"47a27228-eb4a-48f5-949c-76f973410dd5","gross":48138}]'></textarea>
        <div class="note">Format: [{"date":"YYYY-MM-DD","creatorUuid":"uuid","gross":cents}]</div>
        <button onclick="push()">Push to Dashboard</button>
        <div id="msg"></div>
      </div>
      <script>
        async function push(){
          const data = document.getElementById("data").value;
          const msg = document.getElementById("msg");
          try {
            const json = JSON.parse(data);
            const resp = await fetch("/api/earnings", {
              method: "POST",
              headers: {"Content-Type": "application/json"},
              body: JSON.stringify(json)
            });
            if(resp.ok){
              msg.innerHTML = '<p class="success">✓ Pushed '+json.length+' records. <a href="/" style="color:#58A6FF">View dashboard</a></p>';
            }else{
              msg.innerHTML = '<p class="error">✗ Error: '+resp.status+'</p>';
            }
          }catch(e){
            msg.innerHTML = '<p class="error">✗ Invalid JSON: '+e.message+'</p>';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true, authenticated: !!accessToken });
});

app.listen(PORT, () => {
  console.log(`Boost tracker server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT} in your browser`);
  if (!FANVUE_CLIENT_ID) {
    console.warn("⚠️  FANVUE_CLIENT_ID not set. Set env vars and restart.");
  }
});
