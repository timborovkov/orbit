export interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

export interface McpEditorState {
  connectionId?: string;
  name: string;
  url: string;
  transport: 'http' | 'sse';
  tools: string[];
  headers: HeaderRow[];
  clearHeaders: boolean;
  hasHeaders: boolean;
  discovered: string[];
  discoverError?: string;
  error?: string;
}

export function newHeaderRow(): HeaderRow {
  return { id: crypto.randomUUID(), key: '', value: '' };
}

export function emptyMcpEditor(): McpEditorState {
  return {
    name: '',
    url: '',
    transport: 'http',
    tools: [],
    headers: [newHeaderRow()],
    clearHeaders: false,
    hasHeaders: false,
    discovered: [],
  };
}
