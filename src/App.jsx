"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Strands from "./Strands.jsx";
import { campaignCheckResultFromResponse } from "./campaignCheckResult.js";
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowUpRight,
  Moon,
  PhoneCall,
  Plus,
  Quotes,
  ShieldCheck,
  Sun,
  WarningCircle,
  X,
} from "@phosphor-icons/react";

const CASES = [
  {
    id: "vneid-loop",
    label: "Telegram message",
    artifact: "telegram_support_4821.png",
    campaign: "VNeID SUPPORT LOOP",
    campaignId: "CP-2407-19A",
    match: "VERY HIGH",
    confidence: 96,
    reportCount: 47,
    victimCount: 12,
    reportedLoss: "₫186M",
    firstSeen: "18 JUL 2026",
    headline: "Same campaign. New identity.",
    subline: "The phone number changed. The script and infrastructure did not.",
    inputs: [
      ["IMAGE", "telegram_support_4821.png"],
      ["TEXT", "OCR · 6 entities extracted"],
    ],
    evidence: [
      ["OCR PHRASE", "“verify before 11 PM”", "seen in 41 prior reports", "IMAGE", "98%"],
      ["DESTINATION", "vneid-ho-tro[.]live → APK", "17 reports · domain rotated", "IMAGE", "96%"],
      ["PAYEE", "MB •••• 8086", "linked to 6 confirmed cases", "IMAGE", "91%"],
      ["MESSAGE INTENT", "Urgent identity verification", "same script family", "TEXT", "94%"],
    ],
    sources: [
      ["Facebook", "VNeID support warning: fake verification deadline", "2h ago"],
      ["Telegram", "New number, identical APK installation script", "5h ago"],
      ["Reddit", "MB •••• 8086 reported in account takeover attempt", "Yesterday"],
    ],
    victims: [
      ["Customer 08", "₫24.8M", "Installed a fake VNeID support APK", "18 Jul · Ho Chi Minh City"],
      ["Customer 31", "₫8.5M", "Transferred to MB •••• 8086", "17 Jul · Da Nang"],
      ["Customer 44", "BLOCKED", "Stopped after seeing the same 11 PM script", "Today · Hanoi"],
    ],
  },
  {
    id: "refund-relay",
    label: "Refund QR",
    artifact: "refund_qr_1907.png",
    campaign: "REFUND RELAY",
    campaignId: "CP-2407-08C",
    match: "VERY HIGH",
    confidence: 94,
    reportCount: 29,
    victimCount: 9,
    reportedLoss: "₫74M",
    firstSeen: "19 JUL 2026",
    headline: "New QR. Same money trail.",
    subline: "This QR routes to an intermediary account seen in 9 reports.",
    inputs: [
      ["QR", "refund_qr_1907.png"],
      ["TEXT", "“refund fee in 5 minutes”"],
    ],
    evidence: [
      ["QR PAYLOAD", "vietqr.io/9704/•••921", "decoded successfully", "QR", "100%"],
      ["PAYEE", "VCB •••• 0921", "seen in 9 victim reports", "QR", "97%"],
      ["MONEY FLOW", "3 intermediary accounts", "same final beneficiary", "QR", "93%"],
      ["SCRIPT", "“refund fee in 5 minutes”", "94% phrase similarity", "TEXT", "94%"],
    ],
    sources: [
      ["Facebook", "Refund QR redirects to intermediary account", "1h ago"],
      ["TikTok", "Same five-minute refund script reported again", "4h ago"],
      ["Telegram", "Beneficiary cluster linked to nine complaints", "Yesterday"],
    ],
    victims: [
      ["Customer 12", "₫6.2M", "Paid a fee to unlock the promised refund", "19 Jul · Hanoi"],
      ["Customer 27", "₫11M", "Scanned a QR linked to the intermediary", "18 Jul · Can Tho"],
      ["Customer 39", "BLOCKED", "Bank warning stopped the QR payment", "Today · Ho Chi Minh City"],
    ],
  },
  {
    id: "remote-task",
    label: "Job offer URL",
    artifact: "vieclam-linhhoat[.]site",
    campaign: "REMOTE TASK FARM",
    campaignId: "CP-2406-31F",
    match: "HIGH",
    confidence: 89,
    reportCount: 18,
    victimCount: 7,
    reportedLoss: "₫93M",
    firstSeen: "03 JUL 2026",
    headline: "New domain. Same task scam.",
    subline: "The site reuses the same copy, tracking code, and payee cluster.",
    inputs: [
      ["URL", "vieclam-linhhoat[.]site"],
      ["TEXT", "Job offer message"],
    ],
    evidence: [
      ["DOMAIN AGE", "registered 11 hours ago", "owner identity hidden", "URL", "96%"],
      ["REDIRECT", "2-hop payment redirect", "destination previously blocked", "URL", "92%"],
      ["CONTENT", "“deposit to unlock tasks”", "29 known variants", "TEXT", "95%"],
      ["TRACKING", "Meta Pixel •••8472", "reused across 8 domains", "URL", "89%"],
    ],
    sources: [
      ["Reddit", "Task site asks for deposit before withdrawal", "3h ago"],
      ["Facebook", "Eight domains reuse the same job offer copy", "8h ago"],
      ["TikTok", "Victim report: payment requested to unlock tasks", "2 days ago"],
    ],
    victims: [
      ["Customer 05", "₫15M", "Deposited money to unlock online tasks", "03 Jul · Hanoi"],
      ["Customer 16", "₫32M", "Paid three escalating task deposits", "02 Jul · Hai Phong"],
      ["Customer 22", "BLOCKED", "Recognized the reused job-offer copy", "Today · Da Nang"],
    ],
  },
  {
    id: "mixed-evidence",
    label: "Mixed evidence",
    artifact: "3-item evidence bundle",
    campaign: "VNeID SUPPORT LOOP",
    campaignId: "CP-2407-19A",
    match: "VERY HIGH",
    confidence: 99,
    reportCount: 52,
    victimCount: 14,
    reportedLoss: "₫214M",
    firstSeen: "18 JUL 2026",
    headline: "Three inputs. One campaign.",
    subline: "The screenshot, QR payee, and pasted message independently match the same active campaign.",
    inputs: [
      ["IMAGE", "zalo_support_chat.png"],
      ["QR", "payment_request_qr.png"],
      ["TEXT", "Pasted verification message"],
    ],
    evidence: [
      ["OCR PHRASE", "“verify before 11 PM”", "41 prior campaign matches", "IMAGE", "98%"],
      ["VISUAL ENTITY", "VNeID support impersonation", "logo and layout mismatch", "IMAGE", "92%"],
      ["QR PAYEE", "MB •••• 8086", "linked to 6 confirmed cases", "QR", "99%"],
      ["QR AMOUNT", "₫4,980,000", "matches campaign deposit pattern", "QR", "90%"],
      ["SCRIPT", "Install APK to verify identity", "same intent across 34 variants", "TEXT", "96%"],
    ],
    sources: [
      ["Facebook", "Fake VNeID support chats now include payment QR codes", "1h ago"],
      ["Telegram", "MB •••• 8086 reused with a new support number", "3h ago"],
      ["Reddit", "Screenshot and APK script match earlier takeover reports", "Yesterday"],
    ],
    victims: [
      ["Customer 08", "₫24.8M", "Installed the APK shown in the same chat layout", "18 Jul · Ho Chi Minh City"],
      ["Customer 31", "₫8.5M", "Paid the same QR beneficiary", "17 Jul · Da Nang"],
      ["Customer 49", "BLOCKED", "Combined evidence triggered a bank warning", "Today · Hanoi"],
    ],
  },
  {
    id: "known-recipient",
    label: "Known recipient",
    artifact: "Shinhan · 110-482-902184",
    verdict: "clear",
    campaign: "NO KNOWN CAMPAIGN",
    campaignId: "CLEAR-2507-A3",
    match: "NO KNOWN MATCH",
    confidence: 93,
    reportCount: 0,
    victimCount: 0,
    reportedLoss: "₫0",
    firstSeen: "2.4 YEARS",
    headline: "No known campaign match.",
    subline: "No cases recorded for this account across bank intelligence and anonymized customer reports.",
    inputs: [
      ["ACCOUNT", "Shinhan · 110-482-902184"],
      ["TEXT", "Personal transfer note"],
    ],
    evidence: [
      ["ACCOUNT HISTORY", "Active for 2.4 years", "stable beneficiary history", "ACCOUNT", "96%"],
      ["CASE SEARCH", "0 linked scam cases", "bank + community report search", "ACCOUNT", "99%"],
      ["NAME CHECK", "NGUYEN MINH ANH", "matches the recipient profile", "TEXT", "92%"],
      ["MESSAGE INTENT", "Personal transfer", "no urgency, install, or fee signals", "TEXT", "89%"],
    ],
    sources: [],
    victims: [],
  },
];

const SCAN_STEPS = ["Extract signals", "Match campaigns", "Verify evidence"];
const SCAN_DETAILS = [
  "Reading text, links, payees, and visual markers",
  "Comparing patterns with active scam intelligence",
  "Cross-checking sources before the verdict",
];
const SCAN_PROGRESS = [32, 68, 94];
const LIVE_SCAN_MINIMUM_MS = 1400;

function conciseArtifact(value, maximum = 86) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
}

export function App() {
  const [theme, setTheme] = useState("light");
  const [phase, setPhase] = useState("idle");
  const [selected, setSelected] = useState(CASES[0]);
  const [scanStep, setScanStep] = useState(0);
  const [query, setQuery] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [evidenceFilter, setEvidenceFilter] = useState("ALL");
  const [isDragging, setIsDragging] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const [fileError, setFileError] = useState("");
  const [scanMode, setScanMode] = useState("demo");
  const reduceMotion = useReducedMotion();
  const fileRef = useRef(null);
  const attachmentsRef = useRef([]);
  const checkRequestRef = useRef(null);
  const resultRef = useRef(null);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.preview));
    checkRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (phase !== "scanning") return;
    const stepOne = window.setTimeout(() => setScanStep(1), 450);
    const stepTwo = window.setTimeout(() => setScanStep(2), 950);
    const complete = scanMode === "demo"
      ? window.setTimeout(() => setPhase("result"), 1700)
      : null;
    return () => [stepOne, stepTwo, complete].filter(Boolean).forEach(window.clearTimeout);
  }, [phase, scanMode]);

  useEffect(() => {
    if (phase !== "result") return;
    const focusResult = window.requestAnimationFrame(() => resultRef.current?.focus());
    return () => window.cancelAnimationFrame(focusResult);
  }, [phase]);

  useEffect(() => {
    if (phase !== "idle") return;

    function pasteAnywhere(event) {
      const files = event.clipboardData?.files;
      if (files?.length) {
        event.preventDefault();
        handleFiles(files);
        return;
      }
      if (document.activeElement?.tagName === "INPUT") return;
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (text) void runTextEvidence(text);
    }

    window.addEventListener("paste", pasteAnywhere);
    return () => window.removeEventListener("paste", pasteAnywhere);
  }, [phase]);

  const activeArtifact = useMemo(
    () => conciseArtifact(query.trim() ? query.trim() : selected.artifact, 120),
    [query, selected],
  );

  const visibleEvidence = useMemo(
    () => (selected.evidence || []).filter(([, , , source]) => evidenceFilter === "ALL" || source === evidenceFilter),
    [evidenceFilter, selected],
  );
  const isClear = ["clear", "no_match", "not_scam"].includes(selected.verdict);
  const isLive = Boolean(selected.live);
  const isLiveNoMatch = isLive && (selected.resultStatus === "not_scam" || selected.verdict === "no_match");
  const isLiveNewCase = isLive && selected.resultStatus === "new_unmatched_case";

  function startDemoScan(item = selected, artifact) {
    const next = artifact ? { ...item, artifact } : item;
    checkRequestRef.current?.abort();
    setSelected(next);
    setQuery("");
    setScanStep(0);
    setScanMode("demo");
    setFileError("");
    setReportSent(false);
    setReportOpen(false);
    setBankOpen(false);
    setEvidenceFilter("ALL");
    setPhase("scanning");
  }

  async function runLiveEvidence(rawText = "", attachment = attachmentsRef.current[0] || null) {
    const cleanText = rawText.trim();
    const artifact = cleanText
      ? attachment ? `${conciseArtifact(cleanText, 74)} + ${attachment.file.name}` : cleanText
      : attachment?.file.name || "";
    if (!artifact) {
      setFileError("Enter text, a URL, or attach a screenshot or QR image.");
      return;
    }
    if (cleanText.length > 8000) {
      setFileError("Keep text evidence under 8,000 characters and try again.");
      return;
    }

    checkRequestRef.current?.abort();
    const controller = new AbortController();
    checkRequestRef.current = controller;
    if (cleanText) setQuery(cleanText);
    setSelected((current) => ({ ...current, artifact }));
    setFileError("");
    setScanStep(0);
    setScanMode("live");
    setReportSent(false);
    setReportOpen(false);
    setBankOpen(false);
    setEvidenceFilter("ALL");
    setPhase("scanning");

    const minimumDelay = new Promise((resolve) => window.setTimeout(resolve, LIVE_SCAN_MINIMUM_MS));
    try {
      const formData = new FormData();
      const defanged = cleanText.replace(/\[\.\]|\(\.\)|\{\.\}/gu, ".");
      const looksLikeUrl = /^(?:(?:https?|hxxps?):\/\/|www\.)\S+$/iu.test(defanged) ||
        /^(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:[/?#]|$)/u.test(defanged);
      if (cleanText) formData.set(looksLikeUrl ? "url" : "text", cleanText);
      if (attachment) formData.set("image", attachment.file, attachment.file.name);
      const responsePromise = fetch("/api/check", {
        method: "POST",
        body: formData,
        cache: "no-store",
        signal: controller.signal,
      });
      const [response] = await Promise.all([responsePromise, minimumDelay]);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || payload.status === "error") {
        const requestError = new Error(payload?.error?.message || "Live intelligence is temporarily unavailable.");
        requestError.code = payload?.error?.code || (response.status < 500 ? "INVALID_INPUT" : "CHECK_UNAVAILABLE");
        throw requestError;
      }
      if (checkRequestRef.current !== controller) return;
      setSelected(campaignCheckResultFromResponse(payload, artifact));
      releaseAttachments();
      setPhase("result");
    } catch (error) {
      if (error?.name === "AbortError" || checkRequestRef.current !== controller) return;
      setPhase("idle");
      setFileError(
        error?.message || "Live intelligence is temporarily unavailable. Please try again.",
      );
    } finally {
      if (checkRequestRef.current === controller) checkRequestRef.current = null;
    }
  }

  function runTextEvidence(rawText) {
    return runLiveEvidence(rawText, attachmentsRef.current[0] || null);
  }

  function submitInput(event) {
    event.preventDefault();
    void runLiveEvidence(query, attachments[0] || null);
  }

  function handleFiles(fileList) {
    const incomingFiles = Array.from(fileList || []);
    const allowedTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    const files = incomingFiles.filter((file) => allowedTypes.has(file.type.toLowerCase()));
    const rejectedCount = incomingFiles.length - files.length;
    const validFiles = files.filter((file) => file.size <= 8 * 1024 * 1024);
    const availableSlots = Math.max(0, 1 - attachmentsRef.current.length);
    const acceptedFiles = validFiles.slice(0, availableSlots);
    setFileError(
      rejectedCount
        ? "Use a PNG, JPEG, WebP, or GIF image."
        : validFiles.length < files.length
          ? "The image must be 8 MB or smaller."
          : validFiles.length > availableSlots
            ? "Upload one screenshot or QR image at a time."
          : "",
    );
    if (!acceptedFiles.length) return;

    setAttachments((current) => {
      const next = [
        ...current,
        ...acceptedFiles.map((file) => ({
          id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
          file,
          preview: URL.createObjectURL(file),
        })),
      ];
      attachmentsRef.current = next;
      return next;
    });
  }

  function removeAttachment(id) {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      const next = current.filter((attachment) => attachment.id !== id);
      attachmentsRef.current = next;
      return next;
    });
    setFileError("");
  }

  function releaseAttachments() {
    attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.preview));
    attachmentsRef.current = [];
    setAttachments([]);
    setFileError("");
  }

  function reset() {
    checkRequestRef.current?.abort();
    checkRequestRef.current = null;
    setPhase("idle");
    setQuery("");
    setReportOpen(false);
    setReportSent(false);
    setBankOpen(false);
    setEvidenceFilter("ALL");
    setFileError("");
    releaseAttachments();
  }

  return (
    <main className={`app-shell theme-${theme}`}>
      <div className="world-texture" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />

      <div className={`customer-actions customer-actions-${phase}`}>
        <button
          className="theme-toggle"
          type="button"
          aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          aria-pressed={theme === "dark"}
          onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
        >
          {theme === "light" ? <Moon size={13} weight="fill" /> : <Sun size={13} weight="fill" />}
          <span>{theme === "light" ? "DARK" : "LIGHT"}</span>
        </button>

        {phase === "idle" && (
          <a className="bank-entry-link" href="/bank">
            BANK OPERATIONS <ArrowUpRight size={14} weight="bold" />
          </a>
        )}
      </div>

      <AnimatePresence mode="wait">
        {phase === "idle" && (
          <motion.section
            className="landing"
            key="idle"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -18 }}
            transition={{ duration: 0.45 }}
          >
            <div className="wave-stage" aria-hidden="true">
              <Strands
                colors={["#3f96f3"]}
                count={5}
                speed={0.38}
                amplitude={1.28}
                waviness={0.9}
                thickness={0.68}
                glow={2.35}
                taper={1.35}
                spread={1.05}
                intensity={0.58}
                saturation={1.05}
                opacity={0.72}
                scale={1.28}
                reducedMotion={Boolean(reduceMotion)}
              />
            </div>
            <div className="hero-copy">
              <h1>CHECKVAR <span>2.0</span></h1>
              <p className="hero-subtitle">PROTECT EVERY TRANSFER.</p>
              <p className="hero-note">
                Check suspicious evidence before money moves.
              </p>
            </div>

            <form
              className={`scanner${isDragging ? " is-dragging" : ""}`}
              onSubmit={submitInput}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setIsDragging(false);
              }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                const files = event.dataTransfer.files;
                if (files?.length) {
                  handleFiles(files);
                  return;
                }
                const text = event.dataTransfer.getData("text/plain")?.trim();
                if (text) void runTextEvidence(text);
              }}
            >
              <div className={`scanner-field${attachments.length ? " has-attachments" : ""}`}>
                {isDragging && (
                  <div className="scanner-drop-prompt" aria-hidden="true">
                    DROP IMAGE TO ATTACH
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="attachment-tray" aria-label="Attached images">
                    {attachments.map((attachment) => (
                      <article className="attachment-card" key={attachment.id}>
                        <img src={attachment.preview} alt="" />
                        <button
                          type="button"
                          onClick={() => removeAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.file.name}`}
                        >
                          <X size={15} weight="bold" />
                        </button>
                        <span title={attachment.file.name}>{attachment.file.name}</span>
                      </article>
                    ))}
                  </div>
                )}
                <div className="scanner-controls">
                  <button
                    className="attach-button"
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    aria-label="Choose screenshots or QR codes"
                  >
                    <Plus size={22} weight="bold" />
                  </button>
                  <input
                    ref={fileRef}
                    className="file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    onChange={(event) => {
                      handleFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      if (fileError) setFileError("");
                    }}
                    placeholder="Paste a suspicious link, number, or message"
                    aria-label="Suspicious evidence"
                    aria-invalid={Boolean(fileError)}
                    aria-describedby={fileError ? "scanner-help check-error" : "scanner-help"}
                  />
                  <button className="scan-button" type="submit">
                    CHECK NOW
                    <ArrowRight size={18} weight="bold" />
                  </button>
                </div>
              </div>
              <p className="drop-helper" id="scanner-help">Live Luna analysis for text, links, screenshots, and QR images · 8 MB maximum</p>
              {fileError && <p className="file-error" id="check-error" role="alert">{fileError}</p>}
              <div className="demo-row">
                <span>TRY A DEMO</span>
                {CASES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => startDemoScan(item)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </form>

            <div className="landing-footer">
              <span>SOCIAL SIGNALS</span>
              <b>+</b>
              <span>COMMUNITY REPORTS</span>
              <i />
              <span>CAMPAIGN INTELLIGENCE</span>
            </div>
          </motion.section>
        )}

        {phase === "scanning" && (
          <motion.section
            className="scan-view"
            key="scanning"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.02 }}
          >
            <div className="scan-heading">
              <p className="eyebrow">{scanMode === "live" ? "LIVE INTELLIGENCE CHECK" : "PROTOTYPE DEMO"}</p>
              <p className="artifact-name">{activeArtifact}</p>
            </div>
            <div className="scan-stage">
              <div className="scan-orbit" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <div className="scan-card" role="status" aria-live="polite">
                <div className="scan-status-row">
                  <span className="scan-live-dot" aria-hidden="true" />
                  <span>{scanMode === "live" ? "CHECKING LIVE EVIDENCE" : "PROTOTYPE DEMO · ANALYZING EVIDENCE"}</span>
                  <strong>{SCAN_PROGRESS[scanStep]}%</strong>
                </div>

                <div className="scan-current">
                  <div>
                    <p>{SCAN_STEPS[scanStep]}</p>
                    <small>{SCAN_DETAILS[scanStep]}</small>
                  </div>
                </div>

                <div
                  className="scan-progress"
                  role="progressbar"
                  aria-label="Evidence check progress"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow={SCAN_PROGRESS[scanStep]}
                >
                  <motion.i
                    animate={{ width: `${SCAN_PROGRESS[scanStep]}%` }}
                    transition={{ duration: 0.45, ease: "easeOut" }}
                  />
                </div>
                <p className="scan-assurance">This check does not write your input to the evidence database.</p>
              </div>
            </div>
          </motion.section>
        )}

        {phase === "result" && (
          <motion.section
            className={`result-view${isClear ? " is-clear" : ""}`}
            key="result"
            ref={resultRef}
            tabIndex={-1}
            aria-labelledby="check-result-heading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <header className="result-nav">
              <button className="result-brand" onClick={reset}>CHECKVAR <span>2.0</span></button>
              <p>{isLive ? "LIVE EVIDENCE" : isClear ? "CHECK RESULT" : "CAMPAIGN MATCH"} <span>{selected.campaignId}</span></p>
              <button className="new-check" onClick={reset}>
                NEW CHECK <ArrowCounterClockwise size={15} weight="bold" />
              </button>
            </header>

            <section className="verdict-strip">
              <div className="compact-verdict">
                <p className="verdict-kicker">
                  {isLiveNoMatch
                    ? <WarningCircle size={17} weight="regular" />
                    : isClear
                      ? <ShieldCheck size={17} weight="fill" />
                      : <WarningCircle size={16} weight="fill" />}
                  {isLive
                    ? selected.resultKicker
                    : isClear ? "PROTOTYPE DEMO · NO KNOWN SIGNALS" : "PROTOTYPE DEMO · SCAM SIGNAL"}
                </p>
                <h2 id="check-result-heading">{isLive ? selected.resultHeading : isClear ? "Appears safe." : "Do not send the money."}</h2>
                <p>{selected.subline}</p>
              </div>

              <div className="compact-campaign">
                <div className="confidence-score">
                  <strong>{selected.confidence == null ? "—" : `${selected.confidence}%`}</strong>
                  <span>{isLive ? "ANALYSIS CONF." : "CONFIDENCE"}</span>
                </div>
                <div>
                  <span>{isLive ? selected.resultContextLabel : isClear ? "VERDICT CONFIDENCE" : "CAMPAIGN MATCH"}</span>
                  <strong>{selected.campaign}</strong>
                  <p>{selected.headline}</p>
                </div>
              </div>

              {isClear && (
                <div className="compact-actions">
                  <button className="primary-action" onClick={reset}>
                    CHECK ANOTHER TRANSFER <ArrowRight size={18} weight="bold" />
                  </button>
                  <button className="secondary-action" onClick={() => setBankOpen(true)}>
                    {isLive ? "HOW TO VERIFY SAFELY" : "CONTACT SHINHAN IF UNSURE"} <PhoneCall size={17} weight="bold" />
                  </button>
                </div>
              )}
              {!isClear && (
                <div className="compact-actions">
                  <button className="primary-action" onClick={() => isLive ? setBankOpen(true) : reset()}>
                    {isLive ? "HOW TO VERIFY SAFELY" : "CHECK SOMETHING ELSE"}
                    {isLive ? <PhoneCall size={17} weight="bold" /> : <ArrowRight size={18} weight="bold" />}
                  </button>
                  <button
                    className="secondary-action"
                    onClick={() => setReportOpen(true)}
                  >
                    PREVIEW ANONYMOUS REPORT <ArrowUpRight size={17} weight="bold" />
                  </button>
                </div>
              )}
            </section>

            <section className="impact-strip" aria-label={isLive ? "Live evidence summary" : "Campaign impact summary"}>
              {selected.impact
                ? selected.impact.map(([value, label]) => (
                  <div key={label}><strong>{value}</strong><span>{label}</span></div>
                ))
                : (
                  <>
                    <div><strong>{selected.reportCount}</strong><span>{isClear ? "RECORDED CASES" : "RELATED REPORTS"}</span></div>
                    <div><strong>{selected.victimCount}</strong><span>{isClear ? "LINKED VICTIMS" : "PAST VICTIMS"}</span></div>
                    <div><strong>{selected.reportedLoss}</strong><span>REPORTED LOSS</span></div>
                    <div><strong>{selected.sources.length}</strong><span>{isClear ? "SOURCE MATCHES" : "SOCIAL SOURCES"}</span></div>
                    <div><strong>{selected.firstSeen}</strong><span>{isClear ? "ACCOUNT HISTORY" : "FIRST SEEN"}</span></div>
                  </>
                )}
            </section>

            <section className="result-content">
              <section className="evidence-panel result-section">
                <div className="panel-title">
                  <span>{isLive
                    ? isLiveNoMatch ? "WHAT LUNA ANALYZED" : isLiveNewCase ? "WHY IT WAS FLAGGED" : "WHY IT MATCHED"
                    : isClear ? "WHAT WE CHECKED" : "WHY WE FLAGGED IT"}</span>
                  <strong>{visibleEvidence.length} {isClear ? "CHECKS" : "SIGNALS"} · {selected.match}</strong>
                </div>
                <div className="evidence-inputs" aria-label="Filter evidence by input type">
                  <button
                    className={evidenceFilter === "ALL" ? "active" : ""}
                    onClick={() => setEvidenceFilter("ALL")}
                    aria-pressed={evidenceFilter === "ALL"}
                  >
                    ALL <span>{selected.evidence.length}</span>
                  </button>
                  {selected.inputs.map(([type, label]) => (
                    <button
                      className={evidenceFilter === type ? "active" : ""}
                      key={`${type}-${label}`}
                      onClick={() => setEvidenceFilter(type)}
                      title={label}
                      aria-pressed={evidenceFilter === type}
                    >
                      {type} <span>{selected.evidence.filter(([, , , source]) => source === type).length}</span>
                    </button>
                  ))}
                </div>
                <div className="evidence-list">
                  {visibleEvidence.map(([kind, value, note, source, confidence], index) => (
                    <motion.div
                      className="evidence-row"
                      key={`${source}-${kind}-${value}-${index}`}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 + index * 0.12 }}
                    >
                      <span>0{index + 1}</span>
                      <p><em>{source}</em>{kind}</p>
                      <div className="evidence-value"><strong>{value}</strong><small>{note}</small></div>
                      <b>{confidence}</b>
                    </motion.div>
                  ))}
                </div>
                <p className="campaign-name">
                  {isLive
                    ? selected.analystConfirmed
                      ? "KNOWN CAMPAIGN"
                      : selected.hasCampaign
                        ? "POSSIBLE CAMPAIGN MATCH"
                        : isLiveNewCase ? "UNMATCHED CASE" : "RESULT"
                    : isClear ? "RESULT" : "KNOWN CAMPAIGN"} <span>{selected.campaign}</span>
                </p>
              </section>

              <section className="victim-panel result-section">
                <div className="panel-title">
                  <span>{isLive ? "PRIVACY & COVERAGE" : isClear ? "CASE HISTORY" : "PAST VICTIM REPORTS"}</span>
                  <strong>{isLive ? "NO CUSTOMER DATA" : `${selected.victimCount} ${isClear ? "RECORDED CASES" : "LINKED CASES"}`}</strong>
                </div>
                {isLive ? (
                  <div className="clear-empty">
                    {isLiveNoMatch
                      ? <WarningCircle size={28} weight="regular" />
                      : <ShieldCheck size={28} weight="fill" />}
                    <strong>{isLiveNoMatch
                      ? "No specific scam case was identified."
                      : isLiveNewCase ? "No existing campaign met the match threshold." : "No customer identities are shown."}</strong>
                    <p>{isLiveNoMatch
                      ? "If money or credentials are requested, still verify through an official channel."
                      : isLiveNewCase ? "The concrete case stays unmatched instead of being forced into a campaign." : "Only matched campaign evidence and public source documents are shown."}</p>
                  </div>
                ) : selected.victims.length ? (
                  <>
                    <div className="victim-list">
                      {selected.victims.map(([name, amount, story, meta]) => (
                        <article key={`${name}-${meta}`}>
                          <div className="victim-avatar">{name.split(" ")[1]}</div>
                          <div className="victim-story">
                            <span>{name} · IDENTITY HIDDEN</span>
                            <strong>{story}</strong>
                            <small>{meta}</small>
                          </div>
                          <em className={amount === "BLOCKED" ? "blocked" : ""}>{amount}</em>
                        </article>
                      ))}
                    </div>
                    <p className="privacy-caption">PERSONAL DETAILS REMOVED BEFORE CAMPAIGN MATCHING</p>
                  </>
                ) : (
                  <div className="clear-empty"><ShieldCheck size={28} weight="fill" /><strong>No cases recorded for this account.</strong><p>Checked against bank intelligence and anonymized customer reports.</p></div>
                )}
              </section>

              <section className="source-panel result-section">
                <div className="panel-title">
                  <span>{isLive
                    ? selected.hasCampaign ? "CAMPAIGN EVIDENCE" : isLiveNewCase ? "CAMPAIGN MATCHING" : "ANALYSIS RESULT"
                    : isClear ? "MONITORED SOURCES" : "SIMILAR REPORTS FOUND"}</span>
                  <strong>{isLive
                    ? selected.sources.length
                      ? `${selected.sources.length} SHOWN`
                      : selected.hasCampaign ? "NO PUBLIC LINKS SHOWN" : "NO CAMPAIGN EVIDENCE"
                    : isClear ? "NO MATCHES" : `${selected.reportCount} TOTAL SIGNALS`}</strong>
                </div>
                {selected.sources.length ? (
                  <div className="source-list">
                    {selected.sources.map(([platform, title, age, url]) => (
                      <a
                        className="source-link"
                        href={url || undefined}
                        key={`${platform}-${title}`}
                        target={url ? "_blank" : undefined}
                        rel={url ? "noreferrer" : undefined}
                        aria-disabled={url ? undefined : true}
                      >
                        <article>
                          <div className="source-icon"><Quotes size={16} weight="fill" /></div>
                          <div><span>{platform}</span><strong>{title}</strong></div>
                          <small>{age}</small>
                          <ArrowUpRight size={15} />
                        </article>
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="clear-empty compact">
                    {isLiveNoMatch ? <WarningCircle size={24} weight="regular" /> : <ShieldCheck size={24} weight="fill" />}
                    <strong>{isLive
                      ? selected.hasCampaign ? "Matched campaign evidence has no public link." : isLiveNewCase ? "No existing campaign was assigned." : "No campaign evidence was required."
                      : "No matching public evidence found."}</strong>
                    <p>{isLive
                      ? selected.hasCampaign
                        ? "The match still uses exact active campaign-indicator evidence."
                        : isLiveNewCase ? "This concrete case remains unclustered for analyst review." : "Luna classified this as general or non-specific content."
                        : "Nothing linked across monitored social sources."}</p>
                  </div>
                )}
                <p className="mock-disclaimer">{isLive ? "LUNA ANALYSIS · EXACT NORMALIZED INDICATOR MATCHING · NO EMBEDDINGS" : "DEMO DATA · SOCIAL LISTENING + ANONYMIZED CUSTOMER REPORTS"}</p>
              </section>
            </section>
          </motion.section>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {reportOpen && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setReportOpen(false);
            }}
          >
            <motion.section
              className="report-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Preview an anonymous report"
              initial={{ y: 32, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 32, opacity: 0 }}
            >
              <button className="close-modal" aria-label="Close report" onClick={() => setReportOpen(false)}>
                <X size={18} />
              </button>
              {reportSent ? (
                <div className="report-success">
                  <ShieldCheck size={40} weight="fill" />
                  <p className="eyebrow">REPORT PREVIEW PREPARED</p>
                  <h3>The anonymous handoff is ready to review.</h3>
                  <p>No report was sent outside this prototype.</p>
                  <button onClick={reset}>CHECK SOMETHING ELSE</button>
                </div>
              ) : (
                <>
                  <p className="eyebrow">{isLive ? "ANONYMOUS REPORT PREVIEW / 01" : "DEMO PRIVACY PREVIEW / 01"}</p>
                  <h3>Preview signals without personal identity.</h3>
                  <div className="redaction-preview">
                    <div><span>YOUR NAME</span><strong>[ REDACTED ]</strong></div>
                    <div><span>YOUR NUMBER</span><strong>[ REDACTED ]</strong></div>
                    <div><span>SCAM SIGNALS</span><strong>{selected.evidence.length} SIGNALS</strong></div>
                    <div><span>CAMPAIGN</span><strong>{selected.campaignId}</strong></div>
                  </div>
                  <p className="privacy-note">Prototype only: this shows the minimum evidence a future bank handoff could contain.</p>
                  <button className="send-report" onClick={() => setReportSent(true)}>
                    SIMULATE ANONYMOUS REPORT
                    <ArrowUpRight size={18} weight="bold" />
                  </button>
                  <button className="cancel-report" onClick={() => setReportOpen(false)}>
                    Don't send
                  </button>
                </>
              )}
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {bankOpen && (
          <motion.div className="bank-toast" initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }}>
            <span>{isLive ? "OFFICIAL CHANNELS ONLY" : "OFFICIAL CHANNEL · VERIFIED"}</span>
            <strong>{isLive ? "CONTACT YOUR BANK" : "1900 54 54 13"}</strong>
            <p>{isLive ? "Use the number in your bank app, on its website, or on the back of your card." : "Never call back the number that contacted you."}</p>
            <button onClick={() => setBankOpen(false)}><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
