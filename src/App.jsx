"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { SignalWave } from "./SignalWave.jsx";
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowUpRight,
  Check,
  LinkSimple,
  PhoneCall,
  ShieldCheck,
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
    headline: "Same campaign. New identity.",
    subline: "The phone number changed. The script and infrastructure did not.",
    evidence: [
      ["PHRASE", "“verify before 11 PM”", "seen 41 times"],
      ["DESTINATION", "vneid-ho-tro[.]live → APK", "17 reports"],
      ["PAYEE", "MB •••• 8086", "linked to 6 cases"],
    ],
  },
  {
    id: "refund-relay",
    label: "Refund QR",
    artifact: "refund_qr_1907.png",
    campaign: "REFUND RELAY",
    campaignId: "CP-2407-08C",
    match: "VERY HIGH",
    headline: "New QR. Same money trail.",
    subline: "This QR routes to an intermediary account seen in 9 reports.",
    evidence: [
      ["QR PAYLOAD", "vietqr.io/9704/•••921", "created 2 hours ago"],
      ["SCRIPT", "“refund fee in 5 minutes”", "94% similarity"],
      ["MONEY FLOW", "3 intermediary accounts", "same beneficiary"],
    ],
  },
  {
    id: "remote-task",
    label: "Job offer URL",
    artifact: "vieclam-linhhoat[.]site",
    campaign: "REMOTE TASK FARM",
    campaignId: "CP-2406-31F",
    match: "HIGH",
    headline: "New domain. Same task scam.",
    subline: "The site reuses the same copy, tracking code, and payee cluster.",
    evidence: [
      ["DOMAIN", "registered 11 hours ago", "owner identity hidden"],
      ["CONTENT", "“deposit to unlock tasks”", "29 variants"],
      ["TRACKING", "Meta Pixel •••8472", "used across 8 domains"],
    ],
  },
];

const SCAN_STEPS = ["Extract signals", "Match campaigns", "Verify evidence"];

export function App() {
  const [phase, setPhase] = useState("idle");
  const [selected, setSelected] = useState(CASES[0]);
  const [scanStep, setScanStep] = useState(0);
  const [query, setQuery] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportSent, setReportSent] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const reduceMotion = useReducedMotion();
  const fileRef = useRef(null);

  useEffect(() => {
    if (phase !== "scanning") return;
    const stepOne = window.setTimeout(() => setScanStep(1), 620);
    const stepTwo = window.setTimeout(() => setScanStep(2), 1260);
    const complete = window.setTimeout(() => setPhase("result"), 2050);
    return () => [stepOne, stepTwo, complete].forEach(window.clearTimeout);
  }, [phase]);

  useEffect(() => {
    if (phase !== "idle") return;

    function pasteAnywhere(event) {
      if (document.activeElement?.tagName === "INPUT") return;
      const file = event.clipboardData?.files?.[0];
      if (file) {
        handleFile(file);
        return;
      }
      const text = event.clipboardData?.getData("text/plain")?.trim();
      if (text) runTextEvidence(text);
    }

    window.addEventListener("paste", pasteAnywhere);
    return () => window.removeEventListener("paste", pasteAnywhere);
  }, [phase]);

  const activeArtifact = useMemo(
    () => (query.trim() ? query.trim() : selected.artifact),
    [query, selected],
  );

  function startScan(item = selected, artifact) {
    const next = artifact ? { ...item, artifact } : item;
    setSelected(next);
    setScanStep(0);
    setReportSent(false);
    setReportOpen(false);
    setBankOpen(false);
    setPhase("scanning");
  }

  function runTextEvidence(rawText) {
    const artifact = rawText.trim();
    const normalized = artifact.toLowerCase();
    const picked = normalized.includes("qr")
      ? CASES[1]
      : normalized.includes("viec") || normalized.includes("job")
        ? CASES[2]
        : CASES[0];
    setQuery(artifact);
    startScan(picked, artifact || picked.artifact);
  }

  function submitInput(event) {
    event.preventDefault();
    runTextEvidence(query || selected.artifact);
  }

  function handleFile(file) {
    if (!file) return;
    setQuery(file.name);
    startScan(CASES[0], file.name);
  }

  function reset() {
    setPhase("idle");
    setQuery("");
    setReportOpen(false);
    setReportSent(false);
    setBankOpen(false);
  }

  return (
    <main className="app-shell">
      <div className="world-texture" aria-hidden="true" />
      <div className="noise" aria-hidden="true" />

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
              <SignalWave reducedMotion={Boolean(reduceMotion)} />
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
                const file = event.dataTransfer.files?.[0];
                if (file) {
                  handleFile(file);
                  return;
                }
                const text = event.dataTransfer.getData("text/plain")?.trim();
                if (text) runTextEvidence(text);
              }}
            >
              <div className="scanner-field">
                <button
                  className="attach-button"
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  aria-label="Choose a screenshot or QR code"
                >
                  <LinkSimple size={21} weight="bold" />
                </button>
                <input
                  ref={fileRef}
                  className="file-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => handleFile(event.target.files?.[0])}
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Paste a suspicious link, number, or message"
                  aria-label="Suspicious evidence"
                />
                <button className="scan-button" type="submit">
                  CHECK NOW
                  <ArrowRight size={18} weight="bold" />
                </button>
              </div>
              <p className="drop-helper">Drop a screenshot, QR, or file · ⌘V anywhere</p>
              <div className="demo-row">
                <span>TRY A DEMO</span>
                {CASES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => startScan(item)}
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
              <p className="eyebrow">LIVE ANALYSIS / {String(scanStep + 1).padStart(2, "0")}</p>
              <p className="artifact-name">{activeArtifact}</p>
            </div>
            <div className="scan-stage">
              <motion.div
                className="scan-sweep"
                initial={{ top: "7%" }}
                animate={{ top: "88%" }}
                transition={{ duration: 1.55, repeat: Infinity, ease: "linear" }}
              />
              <motion.div
                className="scan-readout"
                animate={{ opacity: [0.45, 1, 0.45] }}
                transition={{ duration: 1.2, repeat: Infinity }}
              >
                {String(37 + scanStep * 29).padStart(2, "0")}%
              </motion.div>
            </div>
            <div className="scan-steps">
              {SCAN_STEPS.map((step, index) => (
                <div className={index <= scanStep ? "active" : ""} key={step}>
                  <span>0{index + 1}</span>
                  <p>{step}</p>
                  {index < scanStep ? <Check size={15} weight="bold" /> : <i />}
                </div>
              ))}
            </div>
          </motion.section>
        )}

        {phase === "result" && (
          <motion.section
            className="result-view"
            key="result"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="result-intro">
              <p className="eyebrow">CAMPAIGN MATCH / {selected.campaignId}</p>
              <div className="verdict-line">
                <motion.span
                  initial={{ width: 0 }}
                  animate={{ width: "clamp(80px, 10vw, 150px)" }}
                  transition={{ delay: 0.2, duration: 0.55 }}
                />
                <h2>STOP</h2>
              </div>
              <h3>{selected.headline}</h3>
              <p>{selected.subline}</p>
            </div>

            <div className="result-grid">
              <section className="evidence-panel">
                <div className="panel-title">
                  <span>EVIDENCE TRACE</span>
                  <strong>MATCH LEVEL: {selected.match}</strong>
                </div>
                <div className="evidence-list">
                  {selected.evidence.map(([kind, value, note], index) => (
                    <motion.div
                      className="evidence-row"
                      key={kind}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 + index * 0.12 }}
                    >
                      <span>0{index + 1}</span>
                      <p>{kind}</p>
                      <strong>{value}</strong>
                      <small>{note}</small>
                    </motion.div>
                  ))}
                </div>
                <p className="campaign-name">
                  KNOWN CAMPAIGN <span>{selected.campaign}</span>
                </p>
              </section>

              <aside className="action-panel">
                <WarningCircle size={27} weight="fill" />
                <p className="action-kicker">DO THIS NOW</p>
                <h4>Do not transfer. Do not install anything.</h4>
                <button className="primary-action" onClick={() => setBankOpen(true)}>
                  STOP — OPEN OFFICIAL CHANNEL
                  <PhoneCall size={18} weight="bold" />
                </button>
                <button className="secondary-action" onClick={() => setReportOpen(true)}>
                  SEND ANONYMOUS REPORT
                  <ArrowUpRight size={17} weight="bold" />
                </button>
                <button className="reset-button" onClick={reset}>
                  <ArrowCounterClockwise size={16} />
                  Check something else
                </button>
              </aside>
            </div>
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
              aria-label="Send an anonymous report"
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
                  <p className="eyebrow">SIGNAL #12,843 ADDED</p>
                  <h3>You just made this campaign harder to hide.</h3>
                  <p>Your report was shared with the bank without your identity.</p>
                  <button onClick={reset}>CHECK SOMETHING ELSE</button>
                </div>
              ) : (
                <>
                  <p className="eyebrow">PRIVACY PREVIEW / 01</p>
                  <h3>Share signals. Not your identity.</h3>
                  <div className="redaction-preview">
                    <div><span>YOUR NAME</span><strong>[ REDACTED ]</strong></div>
                    <div><span>YOUR NUMBER</span><strong>[ REDACTED ]</strong></div>
                    <div><span>SCAM SIGNALS</span><strong>3 SIGNALS</strong></div>
                    <div><span>CAMPAIGN</span><strong>{selected.campaignId}</strong></div>
                  </div>
                  <p className="privacy-note">The bank receives only what it needs to investigate and take down the campaign.</p>
                  <button className="send-report" onClick={() => setReportSent(true)}>
                    AGREE & SEND REPORT
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
            <span>OFFICIAL CHANNEL · VERIFIED</span>
            <strong>1900 54 54 13</strong>
            <p>Never call back the number that contacted you.</p>
            <button onClick={() => setBankOpen(false)}><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
