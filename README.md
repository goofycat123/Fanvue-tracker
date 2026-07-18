# Fanvue Boost Tracker — Public Server

A public read-only dashboard for tracking boost streaks across Leah, Chloe, and Millie.

## Setup

### 1. Get Fanvue OAuth Credentials

You need to register an OAuth app with Fanvue (as the agency admin).

**Steps:**
1. Log into Fanvue as your agency admin account
2. Go to **Developer Settings** (or check Fanvue's docs for the dev portal URL)
3. Create a new OAuth app with these details:
   - **Name**: Boost Tracker
   - **Redirect URI**: `https://your-railway-domain.up.railway.app/auth/callback` (get this after deploying to Railway)
   - **Scopes**: `creator` (agency access)
4. Copy the **Client ID** and **Client Secret**

### 2. Deploy to Railway

1. Push this repo to GitHub
2. Open [railway.app](https://railway.app) and log in
3. Click **New Project** → **Deploy from GitHub repo**
4. Select this repo
5. Railway will auto-detect and start building

### 3. Configure Environment Variables

After deployment starts, go to Railway's **Variables** tab and set:

```
FANVUE_CLIENT_ID=<your client ID from step 1>
FANVUE_CLIENT_SECRET=<your client secret from step 1>
SESSION_SECRET=<generate a random string, e.g., $(openssl rand -hex 32)>
NODE_ENV=production
```

### 4. Authorize Once

1. Get your Railway domain (looks like `boost-tracker-production.up.railway.app`)
2. Visit `https://your-domain/auth/login` in your browser
3. You'll be redirected to Fanvue to authorize
4. Once authorized, the app will have access to your agency data

### 5. Share the URL

After authorization, your public dashboard is at `https://your-domain/`

Share this link with friends — it's **read-only**, so anyone can see the data but can't toggle anything.

## Local Development

```bash
npm install
cp .env.example .env
# Edit .env with your Fanvue credentials and a SESSION_SECRET

npm run dev
# Visits http://localhost:3000
```

On first run, visit `http://localhost:3000/auth/login` to authorize with Fanvue.

## What Your Friends See

- **KPIs**: Today's gross, 7-day gross, new subs, new followers
- **Creator cards**: Per-model 7-day totals, today's numbers, net subs, new followers, 14-day sparkline
- **Subscriber table**: 7-day new/cancelled/expired/net per creator
- **Read-only**: No toggles for boosts or Fanvue activation

Data refreshes every 5 minutes.

## Notes

- Tokens are stored in-memory; on Railway restarts, you'll need to re-authorize by visiting `/auth/login`
- For production, consider persistent token storage (Redis, Database)
- The dashboard only tracks Leah, Chloe, and Millie (model UUIDs in `server.js`)
