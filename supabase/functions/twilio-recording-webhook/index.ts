// Supabase Edge Function: twilio-recording-webhook
//
// Handles Twilio Video status callbacks for the recording flow:
//   - room-ended           -> creates a Composition for the room
//   - composition-available -> downloads composition media and uploads to Storage
//
// Deploy via Lovable's Supabase Edge Function UI, or with the Supabase CLI:
//   supabase functions deploy twilio-recording-webhook --no-verify-jwt
//
// Env vars (set in Supabase Edge Function secrets):
//   - WEBHOOK_KEY          required, shared secret used in the ?key= query param
//   - TWILIO_API_KEY       required (the SK... API key, NOT the Account SID)
//   - TWILIO_API_SECRET    required (the API key's secret)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_KEY = Deno.env.get("WEBHOOK_KEY") ?? "";
const TWILIO_API_KEY = Deno.env.get("TWILIO_API_KEY") ?? "";
const TWILIO_API_SECRET = Deno.env.get("TWILIO_API_SECRET") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[boot] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
if (!WEBHOOK_KEY) console.error("[boot] WEBHOOK_KEY not set — function will reject all requests");
if (!TWILIO_API_KEY || !TWILIO_API_SECRET) {
  console.error("[boot] TWILIO_API_KEY / TWILIO_API_SECRET not set — composition + media download will fail");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TWILIO_BASIC_AUTH =
  "Basic " + btoa(`${TWILIO_API_KEY}:${TWILIO_API_SECRET}`);

// Edge Function URL we'll pass back to Twilio as the composition's status callback.
const SELF_URL =
  `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/twilio-recording-webhook?key=${encodeURIComponent(WEBHOOK_KEY)}`;

async function twilio(
  path: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  form?: Record<string, string | string[]>,
): Promise<any> {
  const url = `https://video.twilio.com${path}`;
  const headers: Record<string, string> = { Authorization: TWILIO_BASIC_AUTH };
  let body: BodyInit | undefined;
  if (form) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
      else params.append(k, v);
    }
    body = params;
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`twilio ${method} ${path} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "GET") return new Response("ok", { status: 200 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const url = new URL(req.url);
    if (!WEBHOOK_KEY || url.searchParams.get("key") !== WEBHOOK_KEY) {
      console.warn("[auth] rejected request — bad/missing key");
      return new Response("forbidden", { status: 403 });
    }

    const form = await req.formData();
    const body: Record<string, string> = {};
    for (const [k, v] of form.entries()) body[k] = String(v);

    const event = body.StatusCallbackEvent;
    const roomSid = body.RoomSid || "";
    const roomName = body.RoomName || "";
    const compositionSid = body.CompositionSid || "";

    console.log(
      `[event] ${event} roomSid=${roomSid || "-"} roomName=${roomName || "-"} compositionSid=${compositionSid || "-"}`,
    );

    if (event === "room-ended") {
      await handleRoomEnded(roomSid, roomName);
    } else if (event === "composition-available") {
      await handleCompositionAvailable(compositionSid);
    } else {
      console.log(`[event] ignoring ${event}`);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[handler] error:", err instanceof Error ? err.stack || err.message : err);
    return new Response("error", { status: 500 });
  }
});

async function handleRoomEnded(roomSid: string, roomName: string) {
  if (!roomSid) {
    console.warn("[room-ended] missing RoomSid");
    return;
  }

  // Primary lookup: by stored twilio_room_sid
  let { data: call, error: e1 } = await supabase
    .from("calls")
    .select("id, recording_subscriber_id, call_type, recording_enabled")
    .eq("twilio_room_sid", roomSid)
    .maybeSingle();
  if (e1) console.error("[room-ended] lookup-by-sid error:", e1.message);

  // Fallback: parse callId from the room's uniqueName (we always create rooms as `call-<uuid>`)
  if (!call && roomName.startsWith("call-")) {
    const callId = roomName.slice("call-".length);
    const { data, error } = await supabase
      .from("calls")
      .select("id, recording_subscriber_id, call_type, recording_enabled")
      .eq("id", callId)
      .maybeSingle();
    if (error) console.error("[room-ended] lookup-by-id error:", error.message);
    call = data || null;
  }

  if (!call) {
    console.warn(`[room-ended] no call row for roomSid=${roomSid} roomName=${roomName}`);
    return;
  }
  if (!call.recording_subscriber_id) {
    console.log(`[room-ended] callId=${call.id} has no subscriber, skipping composition`);
    return;
  }

  const format = call.call_type === "video" ? "mp4" : "mp3";
  console.log(`[room-ended] creating composition callId=${call.id} format=${format}`);

  let composition: any;
  try {
    const params: Record<string, string | string[]> = {
      RoomSid: roomSid,
      AudioSources: "*",
      Format: format,
      StatusCallback: SELF_URL,
      StatusCallbackMethod: "POST",
    };
    if (call.call_type === "video") {
      params.VideoLayout = JSON.stringify({ grid: { video_sources: ["*"] } });
    }
    composition = await twilio("/v1/Compositions", "POST", params);
    console.log(`[room-ended] composition sid=${composition.sid} status=${composition.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[room-ended] composition create failed:", msg);
    await supabase.from("call_recordings").insert({
      call_id: call.id,
      subscriber_user_id: call.recording_subscriber_id,
      twilio_composition_sid: null,
      storage_path: "",
      media_format: format,
      call_type: call.call_type,
      status: "failed",
    });
    return;
  }

  const { error: insErr } = await supabase.from("call_recordings").insert({
    call_id: call.id,
    subscriber_user_id: call.recording_subscriber_id,
    twilio_composition_sid: composition.sid,
    storage_path: "",
    media_format: format,
    call_type: call.call_type,
    status: "processing",
  });
  if (insErr) console.error("[room-ended] insert call_recordings error:", insErr.message);
  else console.log(`[room-ended] inserted processing row for composition=${composition.sid}`);
}

async function handleCompositionAvailable(compositionSid: string) {
  if (!compositionSid) {
    console.warn("[composition-available] missing CompositionSid");
    return;
  }

  const { data: rec, error: lookupErr } = await supabase
    .from("call_recordings")
    .select("id, subscriber_user_id, call_id, media_format")
    .eq("twilio_composition_sid", compositionSid)
    .maybeSingle();
  if (lookupErr) console.error("[composition-available] recording lookup error:", lookupErr.message);
  if (!rec) {
    console.warn(`[composition-available] no call_recordings row for composition=${compositionSid}`);
    return;
  }

  let composition: any;
  try {
    composition = await twilio(`/v1/Compositions/${compositionSid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[composition-available] composition fetch failed:", msg);
    await supabase.from("call_recordings").update({ status: "failed" }).eq("id", rec.id);
    return;
  }

  const mediaUrl = `https://video.twilio.com${composition.url}/Media`;
  const mediaResp = await fetch(mediaUrl, {
    headers: { Authorization: TWILIO_BASIC_AUTH },
    redirect: "follow",
  });
  if (!mediaResp.ok) {
    console.error(`[composition-available] media download failed: ${mediaResp.status} ${mediaResp.statusText}`);
    await supabase.from("call_recordings").update({ status: "failed" }).eq("id", rec.id);
    return;
  }
  const arrayBuffer = await mediaResp.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);
  console.log(`[composition-available] downloaded bytes=${buffer.length}`);

  const ext = rec.media_format;
  const storagePath = `${rec.subscriber_user_id}/${rec.call_id}.${ext}`;
  const { error: uploadErr } = await supabase.storage
    .from("recordings")
    .upload(storagePath, buffer, {
      contentType: ext === "mp4" ? "video/mp4" : "audio/mpeg",
      upsert: true,
    });
  if (uploadErr) {
    console.error("[composition-available] storage upload failed:", uploadErr.message);
    await supabase.from("call_recordings").update({ status: "failed" }).eq("id", rec.id);
    return;
  }
  console.log(`[composition-available] uploaded to storage path=${storagePath}`);

  const { error: updErr } = await supabase
    .from("call_recordings")
    .update({
      storage_path: storagePath,
      size_bytes: buffer.length,
      duration_seconds: composition.duration ?? null,
      status: "ready",
    })
    .eq("id", rec.id);
  if (updErr) console.error("[composition-available] update call_recordings error:", updErr.message);

  // Best-effort: free the composition on Twilio's side (we already have the bytes)
  try {
    await twilio(`/v1/Compositions/${compositionSid}`, "DELETE");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[composition-available] delete composition failed:", msg);
  }
}
