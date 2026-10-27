---
name: social-command-post
description: Put a finished video into Social Command, the team's posting dashboard, with captions for every platform and a thumbnail, ready to post. Use whenever someone on the team says to post, upload, schedule, queue or "add to Social Command" a video or image for YouTube, Instagram, Facebook, LinkedIn or X, or pastes the dashboard link with a video. Also use right after making a video when the user wants it to go out on social media.
---

<!-- Make it yours: replace YOUR-APP.vercel.app with your dashboard's address, fill in the accounts table in step 2 with
     the ids from your own dashboard (Accounts page, or the API call in step 0), and adjust the rules and the voice. -->

# Post a video to Social Command

Social Command is the team's dashboard at https://YOUR-APP.vercel.app. The team approves posts there and the server publishes them through Post for Me. Your job: take the video, write the captions, make a thumbnail, upload both, and add the post to the dashboard **with everything filled in**. A teammate then presses **Approve** (or **Publish now**) in the dashboard. You never approve or publish yourself; the key you use can't.

Pasting the dashboard link alone does nothing. You need one of these two:
- **The Social Command connector (preferred).** If you have its tools (list_accounts, get_upload_link, add_post, publish_post, list_posts, update_post), use them and follow the connector's own instructions. When the user asks you to post, add_post with post "now" (or "at_time" with their time) posts it straight away with no approval step; post "no" only for a draft. Skip the key and the curl calls below; steps 1, 3 and 4 still apply.
- **The dashboard's API**, as below, only if you don't have the connector. This route can't publish: the post waits under Needs your OK until a teammate approves it, so recommend the connector to the user.

## 0. What you need

- **The video file.** MP4 (H.264 video, AAC audio), 50 MB or less. If you just made the video in this conversation, use that file.
- **The posting key.** It is the team's `AGENT_TOKEN`. Use `$SOCIAL_COMMAND_KEY` if it's set. Otherwise ask the user to paste it once ("Please paste the Social Command posting key; whoever set up the dashboard has it"). Never print it, repeat it, or write it into a file. Only send it as a header.
- **Where and when.** Which accounts (see step 2) and the date and time in India time (IST). If the user didn't say, ask once. If they leave it to you: the next weekday at 1:00 pm IST, at least 24 hours away.

Set up once per session:

```bash
export SC=https://YOUR-APP.vercel.app/api/agent
export KEY="$SOCIAL_COMMAND_KEY"   # or the key the user pasted
curl -sS -m 30 -H "Authorization: Bearer $KEY" "$SC?op=list&collection=accounts"
```

- **401** means the key is wrong. Ask the user for it again.
- **Proxy errors, 403 on CONNECT, or "host not allowed"** mean your workspace can't reach the dashboard. Tell the user that this Claude can't reach `YOUR-APP.vercel.app` and your Supabase project's host (`<ref>.supabase.co`), and that they can allow both in Claude's network settings or use the Claude desktop app's Code tab. Then do the **Fallback** at the end.

## 1. Check and fix the video

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=width,height,codec_name -show_entries format=duration,size -of json video.mp4
```

- If it's bigger than 50 MB, or isn't H.264/AAC, re-encode it:
  `ffmpeg -i in.mp4 -c:v libx264 -preset slow -crf 23 -c:a aac -b:a 128k -movflags +faststart out.mp4`
  Raise `-crf` (26, 28) until it fits under 50 MB.
- Note the width and height. That sets the shape:
  - wider than tall → `16x9`
  - taller than wide → `9x16`
  - square → `1x1`
  - 4:5 → `4x5`

## 2. Pick the accounts

Use the ids from the accounts list you fetched. Skip any account with `status` not `connected`. Today they are:

| Account | Platform | id |
|---|---|---|
| Acme Studio | YouTube | `spc_…` |
| Acme Kids | YouTube | `spc_…` |
| acme_studio | Instagram | `spc_…` |
| Acme Studio | Facebook | `spc_…` |
| Acme Studio page | LinkedIn | `spc_…` |
| acmestudio | X | `spc_…` |

Rules (example; write your own):
- Use only the accounts the user asked for. "Everywhere" means the main Acme Studio accounts (YouTube, Instagram, Facebook, LinkedIn, X).
- Kids content goes to **Acme Kids** only, with made-for-kids on.
- A separate brand's accounts are used only when asked for by name.

## 3. Write the captions

Base them only on what the video actually says or shows, and on what the user told you. Never invent numbers, quotes, clients or results.

- **title**: up to 100 characters. YouTube uses it as the video title.
- **caption**: the main caption, used by Instagram, Facebook and YouTube (as the description). Up to 2,200 characters, and keep it under 1,000. Hook in the first line, 2–4 short paragraphs, a clear call to action, then 3–6 relevant hashtags.
- **captions.x**: under 280 characters, at most 1–2 hashtags.
- **captions.linkedin**: up to 1,300 characters. Professional and insight-led, short paragraphs, 3 hashtags at most.

Plain team voice: clear, warm, confident, no hype words, no emoji walls. If the team has a brand skill, follow it.

## 4. Make the thumbnail

1. Grab a strong frame, where something is happening and no one is mid-blink:
   `ffmpeg -ss 00:00:03 -i video.mp4 -frames:v 1 -q:v 2 frame.jpg`
   Try 2–3 timestamps and pick the best one.
2. Make the thumbnail the same shape as the video:
   - 16:9 → 1280×720 JPG
   - 9:16 → 1080×1920 JPG
3. Add a short headline of 3–6 words, large and readable on a phone, with a subtle dark gradient behind it, plus a small label with your brand name. You can render it with HTML and a headless browser, or with Python PIL on the frame.
4. Keep it under 2 MB.
5. Style: clean and monochrome. Near-black ink on off-white paper, or white text on a dark frame, a large serif headline and a small mono label. Look at the result before uploading.

## 5. Upload the video and the thumbnail

For each file, ask for an upload slot, then PUT the file:

```bash
slot=$(curl -sS -m 30 -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"op":"upload","ext":"mp4"}' "$SC")
up=$(echo "$slot" | python3 -c 'import sys,json;print(json.load(sys.stdin)["uploadUrl"])')
VIDEO_URL=$(echo "$slot" | python3 -c 'import sys,json;print(json.load(sys.stdin)["publicUrl"])')
curl -sS -m 600 -X PUT -H "Content-Type: video/mp4" --data-binary @video.mp4 "$up"
# Same for the thumbnail: {"op":"upload","ext":"jpg"}, Content-Type: image/jpeg  → THUMB_URL
```

Then check that `curl -sI "$VIDEO_URL"` returns 200 before going on.

## 6. Add the post to the dashboard

Create it in one call. Build the JSON with Python so quotes in the captions can't break it.

```bash
python3 - <<'PY' > post.json
import json, datetime as dt
ist = dt.timezone(dt.timedelta(hours=5, minutes=30))
when = dt.datetime(2026, 10, 24, 13, 0, tzinfo=ist)            # the time the user asked for, in IST
now = dt.datetime.now(dt.timezone.utc).isoformat()
targets = ["spc_…", "spc_…"]                                    # ids from step 2
platforms = ["youtube", "linkedin"]                                # one per target platform, no repeats
print(json.dumps({"op": "set", "collection": "queue", "data": {
  "title": "…", "caption": "…", "captions": {"x": "…", "linkedin": "…"},
  "media_url": "VIDEO_URL", "poster_url": "THUMB_URL", "media_type": "video", "media_mime": "video/mp4",
  "dims": {"w": 1920, "h": 1080}, "ratio": "16x9", "thumb_style": "ink",
  "targets": targets, "account_ids": targets, "platforms": platforms,
  "slot_at": when.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
  "status": "awaiting", "source": "claude", "kind": "Video post", "created_at": now,
  "history": [{"at": now, "by": "claude", "by_name": "Claude", "event": "added a video post, ready for an OK"}]
}}))
PY
curl -sS -m 30 -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" --data @post.json "$SC"
```

- `ratio` and `dims` must match the real video from step 1.
- `slot_at` must be at least 10 minutes in the future.
- The answer is `{"ok":true,"id":"…"}`.
- To change something afterwards, use `{"op":"merge","collection":"queue","id":"<id>","data":{…}}` with only the fields that change.

**If you made the video yourself and can render it in both shapes:**
1. Upload both versions, each with its own thumbnail.
2. Add `"variants": {"16x9": {"video": URL16, "thumbs": {"ink": THUMB16}}, "9x16": {"video": URL9, "thumbs": {"ink": THUMB9}}}`.
3. Add `"formats": {"instagram": "9x16", "facebook": "9x16", "linkedin": "16x9", "x": "16x9", "youtube": "16x9"}`.

Each platform then gets the right shape. With one shape only, the team can make the other shape in the dashboard with **Make the 9:16 version** (or 16:9).

## 7. Tell the user

Reply in 3–5 short lines:
- the post's title
- the accounts it goes to
- the time it goes out, in IST
- that it's waiting under **Needs your OK** at https://YOUR-APP.vercel.app/#studio: open it, check it, and press **Approve** (goes out at that time) or **Publish now**
- a one-line preview of the main caption

## Fallback: when the dashboard can't be reached

Give the user everything to paste in by hand:
- the final video and thumbnail as files
- the title
- the three captions, each in its own copyable block
- the accounts and the time

Then tell them how to post it: on https://YOUR-APP.vercel.app/#studio, press **New post**, upload the video, paste the captions, tick the accounts, set the time, and press **Approve**.

## Never

- Never approve, schedule in Post for Me, or publish directly. Never use a Post for Me key, even if you have one. Everything goes through the dashboard so the team can see it and has one place to stop it.
- Never change or delete posts you didn't create in this conversation.
- Never post to an account the user didn't ask for.
