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

type BaseQuestionDef = {
  id: string;
  title: string;
  description?: string;
  required?: boolean;
};

export type FormQuestionDef =
  | (BaseQuestionDef & {
      type: "single_choice";
      options: FormOptionDef[];
      allowCustom?: boolean;
      default?: string;
    })
  | (BaseQuestionDef & {
      type: "multi_choice";
      options: FormOptionDef[];
      allowCustom?: boolean;
      default?: string[];
      minItems?: number;
      maxItems?: number;
    })
  | (BaseQuestionDef & {
      type: "text" | "textarea";
      inputType?: "text" | "email" | "url" | "date" | "datetime-local";
      default?: string;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    })
  | (BaseQuestionDef & {
      type: "number";
      integer?: boolean;
      default?: number;
      minimum?: number;
      maximum?: number;
    })
  | (BaseQuestionDef & { type: "rating" })
  | (BaseQuestionDef & { type: "boolean"; default?: boolean });

export interface AskFormDefinition {
  title: string;
  description?: string;
  questions: FormQuestionDef[];
}

export type SurveyAnswerValue = string | number | boolean | string[];
export type SurveyAnswers = Record<string, SurveyAnswerValue>;

export interface AcpElicitationRequest {
  mode: "form" | "url" | string;
  message: string;
  requestedSchema?: {
    title?: string;
    description?: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  elicitationId?: string;
  url?: string;
  sessionId?: string;
  toolCallId?: string;
  requestId?: string | number;
}

export interface AcpElicitationSnapshot {
  request_id: string;
  agent_name: string;
  request: AcpElicitationRequest;
  opened?: boolean;
}

function optionList(value: unknown, titledKey: "oneOf" | "anyOf"): FormOptionDef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ id: entry, label: entry }];
    if (!entry || typeof entry !== "object") return [];
    const option = entry as Record<string, unknown>;
    const id = typeof option.const === "string" ? option.const : "";
    if (!id || titledKey === "oneOf" && !("const" in option)) return [];
    return [{
      id,
      label: typeof option.title === "string" ? option.title : id,
      description: typeof option.description === "string" ? option.description : undefined,
    }];
  });
}

function dateTimeLocalDefault(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function elicitationToSurvey(snapshot: AcpElicitationSnapshot): AskFormDefinition | null {
  const schema = snapshot.request.requestedSchema;
  if (snapshot.request.mode !== "form" || !schema) return null;
  const required = new Set(schema.required ?? []);
  const questions: FormQuestionDef[] = [];
  for (const [id, raw] of Object.entries(schema.properties ?? {})) {
    const title = typeof raw.title === "string" ? raw.title : id;
    const description = typeof raw.description === "string" ? raw.description : undefined;
    const base = { id, title, description, required: required.has(id) };
    switch (raw.type) {
      case "string": {
        const plain = optionList(raw.enum, "oneOf");
        const titled = optionList(raw.oneOf, "oneOf");
        const options = titled.length > 0 ? titled : plain;
        if (options.length > 0) {
          questions.push({
            ...base,
            type: "single_choice",
            options,
            allowCustom: false,
            default: typeof raw.default === "string" ? raw.default : undefined,
          });
        } else {
          const format = raw.format;
          const inputType = format === "email" ? "email"
            : format === "uri" ? "url"
              : format === "date" ? "date"
                : format === "date-time" ? "datetime-local"
                  : "text";
          questions.push({
            ...base,
            type: "text",
            inputType,
            default: inputType === "datetime-local"
              ? dateTimeLocalDefault(raw.default)
              : typeof raw.default === "string" ? raw.default : undefined,
            minLength: typeof raw.minLength === "number" ? raw.minLength : undefined,
            maxLength: typeof raw.maxLength === "number" ? raw.maxLength : undefined,
            pattern: typeof raw.pattern === "string" ? raw.pattern : undefined,
          });
        }
        break;
      }
      case "number":
      case "integer":
        questions.push({
          ...base,
          type: "number",
          integer: raw.type === "integer",
          default: typeof raw.default === "number" ? raw.default : undefined,
          minimum: typeof raw.minimum === "number" ? raw.minimum : undefined,
          maximum: typeof raw.maximum === "number" ? raw.maximum : undefined,
        });
        break;
      case "boolean":
        questions.push({
          ...base,
          type: "boolean",
          default: typeof raw.default === "boolean" ? raw.default : undefined,
        });
        break;
      case "array": {
        const items = raw.items && typeof raw.items === "object"
          ? raw.items as Record<string, unknown>
          : {};
        const plain = optionList(items.enum, "anyOf");
        const titled = optionList(items.anyOf, "anyOf");
        questions.push({
          ...base,
          type: "multi_choice",
          options: titled.length > 0 ? titled : plain,
          allowCustom: false,
          default: Array.isArray(raw.default)
            ? raw.default.filter((item): item is string => typeof item === "string")
            : undefined,
          minItems: typeof raw.minItems === "number" ? raw.minItems : undefined,
          maxItems: typeof raw.maxItems === "number" ? raw.maxItems : undefined,
        });
        break;
      }
      default:
        return null;
    }
  }
  return {
    title: schema.title || "Information requested",
    description: schema.description,
    questions,
  };
}
