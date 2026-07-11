import {
  CampaignCheckError,
  createCampaignCheckClients,
  runCampaignCheck,
  validateCheckInput,
} from "../../../src/server/campaign-check.js";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const NO_STORE = "no-store, max-age=0";

export const runtime = "nodejs";

function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      Pragma: "no-cache",
    },
  });
}

function inputError(message, code, status = 400) {
  throw new CampaignCheckError(message, { code, status });
}

function isUploadedFile(value) {
  return value && typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number" &&
    typeof value.type === "string";
}

export async function parseCheckFormData(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    inputError("Use multipart form data for this check.", "MULTIPART_REQUIRED", 415);
  }

  let formData;
  try {
    formData = await request.formData();
  } catch {
    inputError("The submitted form data is invalid.", "INVALID_FORM_DATA");
  }

  const imageValues = formData.getAll("image").filter((value) => isUploadedFile(value));
  if (imageValues.length > 1) {
    inputError("Upload one screenshot or QR image at a time.", "TOO_MANY_IMAGES");
  }
  const uploaded = imageValues[0] || null;
  if (uploaded && !ALLOWED_IMAGE_TYPES.has(uploaded.type.toLowerCase())) {
    inputError("Use a PNG, JPEG, WebP, or GIF image.", "UNSUPPORTED_IMAGE_TYPE", 415);
  }
  if (uploaded?.size === 0) {
    inputError("The uploaded image is empty.", "EMPTY_IMAGE");
  }
  if (uploaded?.size > MAX_IMAGE_BYTES) {
    inputError("The image must be 8 MB or smaller.", "IMAGE_TOO_LARGE", 413);
  }
  const image = uploaded
    ? {
        bytes: new Uint8Array(await uploaded.arrayBuffer()),
        mimeType: uploaded.type.toLowerCase(),
        name: String(uploaded.name || "evidence-image").slice(0, 180),
      }
    : null;
  return validateCheckInput({
    text: formData.get("text"),
    url: formData.get("url"),
    image,
  });
}

export async function handleCheckRequest(request, {
  createClients = createCampaignCheckClients,
  runCheck = runCampaignCheck,
} = {}) {
  try {
    const input = await parseCheckFormData(request);
    const clients = createClients({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
    });
    const result = await runCheck({
      input,
      ...clients,
      model: process.env.OPENAI_MODEL || "gpt-5.6-luna",
    });
    return json(result);
  } catch (error) {
    const status = error instanceof CampaignCheckError ? error.status : 502;
    const code = error instanceof CampaignCheckError ? error.code : "CHECK_UNAVAILABLE";
    const message = error instanceof CampaignCheckError
      ? error.message
      : "The evidence check is temporarily unavailable.";
    console.error("[campaign-check] Request failed", {
      code,
      name: error instanceof Error ? error.name : "UnknownError",
      status,
    });
    return json({ status: "error", error: { code, message } }, status);
  }
}

export async function POST(request) {
  return handleCheckRequest(request);
}
