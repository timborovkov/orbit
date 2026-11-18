import type { FileUIPart } from 'ai';

export interface PromptInputMessage {
  text: string;
  files: FileUIPart[];
}
