import BookModel from "../../../models/Book";

export interface LegalNormSummary {
  verified: any[];
  failed: any[];
  pkulawError: string | null;
}

export interface LegalExtraction {
  core_claim: string;
  norms: any[];
  doctrines: string[];
}

export interface PopupLegalProps {
  currentBook: BookModel;
  htmlBook: any;
  quoteText: string;
  isDockedRight: boolean;
  handleQuoteText: (quoteText: string) => void;
  handleOpenMenu: (isOpenMenu: boolean) => void;
  handleMenuMode: (menu: string) => void;
  t: (title: string) => string;
}

export interface PopupLegalState {
  status: "idle" | "running" | "done" | "error";
  stage: number;
  stageLabel: string;
  extraction: LegalExtraction | null;
  normSummary: LegalNormSummary | null;
  markdown: string;
  errorMessage: string;
}
