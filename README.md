# Church Family Feud (turn-based, internet-ready)

## How a game runs
1. Teams open the link and tap **Register as a team** (2 teams max). Everyone else joins as **audience**.
2. Host enters the PIN, taps **Shuffle** (5 random questions per team), then **Start game**.
3. Turns alternate: Team A, Team B, A, B... (10 turns).
   - Everyone sees the current question. The **audience drops their answers**.
   - Host taps **Close voting**. The team whose turn it is picks and locks in an answer.
   - Points = number of audience members who picked that same answer. The host and audience see the result and scoreboard. Teams never see scores.
   - Host taps **Next turn**.
4. After turn 10, tap **Finish game**.

Host buttons: Shuffle, Start, Close voting, Reopen voting (if you closed too early), Next turn, Reset.

## Put it on the internet (Render, free tier)
1. Create a free GitHub account and a new repository. Upload everything in this folder
   (`server.js`, `index.html`, `questions.json`, `package.json`, `render.yaml`, `Dockerfile`).
2. Create a free account at render.com, choose **New > Blueprint**, and select your repository.
3. When asked for `HOST_PIN`, type a PIN only you know. Click **Apply**.
4. After the deploy finishes, Render shows a link like `https://church-family-feud.onrender.com`.
   Share that link on your projector, WhatsApp group, or a QR code.

Notes for event day
- Free web services on Render go to sleep after about 15 minutes of no visits. Open the link yourself
  10 minutes before the event so it is awake. Free-tier rules can change, so check Render's current plan details.
- The game lives in the server's memory (and a temporary file). If the service restarts or redeploys, the game
  resets, so don't redeploy during the event.
- Run **one** instance only (the default). Scaling to several instances would split the game.
- Any host that runs Node 18+ or Docker works too (Railway, Fly.io, a VPS). Set `HOST_PIN`; the platform sets `PORT`.

## Run on your own laptop instead
    HOST_PIN=2468 node server.js
Players on the same Wi-Fi open the "Same Wi-Fi" address printed in the terminal.

## Edit the questions
Open `questions.json`. Each question needs 5 options, and there must be exactly 10 questions
(5 per team). Restart the server after changing it.

## Test
    PORT=3111 HOST_PIN=1234 node server.js    (in one terminal)
    node test.js                              (in another)
