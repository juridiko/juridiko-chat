export async function GET(req) {
    const { searchParams } = new URL(req.url)
    const userId = searchParams.get("userId")
    // Hämta från Supabase
    const { data } = await supabase.from("conversations").select("id, title").eq("user_id", userId)
    return Response.json({ conversations: data || [] })
}

export async function POST(req) {
    const { userId } = await req.json()
    const { data } = await supabase.from("conversations").insert({ user_id: userId }).select().single()
    return Response.json({ conversationId: data.id })
}
