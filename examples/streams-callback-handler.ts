/**
 * A minimal Express handler that parses AudD callbacks via `handleCallback`.
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
import { handleCallback } from "@audd/sdk";

const app = express();
app.use(express.json());

app.post("/audd-callback", async (req, res) => {
  const { match, notification } = await handleCallback(req);
  if (match) {
    console.log(
      \`radio=\${match.radioId}  \${match.song.artist} - \${match.song.title}  score=\${match.song.score}\`,
    );
    for (const alt of match.alternatives) {
      // Alternatives may be variant catalog releases — different artist/title.
      console.log(\`  alt: \${alt.artist} - \${alt.title}\`);
    }
  } else if (notification) {
    console.log(
      \`radio=\${notification.radioId}  notification \${notification.notificationCode}: \${notification.notificationMessage}\`,
    );
  }
  res.json({ ok: true });
});

app.listen(5000);

// Note: handleCallback is duck-typed — also works with native http.IncomingMessage,
// the Web Request, or anything with .body / .text() / async-iterable chunks.
`;

console.log(TEMPLATE);
