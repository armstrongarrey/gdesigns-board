# G-DESIGNS Board of Directors — Deployment Guide

## What's in this folder

| File | Purpose |
|------|---------|
| `server.js` | Node.js/Express backend — proxies calls to Anthropic API |
| `index.html` | Full chat UI (move to `public/` folder) |
| `app.js` | Frontend JavaScript (move to `public/` folder) |
| `manifest.json` | PWA manifest — enables "Add to Home Screen" (move to `public/`) |
| `package.json` | Node dependencies |
| `render.yaml` | One-click Render.com deploy config |

---

## Step 1 — Organise the files

Create a `public/` folder inside this project and move these files into it:
- `index.html` → `public/index.html`
- `app.js` → `public/app.js`
- `manifest.json` → `public/manifest.json`

Your final structure should look like:
```
gdesigns-board/
  public/
    index.html
    app.js
    manifest.json
  server.js
  package.json
  render.yaml
```

---

## Step 2 — Get your Anthropic API key

1. Go to https://console.anthropic.com
2. Sign in (create account if needed — free to start)
3. Click **API Keys** in the sidebar
4. Click **Create Key** → copy it (starts with `sk-ant-...`)

---

## Step 3 — Deploy to Render (free hosting)

### Option A — Using render.yaml (easiest)

1. Push this folder to a GitHub repository (free at github.com)
2. Go to https://render.com and sign up free
3. Click **New → Blueprint**
4. Connect your GitHub repo
5. Render reads `render.yaml` and auto-configures everything
6. Add your environment variable:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your key from Step 2
7. Click **Deploy** — done in ~2 minutes

### Option B — Manual setup on Render

1. Go to https://render.com → **New → Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Under **Environment Variables**, add:
   - `ANTHROPIC_API_KEY` = your key
5. Click **Create Web Service**

Your app will be live at: `https://gdesigns-board.onrender.com`

---

## Step 4 — Add your custom subdomain (optional but recommended)

1. In Render dashboard → your service → **Settings → Custom Domains**
2. Add: `board.gdesignsme.com`
3. In your domain registrar (where you bought gdesignsme.com), add a CNAME record:
   - Name: `board`
   - Value: `gdesigns-board.onrender.com`
4. Wait 5–10 minutes for DNS to propagate

---

## Step 5 — Add to phone home screen (PWA)

### On iPhone (Safari):
1. Open `board.gdesignsme.com` in Safari
2. Tap the **Share** button (box with arrow)
3. Tap **Add to Home Screen**
4. Name it "G-Board" and tap **Add**

### On Android (Chrome):
1. Open the URL in Chrome
2. Tap the **⋮** menu
3. Tap **Add to Home Screen**

### On laptop (Chrome):
1. Open the URL
2. Click the install icon in the address bar (looks like a screen with a + symbol)
3. Or: Chrome menu → **Save and share → Install page as app**

---

## Notes

- **Free tier on Render**: Your app "sleeps" after 15 minutes of inactivity. First load after sleep takes ~30 seconds to wake up. Upgrade to a paid plan ($7/month) to keep it always awake.
- **API costs**: Claude API charges per token. Board conversations are very affordable — roughly $0.01–0.03 per conversation.
- **Conversation history**: Saved in the browser's localStorage — persists across refreshes on the same device/browser.

---

## Support

Built by Claude for G-DESIGNS LTD · Learn. Create. Innovate.
