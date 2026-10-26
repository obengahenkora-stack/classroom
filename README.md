# Classroom: a Zoom-style live class for 400-500 students

Students open a link, type the class code and their official name, and watch. The teacher logs in with a password, starts the class, shares camera/screen, and downloads attendance afterwards.

## How it works

- **Video** runs on [LiveKit](https://livekit.io), an open-source SFU media server. This is what makes 500 viewers possible: the teacher uploads one stream and the server fans it out. Peer-to-peer WebRTC cannot do this.
- **This app** (Node + Express) issues join tokens, protects the teacher login, creates class codes, and records attendance.
- Students join **watch-only**. They can chat and raise a hand. The teacher can click **Allow** next to a student's name to let them speak, and **Mute** to take it back.

## Setup (about 10 minutes)

1. Create a free LiveKit Cloud project at https://cloud.livekit.io. Copy the **WebSocket URL**, **API key** and **API secret**.
   (You can self-host LiveKit instead; see https://docs.livekit.io/home/self-hosting/)
2. In this folder:
   ```
   npm install
   cp .env.example .env
   ```
3. Edit `.env` and fill in the LiveKit values and a long `HOST_PASSWORD`.
4. Run `npm start` and open http://localhost:3000/host.html.
5. Log in, click **Create class**, then **Start / open**. Share the link from **Copy link** with students.

## Using it in class

| Who | What |
|---|---|
| Teacher | `/host.html`, log in, create a class, open it, turn on camera/mic or share screen |
| Student | Open the shared link (or `/`), type the code and official name, click Join |

Students must type at least two words (first and last name). Names are checked on the server and shown to the teacher exactly as typed.

**Attendance:** the dashboard's *Attendance CSV* button (also in the class controls) lists every typed name with join time, leave time and minutes present. Opens in Excel.

## Recording

Recording uses LiveKit **Egress**, which is a separate service:

- LiveKit Cloud: enable Egress in the project and set up where recordings are stored (S3, Google Cloud Storage, etc.) in the LiveKit dashboard. Without storage configured, the Start recording button will show an error.
- Self-hosted: run the `livekit/egress` service next to LiveKit.

## Going live (so students can reach it)

`localhost` only works on your own computer. To let students in you must host this app on a public HTTPS address (camera/mic and screen sharing require HTTPS). Options: a small VPS, Render, Railway, Fly.io. Set the same `.env` values there.

Optional but recommended: in LiveKit Cloud, add a webhook pointing to `https://YOUR-DOMAIN/api/livekit-webhook` so "left" times are recorded even if a student's phone dies.

## Tips for 400-500 students

- Ask students to join with camera and mic off. They cannot publish anyway unless you allow them.
- Adaptive streaming is on, so students on weak connections automatically get lower video quality.
- Chat is limited to one message per 2 seconds per student. The teacher can switch student chat off.
- Do a test with 20-30 people before the first big class.
- Costs: LiveKit Cloud bills by participant minutes and bandwidth. Check their pricing page for a 500-student class; self-hosting avoids those fees but needs a strong server with good bandwidth.

## Files

- `server.js` – tokens, host login, rooms, attendance, recording, webhook
- `public/index.html` – student join page
- `public/host.html` – teacher login and class list
- `public/room.html`, `public/room.js` – the live classroom (video, chat, hand raise, controls)
- `data.json` – created automatically; stores classes and attendance
