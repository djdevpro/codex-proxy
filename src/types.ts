import type { CodexModel } from "./models";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface CompletionRequest {
  model?: string;
  stream?: boolean;
  messages?: Message[];
  prompt?: string;
}

export interface CodexInput {
  prompt: string;
  images: string[];
  model: CodexModel;
}

export type OutputHandler = (chunk: string) => void;
export type CodexRunner = (input: CodexInput, onOutput?: OutputHandler) => Promise<string>;
