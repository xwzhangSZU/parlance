export interface PhraseHit {
  key: string;
  chunk_idx: number;
  distance: number;
  snippet: string;
  title: string | null;
  creators: string[];
  date: string | null;
  venue: string | null;
  doi: string | null;
}

export interface ParlanceConfig {
  zsearchPath: string;
  topK: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;
