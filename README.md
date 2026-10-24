# Crimson Chat — browser photos + LIVE video

A three-person browser chat with public/private messaging, **photo sending**, **opt-in live camera broadcasts**, the user's square-edged crimson/black sketch-style UI, the original image-based map (NOT a real map service), annotation and waypoint tools, and full-interface grit/contrast/hue/saturation filters.

## Publish as a website (GitHub + Render)

You don't need to install an app on your phone. The Node.js server runs on a hosting service and phones use the website in Chrome, Edge or Safari.

1. Extract the ZIP file.
2. Open https://github.com/new and make a new repository, such as `crimson-chat`.
3. Upload **`server.js`**, **`package.json`**, **`README.md`** and the complete **`public` folder**. Keep the folder name `public`.
4. Open https://dashboard.render.com and create **New > Web Service**, connecting that GitHub repository.
5. Select the Node environment. **Build command:** `npm install`. **Start command:** `npm start`.
6. Deploy, then open the HTTPS website URL Render gives you. Share that URL with up to two other people.
7. If you already deployed an earlier version, replace the old repository files with the files from this ZIP so Render can redeploy it.

For local development with Node.js installed, run `npm install` and `npm start`, then open http://localhost:3000 on the same computer. Other devices need the deployed HTTPS link.

**Camera and microphone require HTTPS** (or localhost during local development). Your browser will ask for permission. Video is not automatically recorded or stored by the server.

## Photos

- In public or private chat, press the small **photo square (▣)** beside the message field.
- Choose an image from your phone or computer, preview it, optionally write a caption and press **send photo**.
- The browser resizes and converts images to JPEG before uploading, removing embedded metadata. Images are limited to about 650 KB after compression.
- Photos are delivered **only to the currently selected public or private conversation**. The server checks conversation membership for every photo.
- Click/tap an image bubble to enlarge it.
- A maximum of 10 photos per conversation are kept in **temporary server memory**, and older photo messages expire first. Files are not saved to permanent storage; a server restart removes the history.

## Live video

- Press **● go live** above the chat to open the LIVE panel.
- Optionally check **include microphone audio** (unchecked by default), then press **start camera**. Grant camera (and, if enabled, microphone) permission in your browser.
- While streaming, a **● LIVE · watch** indicator appears **beneath your name** in the three-person header. It also appears beneath the contact name in private chat when that contact is live.
- Other connected people tap that LIVE indicator to open and watch your video. Viewing is a choice: the camera is never automatically shown to viewers.
- You can close the preview while remaining live. To finish, reopen your own LIVE panel and press **stop broadcasting**. Closing or disconnecting your browser also stops the live video.
- LIVE video uses peer-to-peer **WebRTC** with Socket.IO signaling. The server forwards only connection setup messages, not the video frames. **Some mobile/carrier, school, or restricted networks require a TURN relay** for WebRTC to work reliably; this starter build has a public STUN server only and no TURN account. Live video is not guaranteed to connect on every network.
- Broadcasts are visible to all connected users in the three-person chat, not only the active private conversation.

## Existing features preserved

- Up to 3 users by unique display name (no passwords/accounts).
- The public chat and individual one-on-one private chats.
- User-supplied static map screenshot instead of a real-world map provider.
- Public/private notes and multi-point paths, with permission checks on the server.
- Full-UI filters for grit, contrast, hue, saturation, saved in each browser.
- Square corners, red/black theme, three name tabs, white bar map icon, private chat back arrow.

## Limitations and privacy

- There is **no user sign-in or verified identity**, and no end-to-end encryption of chat photos/messages. Use this only with people you trust; avoid sharing sensitive information.
- Photos/messages/markers exist in server RAM and disappear after server restarts; private rooms are based on temporary connected socket IDs.
- Photos are delivered as compressed images via Socket.IO, not a persistent file hosting service.
- Video WebRTC signaling has been code-tested and the browser UI has been exercised, but an end-to-end two-device camera stream needs to be verified on your deployed HTTPS site. STUN alone won't work across all networks.
- Render free instances (if available) can sleep during inactivity, interrupting chats and live broadcasts.

## Files

- `public/index.html` — screens, dialogs, camera/photo controls
- `public/style.css` — original hard-edged interface and media styling
- `public/app.js` — chat, map tools, photo resizing, live video via WebRTC
- `public/map-image.png` — the supplied fixed map picture
- `public/grit-noise.png` — offline UI grit texture
- `server.js` — chat/photo rooms, live state, and WebRTC signaling
- `package.json` — Node dependencies (`express`, `socket.io`)
