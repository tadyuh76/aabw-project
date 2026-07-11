export type CheckStatus =
  | "matched_campaign"
  | "possible_match"
  | "new_unmatched_case"
  | "not_scam";

export type PrimaryCategory =
  | "scam_report"
  | "impersonation_abuse"
  | "customer_feedback"
  | "news_pr"
  | "noise";

export interface AnalyzedIndicator {
  type: string;
  value: string;
  normalizedValue: string;
  evidenceSource: string;
  matchEligible: boolean;
}

export interface CheckAnalysis {
  primaryCategory: PrimaryCategory;
  specificCase: boolean;
  summary: string;
  severity: 1 | 2 | 3 | 4 | 5;
  confidence: number;
  scamTypes: string[];
  bankRoles: string[];
  indicators: AnalyzedIndicator[];
}

export interface MatchedIndicatorReason {
  indicatorType: string;
  normalizedValue: string;
  role: "anchor" | "shared" | "supporting" | "context";
  weight: number;
  scoreContribution: number;
  reason: string;
  reasons: unknown[];
}

export interface MatchedCampaign {
  id: string;
  campaignKey: string;
  label: string;
  status: "provisional" | "confirmed";
  analystConfirmed: boolean;
  matchScore: number;
  matchedReasons: MatchedIndicatorReason[];
  documentCount: number;
  indicatorCount: number;
  riskScore: number;
  maximumSeverity: number;
  averageConfidence: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface CampaignEvidenceDocument {
  documentId: string;
  title: string;
  url: string | null;
  membershipScore: number;
  reasons: unknown[];
}

export interface CheckResponse {
  status: CheckStatus;
  analysis: CheckAnalysis;
  campaign: MatchedCampaign | null;
  evidence: CampaignEvidenceDocument[];
  recommendedActions: string[];
}

export interface CheckErrorResponse {
  status: "error";
  error: {
    code: string;
    message: string;
  };
}
