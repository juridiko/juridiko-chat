export async function PATCH(req, { params }) {
    const { title } = await req.json()
    await supabase.from("conversations").update({ title }).eq("id", params.id)
    return Response.json({ success: true })
}
