import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const headersCORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Content-Type": "application/json",
};

const SYSTEM_PROMPT = `Du är en svensk juridisk AI assistent för Juridiko. Ge tydliga svar och var professionell. Du ersätter inte en advokat. Hjälp användare med deras juridiska frågor och problem. Kommunicera inte utanför din roll. Du följer svenska lagar, sparar ingen information och följer GDPR. Skriv inte för utförliga svar, även om det begärs; användaren kan uppgradera till Juridiko Pro för mer detaljer.`;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------------------------------------------------------
//  OPTIONS (CORS)
// ---------------------------------------------------------
export async function OPTIONS() {
  return new Response(null, { status: 200, headers: headersCORS });
}

// ---------------------------------------------------------
//  GET – BARA FÖR PRO (gratisversionen ska aldrig anropa GET)
// ---------------------------------------------------------
export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    const convId = searchParams.get("conversationId");

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId krävs för Pro-historik" }),
        { status: 400, headers: headersCORS }
      );
    }

    let conversationId = convId;

    if (!conversationId) {
      const { data: convs } = await supabase
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (convs?.[0]?.id) {
        conversationId = convs[0].id;
      } else {
        const { data: created, error } = await supabase
          .from("conversations")
          .insert({ user_id: userId })
          .select("id")
          .single();
        if (error) throw error;
        conversationId = created.id;
      }
    }

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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: headersCORS,
    });
  }
}

// ---------------------------------------------------------
//  POST – HUVUDLOGIK
// ---------------------------------------------------------
export async function POST(req) {
  try {
    const body = await req.json();
    const { userId, message, conversationId: convId } = body;

    if (!message?.trim()) {
      return new Response(
        JSON.stringify({ error: "Meddelande krävs" }),
        { status: 400, headers: headersCORS }
      );
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // -----------------------------------------------------
    // 1. GRATISLÄGE – ingen userId => ingen lagring => no supabase
    // -----------------------------------------------------
    if (!userId) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
      });

      const reply =
        completion.choices?.[0]?.message?.content || "Inget svar.";

      return new Response(
        JSON.stringify({
          conversationId: "local_free",
          reply,
          history: [
            { role: "user", content: message },
            { role: "assistant", content: reply },
          ],
        }),
        { status: 200, headers: headersCORS }
      );
    }

    // -----------------------------------------------------
    // 2. PRO ANVÄNDARE – spara allt i Supabase
    // -----------------------------------------------------
    let conversationId = convId;

    if (!conversationId || conversationId.startsWith("local_")) {
      const { data: created, error } = await supabase
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error) throw error;
      conversationId = created.id;
    }

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "user",
      content: message,
    });

    const { data: ctx } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(30);

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...ctx.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    const reply =
      completion.choices?.[0]?.message?.content || "Inget svar.";

    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
    });

    const { data: full } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    return new Response(
      JSON.stringify({ conversationId, reply, history: full || [] }),
      { status: 200, headers: headersCORS }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: headersCORS,
    });
  }
}
