import {
  BankIntelligenceError,
  loadBankCampaignDetail,
} from "../../../../src/server/bank-intelligence.js";

function json(body, { status = 200 } = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": status === 200 ? "private, max-age=10" : "no-store" },
  });
}

export async function GET(_request, { params }) {
  try {
    const { campaignId } = await params;
    const detail = await loadBankCampaignDetail({
      campaignId,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return json({ status: "live", ...detail });
  } catch (error) {
    const status = error instanceof BankIntelligenceError ? error.status : 502;
    console.error("[bank-intelligence] Campaign detail unavailable", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return json({ status: status === 404 ? "not_found" : "unavailable" }, { status });
  }
}
