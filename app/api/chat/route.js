// app/api/chat/route.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const headersCORS = {
  "Access-Control-Allow-Origin": "*", // ev. byt till din domän senare
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `
Du är en svensk juridisk AI-assistent för Juridiko. 
Ge tydliga, pedagogiska svar och vägledning.
Du ersätter inte en advokat och ger ingen juridisk garanti. 
Uppmana alltid att kontakta en kvalificerad jurist vid behov.
`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: headersCORS });
}

// Hämta historik eller skapa en konversation
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId krävs" }), {
        status: 400,
        headers: headersCORS,
      });
    }

    // Hämta senaste konversationen
    let { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    if (convErr) throw convErr;

    let conversationId = convs?.[0]?.id;

    // Om ingen finns → skapa en ny
    if (!conversationId) {
      const { data: created, error: createErr } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (createErr) throw createErr;
      conversationId = created.id;
    }

    // Hämta historiken
    const { data: msgs, error: msgErr } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (msgErr) throw msgErr;

    return new Response(
      JSON.stringify({ conversationId, history: msgs || [] }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    console.error("GET /api/chat error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", details: err.message }),
      { status: 500, headers: headersCORS }
    );
  }
}

// Skicka meddelande + få svar
export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: incomingConvId } = body || {};

    if (!userId || !message) {
      return new Response(
        JSON.stringify({ error: "userId och message krävs" }),
        { status: 400, headers: headersCORS }
      );
    }

    // Hämta eller skapa konversation
    let conversationId = incomingConvId;
    if (!conversationId) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);

      conversationId = convs?.[0]?.id;
      if (!conversationId) {
        const { data: created, error: createErr } = await supabase
          .from("conversations")
          .insert({ user_id: userId })
          .select("id")
          .single();
        if (createErr) throw createErr;
        conversationId = created.id;
      }
    }

    // Spara användarens meddelande
    const { error: insUserErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });
    if (insUserErr) throw insUserErr;

    // Hämta senaste 30 meddelanden för kontext
    const { data: ctxMsgs, error: ctxErr } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);
    if (ctxErr) throw ctxErr;

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...ctxMsgs.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: message },
      ],
    });

    const reply =
      completion.choices?.[0]?.message?.content || "Inget svar från AI:n";

    // Spara AI-svaret
    const { error: insAiErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });
    if (insAiErr) throw insAiErr;

    // Returnera hela historiken
    const { data: full, error: fullErr } = await supabase
      .from("messages")
      .select("role, content, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (fullErr) throw fullErr;

    return new Response(
      JSON.stringify({ conversationId, reply, history: full || [] }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    console.error("POST /api/chat error:", err);
    return new Response(
      JSON.stringify({ error: "Server error", details: err.message }),
      { status: 500, headers: headersCORS }
    );
  }
}
