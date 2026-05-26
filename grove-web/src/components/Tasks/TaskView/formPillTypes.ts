/**
 * Types and detection helpers for the `ask_form` MCP tool. Kept in a separate
 * non-component file so React Fast Refresh stays happy (it requires component
 * files to only export components).
 */

export interface FormOptionDef {
  id: string;
  label: string;
  description?: string;
}

export type FormQuestionDef =
  | {
      type: "single_choice";
      id: string;
      title: string;
      description?: string;
      options: FormOptionDef[];
    }
  | {
      type: "multi_choice";
      id: string;
      title: string;
      description?: string;
      options: FormOptionDef[];
    }
  | { type: "text"; id: string; title: string; description?: string }
  | { type: "textarea"; id: string; title: string; description?: string }
  | { type: "number"; id: string; title: string; description?: string }
  | { type: "rating"; id: string; title: string; description?: string }
  | { type: "boolean"; id: string; title: string; description?: string };

export interface AskFormDefinition {
  title: string;
  description?: string;
  questions: FormQuestionDef[];
}

