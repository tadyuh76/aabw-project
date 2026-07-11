import jsQR from "jsqr";
import sharp from "sharp";

const MAX_INPUT_PIXELS = 40_000_000;
const MAX_DECODE_DIMENSION = 3_000;
const MAX_QR_PAYLOAD_LENGTH = 4_096;

function cleanPayload(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").trim();
  return cleaned.slice(0, MAX_QR_PAYLOAD_LENGTH);
}

function parseTlv(value) {
  if (typeof value !== "string" || value.length < 4) return null;
  const fields = [];
  let offset = 0;
  while (offset < value.length) {
    const tag = value.slice(offset, offset + 2);
    const lengthText = value.slice(offset + 2, offset + 4);
    if (!/^\d{2}$/u.test(tag) || !/^\d{2}$/u.test(lengthText)) return null;
    const length = Number(lengthText);
    const start = offset + 4;
    const end = start + length;
    if (end > value.length) return null;
    fields.push({ tag, value: value.slice(start, end) });
    offset = end;
  }
  return offset === value.length ? fields : null;
}

function crc16CcittFalse(value) {
  let crc = 0xffff;
  for (const byte of Buffer.from(value, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function fieldValue(fields, tag) {
  return fields?.find((field) => field.tag === tag)?.value || "";
}

export function parseEmvQrPayload(value) {
  const payload = cleanPayload(value);
  const fields = parseTlv(payload);
  if (!fields || fieldValue(fields, "00") !== "01") return null;

  const crcField = fields.at(-1);
  const crcValid =
    crcField?.tag === "63" &&
    /^[A-F0-9]{4}$/iu.test(crcField.value) &&
    crc16CcittFalse(payload.slice(0, -4)) === crcField.value.toUpperCase();
  const merchantAccount = parseTlv(fieldValue(fields, "38"));
  const beneficiary = parseTlv(fieldValue(merchantAccount, "01"));
  const additionalData = parseTlv(fieldValue(fields, "62"));

  return {
    crcValid,
    payloadFormat: fieldValue(fields, "00"),
    initiationMethod: fieldValue(fields, "01"),
    globallyUniqueIdentifier: fieldValue(merchantAccount, "00"),
    bankBin: fieldValue(beneficiary, "00"),
    beneficiaryIdentifier: fieldValue(beneficiary, "01"),
    serviceCode: fieldValue(merchantAccount, "02"),
    currency: fieldValue(fields, "53"),
    country: fieldValue(fields, "58"),
    references: (additionalData || [])
      .filter((field) => ["05", "08", "09"].includes(field.tag))
      .map((field) => field.value)
      .filter(Boolean),
  };
}

export async function decodeQrImage(image) {
  if (!image?.bytes?.length) return "";
  try {
    let pipeline = sharp(Buffer.from(image.bytes), {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_INPUT_PIXELS,
      pages: 1,
    }).rotate();
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height) return "";
    if (Math.max(metadata.width, metadata.height) > MAX_DECODE_DIMENSION) {
      pipeline = pipeline.resize({
        width: MAX_DECODE_DIMENSION,
        height: MAX_DECODE_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const { data, info } = await pipeline
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4 || !info.width || !info.height) return "";
    const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const decoded = jsQR(pixels, info.width, info.height, {
      inversionAttempts: "attemptBoth",
    });
    return cleanPayload(decoded?.data);
  } catch {
    return "";
  }
}
