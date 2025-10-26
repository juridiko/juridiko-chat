import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// CORS – tillåt Framer
const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Content-Type": "application/json",
};

// System Prompt
const SYSTEM_PROMPT = `Du är en svensk juridisk AI-assistent för Juridiko. 
Ge tydliga, pedagogiska svar. 
Du ersätter inte en advokat`;

// Supabase – nycklar sätts i Vercel (inte här!)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// OPTIONS för CORS
export async function OPTIONS() {
  return new Response(null, { status: 200, headers: headersCORS });
}

// GET: Hämta historik
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

    // Hämta senaste konversation
    const { data: convs } = await supabase
      .from("conversations")
      .select("id")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(1);

    let conversationId = convs?.[0]?.id;

    // Skapa ny om ingen finns
    if (!conversationId) {
      const { data: created } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      conversationId = created.id;
    }

    // Hämta meddelanden
    const { data: msgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(
      JSON.stringify({ conversationId, history: msgs || [] }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Serverfel", details: err.message }),
      { status: 500, headers: headersCORS }
    );
  }
}

// POST: Skicka meddelande + få svar
export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: incomingConvId } = body;

    if (!userId || !message?.trim()) {
      return new Response(JSON.stringify({ error: "userId och message krävs" }), {
        status: 400,
        headers: headersCORS,
      });
    }

    let conversationId = incomingConvId;

    // Skapa konversation om ingen finns
    if (!conversationId) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);

      conversationId = convs?.[0]?.id;

      if (!conversationId) {
        const { data: created } = await supabase
          .from("conversations")
          .insert({ user_id: userId })
          .select("id")
          .single();
        conversationId = created.id;
      }
    }

    // Spara användarmeddelande
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });

    // Hämta kontext
    const { data: ctxMsgs } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    // OpenAI
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...ctxMsgs.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const reply = completion.choices?.[0]?.message?.content || "Inget svar.";

    // Spara AI-svar
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

    return new Response(
      JSON.stringify({
        conversationId,
        reply,
        history: full || [],
      }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Serverfel", details: err.message }),
      { status: 500, headers: headersCORS }
    );
  }
}
