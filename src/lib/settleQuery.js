// Supabase reads normally resolve with { data, error }. Keep the same error
// path when the transport rejects instead (for example, while going offline).
export async function settleQuery(query) {
  try {
    return await query;
  } catch (error) {
    return { data: null, error };
  }
}
