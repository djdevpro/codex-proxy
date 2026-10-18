import type { CodexModel, ReasoningEffort } from "./models";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface Message {
  role: "developer" | "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface CompletionRequest {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  prompt?: string;
  response_format?: unknown;
  reasoning_effort?: unknown;
  tools?: unknown;
}

export interface CodexInput {
  prompt: string;
  images: string[];
  model: CodexModel;
  reasoningEffort?: ReasoningEffort;
  developerInstructions?: string;
  outputSchema?: Record<string, unknown>;
  jsonObject?: boolean;
  signal?: AbortSignal;
  webSearch?: boolean;
}

export interface GeneratedArtifact {
  type: "image";
  path: string;
  filename: string;
  mediaType: string;
}

export interface CodexResult {
  content: string;
  artifacts: GeneratedArtifact[];
  sources?: WebSource[];
}

export interface WebSource { url: string; title: string }

export type OutputHandler = (chunk: string) => void;
export type CodexProgressPhase = "starting" | "thinking" | "answering";
export type ProgressHandler = (phase: CodexProgressPhase) => void;
export type CodexRunner = (input: CodexInput, onOutput?: OutputHandler, onProgress?: ProgressHandler, onSummary?: OutputHandler, onCommentary?: OutputHandler) => Promise<string | CodexResult>;
