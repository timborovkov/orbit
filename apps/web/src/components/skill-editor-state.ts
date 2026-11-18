export interface SkillEditorState {
  skillId?: string;
  name: string;
  title: string;
  description: string;
  body: string;
  slugManual: boolean;
  error?: string;
}

export function emptySkillEditor(): SkillEditorState {
  return {
    name: '',
    title: '',
    description: '',
    body: '',
    slugManual: false,
  };
}
