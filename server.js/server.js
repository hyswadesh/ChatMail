const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { google } = require("googleapis");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APP_URL = process.env.APP_URL;

const PROJECT_ID = "handy-post-360814";
const TOPIC_NAME = `projects/${PROJECT_ID}/topics/chatmail-gmail`;

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  `${APP_URL}/oauth2callback`
);

let refreshToken = null;
let historyId = null;
let oauthState = null;

const clients = new Set();

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send"
];

app.get("/", (req, res) => {
  res.json({
    app: "ChatMail",
    status: "online"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    gmailConnected: !!refreshToken
  });
});

app.get("/auth/google", (req, res) => {
  oauthState = crypto.randomBytes(24).toString("hex");

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: oauthState
  });

  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    if (!req.query.code) {
      return res.status(400).send("Missing authorization code");
    }

    if (oauthState && req.query.state !== oauthState) {
      return res.status(403).send("Invalid OAuth state");
    }

    const { tokens } = await oauth2Client.getToken(req.query.code);

    if (!tokens.refresh_token) {
      return res.status(400).send(
        "No refresh token received. Please authorize again."
      );
    }

    refreshToken = tokens.refresh_token;
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    const profile = await gmail.users.getProfile({
      userId: "me"
    });

    historyId = profile.data.historyId;

    await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: TOPIC_NAME,
        labelIds: ["INBOX"]
      }
    });

    res.send(`
      <html>
        <body style="font-family:Arial;padding:40px">
          <h2>ChatMail Gmail Connected ✅</h2>
          <p>Account: ${profile.data.emailAddress}</p>
          <p>You can close this page and return to ChatMail.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error(error);
    res.status(500).send("Gmail connection failed.");
  }
});

app.post("/gmail/webhook", async (req, res) => {
  res.status(204).send();

  try {
    const message = req.body?.message;

    if (!message?.data || !refreshToken) {
      return;
    }

    const decoded = JSON.parse(
      Buffer.from(message.data, "base64").toString("utf8")
    );

    const newHistoryId = decoded.historyId;

    oauth2Client.setCredentials({
      refresh_token: refreshToken
    });

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client
    });

    if (!historyId) {
      historyId = newHistoryId;
      return;
    }

    const result = await gmail.users.history.list({
      userId: "me",
      startHistoryId: historyId,
      historyTypes: ["messageAdded"]
    });

    const histories = result.data.history || [];

    for (const item of histories) {
      const added = item.messagesAdded || [];

      for (const entry of added) {
        const messageId = entry.message?.id;

        if (!messageId) continue;

        const mail = await gmail.users.messages.get({
          userId: "me",
          id: messageId,
          format: "metadata",
          metadataHeaders: [
            "From",
            "To",
            "Subject",
            "Date"
          ]
        });

        const headers = mail.data.payload?.headers || [];

        const getHeader = (name) =>
          headers.find(
            h => h.name.toLowerCase() === name.toLowerCase()
          )?.value || "";

        const data = {
          id: mail.data.id,
          threadId: mail.data.threadId,
          from: getHeader("From"),
          to: getHeader("To"),
          subject: getHeader("Subject"),
          date: getHeader("Date"),
          snippet: mail.data.snippet || ""
        };

        for (const client of clients) {
          client.write(
            `data: ${JSON.stringify(data)}\n\n`
          );
        }
      }
    }

    historyId = newHistoryId;

  } catch (error) {
    console.error("Gmail webhook error:", error);
  }
});

app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify({
    type: "connected"
  })}\n\n`);

  clients.add(res);

  req.on("close", () => {
    clients.delete(res);
  });
});

app.get("/status", (req, res) => {
  res.json({
    connected: !!refreshToken,
    clients: clients.size
  });
});

app.listen(PORT, () => {
  console.log(`ChatMail backend running on port ${PORT}`);
});
