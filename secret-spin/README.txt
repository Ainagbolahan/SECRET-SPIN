SECRET SPIN - quick start

1. Upload this folder to GitHub (or paste the files into Replit).
2. On Render: New > Web Service > connect the repo.
   Build command: npm install
   Start command: npm start
   Environment variable: ADMIN_PASSWORD = (your own strong password)
3. Open https://YOUR-APP-ADDRESS/admin, log in, paste the names, click "Copy all links",
   and send each person ONLY their own link.

Notes:
- Each person can spin once; the server picks a name that is not theirs and not already taken.
- Free hosting may erase data.json on restart/redeploy. Do not redeploy mid-event,
  and copy the admin table when everyone has spun.
- Optional: set DATA_DIR to a persistent disk path to keep data across restarts.
