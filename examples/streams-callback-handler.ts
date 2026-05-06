/**
 * A minimal Express handler that parses AudD callbacks.
 *
 * Install your own express:
 *   npm install express
 *
 * Run: AUDD_API_TOKEN=... npx tsx examples/streams-callback-handler.ts
 *
 * This file prints the template — copy/paste into your own server. The
 * SDK doesn't ship an express dependency.
 */

const TEMPLATE = `\
import express from "express";
import { AudD } from "audd";

const app = express();
app.use(express.json());
const audd = new AudD({ apiToken: process.env.AUDD_API_TOKEN! });

app.post("/audd-callback", (req, res) => {
  const payload = audd.streams.parseCallback(req.body);
  if (payload.isResult && payload.result) {
    for (const r of payload.result.results) {
      console.log(\`radio=\${payload.result.radioId}  \${r.artist} — \${r.title}  score=\${r.score}\`);
    }
  } else if (payload.isNotification && payload.notification) {
    const n = payload.notification;
    console.log(\`radio=\${n.radioId}  notification \${n.notificationCode}: \${n.notificationMessage}\`);
  }
  res.json({ ok: true });
});

app.listen(5000);
`;

console.log(TEMPLATE);
