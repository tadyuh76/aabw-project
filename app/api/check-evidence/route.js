import {
  CheckEvidenceError,
  checkEvidence,
} from "../../../src/server/check-evidence.js";

const NO_STORE = "no-store, max-age=0";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      Pragma: "no-cache",
    },
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ status: "invalid" }, 400);
  }

  try {
    const result = await checkEvidence({
      value: body?.value ?? body?.input ?? body?.query,
      type: body?.type ?? body?.kind,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
    return json(result);
  } catch (error) {
    const status = error instanceof CheckEvidenceError ? error.status : 502;
    console.error("[check-evidence] Check unavailable", {
      name: error instanceof Error ? error.name : "UnknownError",
      status,
    });
    if (status === 400) return json({ status: "invalid" }, 400);
    if (status === 503) return json({ status: "unavailable" }, 503);
    return json({ status: "error" }, 502);
  }
}

