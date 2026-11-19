export interface Finding {
  file: string;
  line: number;
  rule: string;
}
export function scanText(text: string, file?: string): Finding[];
export function listFiles(staged: boolean): string[];
export function scanFiles(files: string[], read?: (f: string) => string): Finding[];
