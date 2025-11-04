import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `Du är en svensk juridisk AI-assistent för Juridiko. Ge tydliga och professionella svar. Du ersätter inte en advokat. Hjälp användare med juridiska frågor enligt svensk lag. Skriv kortfattat; vid längre behov hänvisa till Juridiko Pro.`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: headersCORS });
}

/**
 * GET
 * - query: userId
 * - returns: { conversations: [{id, title, created_at}], conversationId, history: [] }
 */
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return new Response(JSON.stringify({ error: "userId krävs", history: [], conversations: [] }), {
        status: 400,
        headers: headersCORS,
      });
    }

    // Hämta konversationer för användaren (nyaste först)
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, title, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (convErr) throw convErr;

    const conversations = convs || [];

    // Välj senaste konversation om den finns
    let conversationId = conversations?.[0]?.id || null;
    let history = [];

    if (conversationId) {
      const { data: msgs, error: msgErr } = await supabase
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: true });
      if (msgErr) throw msgErr;
      history = msgs || [];
    }

    return new Response(
      JSON.stringify({
        conversations,
        conversationId,
        history: Array.isArray(history) ? history : [],
      }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    console.error("GET /api/chat error:", err);
    return new Response(
      JSON.stringify({ error: err.message, history: [], conversations: [] }),
      { status: 500, headers: headersCORS }
    );
  }
}

/**
 * POST
 * - body { userId, message?, conversationId?, action? }
 * - action === "create" -> skapar ny konversation för userId och returnerar id + tom history
 * - annars -> behandlar som vanligt message, skickar till OpenAI, sparar respons och returnerar full history
 */
export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: convId, action } = body;

    if (!userId) {
      return new Response(JSON.stringify({ error: "userId krävs", history: [] }), {
        status: 400,
        headers: headersCORS,
      });
    }

    // ACTION: skapa ny konversation (frontend ska använda detta för konsekvent server-state)
    if (action === "create") {
      const { data: created, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id, title, created_at")
        .single();
      if (error) throw error;

      return new Response(
        JSON.stringify({
          conversationId: created.id,
          conversations: [{ id: created.id, title: created.title || "Ny chatt", created_at: created.created_at }],
          history: [],
        }),
        { status: 201, headers: headersCORS }
      );
    }

    // För vanliga meddelanden, krävs message
    if (!message?.trim()) {
      return new Response(JSON.stringify({ error: "message krävs", history: [] }), {
        status: 400,
        headers: headersCORS,
      });
    }

    // Bestäm conversation (hämta eller använd convId)
    let conversationId = convId;
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
    const { error: insertUserErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });
    if (insertUserErr) throw insertUserErr;

    // Hämta kontext (senaste 30)
    const { data: ctx } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    // Skicka till OpenAI
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...(Array.isArray(ctx) ? ctx.map((m) => ({ role: m.role, content: m.content })) : []),
      ],
    });

    const reply = completion.choices?.[0]?.message?.content || "Inget svar.";

    // Spara assistant-svaret
    const { error: insertAssistantErr } = await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });
    if (insertAssistantErr) throw insertAssistantErr;

    // Returnera full historik
    const { data: full } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    // Hämta uppdaterad lista av konversationer (valfritt men praktiskt)
    const { data: convsAll } = await supabase
      .from("conversations")
      .select("id, title, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    return new Response(
      JSON.stringify({
        conversationId,
        reply,
        history: Array.isArray(full) ? full : [],
        conversations: convsAll || [],
      }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    console.error("POST /api/chat error:", err);
    return new Response(
      JSON.stringify({ error: err.message, history: [] }),
      { status: 500, headers: headersCORS }
    );
  }
}
