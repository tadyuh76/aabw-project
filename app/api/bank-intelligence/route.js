import {
  BankIntelligenceError,
  loadBankIntelligence,
} from "../../../src/server/bank-intelligence.js";

const SUCCESS_CACHE = "public, s-maxage=20, stale-while-revalidate=40";

function json(body, { status = 200, cacheControl = SUCCESS_CACHE } = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": cacheControl },
  });
}

export async function GET() {
  try {
    const intelligence = await loadBankIntelligence({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return json({ status: "live", ...intelligence });
  } catch (error) {
    const status = error instanceof BankIntelligenceError ? error.status : 502;
    console.error("[bank-intelligence] Snapshot unavailable", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json(
      { status: "unavailable" },
      { status, cacheControl: "no-store" },
    );
  }
}
