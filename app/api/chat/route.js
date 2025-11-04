// route.js
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `Du är en svensk juridisk AI-assistent för Juridiko. Ge tydliga och professionella svar. Du ersätter inte en advokat. Hjälp användare med juridiska frågor enligt svensk lag. Du sparar ingen personlig information och följer GDPR. Skriv kortfattat; vid längre behov hänvisa till Juridiko Pro.`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: headersCORS });
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const list = searchParams.get("list");
    const conversationIdParam = searchParams.get("conversationId");

    // 1) Lista konversationer för userId
    if (list && userId) {
      const { data: convs, error } = await supabase
        .from("conversations")
        .select("id, title, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return new Response(JSON.stringify({ conversations: convs || [] }), { status: 200, headers: headersCORS });
    }

    // 2) Hämta specifik conversationId (om skickad)
    if (conversationIdParam) {
      const conversationId = conversationIdParam;
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });

      if (msgErr) throw msgErr;
      return new Response(JSON.stringify({ conversationId, history: msgs || [] }), { status: 200, headers: headersCORS });
    }

    // 3) Om ingen conversationId, men userId finns → hämta senaste eller skapa en
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId krävs" }), { status: 400, headers: headersCORS });
    }

    const { data: convs } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    let conversationId = convs?.[0]?.id;

    if (!conversationId) {
      const { data: created, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = created.id;
    }

    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(JSON.stringify({ conversationId, history: msgs || [] }), { status: 200, headers: headersCORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, history: [] }), { status: 500, headers: headersCORS });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: convId } = body;
    if (!userId || !message?.trim()) {
      return new Response(JSON.stringify({ error: "userId och message krävs" }), { status: 400, headers: headersCORS });
    }

    let conversationId = convId;

    // Hämta eller skapa konversation
    if (!conversationId) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);
      conversationId = convs?.[0]?.id;

      if (!conversationId) {
        const { data: created, error } = await supabase
          .from("conversations")
          .insert({ user_id: userId })
          .select("id")
          .single();
        if (error) throw error;
        conversationId = created.id;
      }
    }

    // Spara användarens meddelande
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });

    // Hämta kontext (senaste 30)
    const { data: ctx } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(ctx || []).map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const reply = completion.choices?.[0]?.message?.content || "Inget svar.";

    // Spara svaret
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });

    // Returnera full historik
    const { data: full } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(JSON.stringify({ conversationId, reply, history: full || [] }), { status: 200, headers: headersCORS });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, history: [] }), { status: 500, headers: headersCORS });
  }
}
